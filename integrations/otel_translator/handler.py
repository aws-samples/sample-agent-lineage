"""Lambda: translate OTel GenAI spans into Agent Lineage run events.

Deploy behind either:
- a CloudWatch Logs subscription filter on the AgentCore Observability log group, or
- an OTel Collector exporting OTLP/JSON to a Lambda function URL.

Span mapping (OpenTelemetry GenAI semantic conventions):
  gen_ai.operation.name == "invoke_agent"  -> START (span start) + COMPLETE/FAIL (span end)
  span kind TOOL / gen_ai tool attributes  -> ACCESS with tools/gatewayCalls
  gen_ai.operation.name == "chat"          -> ACCESS with llms + token usage
  guardrail trace attributes               -> ACCESS with guardrailEvents

Environment:
  LINEAGE_API   e.g. https://lineage.internal.example.com  (required)
  NAMESPACE     e.g. 123456789012/us-east-1                (required)
  INGEST_KEY    deployment's IngestApiKey stack parameter  (required when deployed)
"""
import base64
import gzip
import json
import os
import urllib.request

LINEAGE_API = os.environ.get("LINEAGE_API", "http://localhost:8000")
NAMESPACE = os.environ.get("NAMESPACE", "default")
# Service credential (deployment's IngestApiKey stack parameter). Required in
# deployed environments; the API rejects unauthenticated ingestion.
INGEST_KEY = os.environ.get("INGEST_KEY", "")


def post_event(event: dict) -> None:
    headers = {"Content-Type": "application/json"}
    if INGEST_KEY:
        headers["X-Ingest-Key"] = INGEST_KEY
    req = urllib.request.Request(
        f"{LINEAGE_API}/api/v1/lineage/events",
        data=json.dumps(event).encode(),
        headers=headers,
    )
    urllib.request.urlopen(req, timeout=10)


def ref(node_type: str, name: str, **facets) -> dict:
    return {"node_type": node_type, "name": name, "namespace": NAMESPACE, "facets": facets}


def span_to_events(span: dict) -> list[dict]:
    """Map one GenAI span to zero or more AgentRunEvents."""
    attrs = span.get("attributes", {})
    op = attrs.get("gen_ai.operation.name", "")
    agent_name = attrs.get("gen_ai.agent.name") or span.get("resource", {}).get(
        "service.name", "unknown-agent"
    )
    run_id = attrs.get("gen_ai.conversation.id") or span.get("traceId", "")
    agent = ref("agent", agent_name)
    events: list[dict] = []

    if op == "invoke_agent":
        events.append({
            "eventType": "START", "eventTime": span.get("startTime"),
            "runId": run_id, "producer": "otel-translator", "agent": agent,
        })
        ended_ok = span.get("status", {}).get("code") != "ERROR"
        events.append({
            "eventType": "COMPLETE" if ended_ok else "FAIL",
            "eventTime": span.get("endTime"),
            "runId": run_id, "producer": "otel-translator", "agent": agent,
        })
    elif op in ("chat", "text_completion", "generate_content"):
        events.append({
            "eventType": "ACCESS", "eventTime": span.get("endTime"),
            "runId": run_id, "producer": "otel-translator", "agent": agent,
            "llms": [{
                "node_type": "llm", "namespace": NAMESPACE,
                "name": attrs.get("gen_ai.request.model", "unknown-model"),
                "inputTokens": int(attrs.get("gen_ai.usage.input_tokens", 0)),
                "outputTokens": int(attrs.get("gen_ai.usage.output_tokens", 0)),
            }],
        })
    elif op == "execute_tool" or attrs.get("gen_ai.tool.name"):
        events.append({
            "eventType": "ACCESS", "eventTime": span.get("endTime"),
            "runId": run_id, "producer": "otel-translator", "agent": agent,
            "tools": [ref("tool", attrs.get("gen_ai.tool.name", "unknown-tool"))],
        })
    return events


def lambda_handler(event, _context):
    # CloudWatch Logs subscription payload: gzip+base64 log events, one span JSON per line.
    payload = json.loads(
        gzip.decompress(base64.b64decode(event["awslogs"]["data"]))
    )
    sent = 0
    for log_event in payload.get("logEvents", []):
        try:
            span = json.loads(log_event["message"])
        except json.JSONDecodeError:
            continue
        for lineage_event in span_to_events(span):
            post_event(lineage_event)
            sent += 1
    return {"events_sent": sent}
