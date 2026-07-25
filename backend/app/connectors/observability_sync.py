"""Poll AgentCore Observability spans from CloudWatch and ingest runs.

Reads OTel GenAI spans from the 'aws/spans' log group (populated when CloudWatch
Transaction Search is enabled — AgentCore Observability sends spans there) and
translates them into lineage run events: runs, LLM calls with token usage, and
tool calls. This is the polling twin of integrations/otel_translator (which does
the same via a Logs subscription in production).

Best-effort parser: span JSON layouts vary, so attribute lookup checks nested
and flattened forms. Scans the last 24h, capped at 5000 events per sync.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import boto3
from sqlalchemy.orm import Session

from ..ingest import ingest_event
from ..schemas import AgentRunEvent, EntityRef, GuardrailEvent, LLMUsageRef

import os

LOG_GROUP = os.environ.get("AGENT_LINEAGE_SPANS_LOG_GROUP", "aws/spans")
MAX_EVENTS = 5000
WINDOW_HOURS = int(os.environ.get("AGENT_LINEAGE_SPANS_WINDOW_HOURS", "720"))  # 30 days


def _attr(span: dict, key: str) -> Any:
    """Look up an attribute across common span JSON layouts."""
    attrs = span.get("attributes") or {}
    if isinstance(attrs, dict) and key in attrs:
        return attrs[key]
    if key in span:
        return span[key]
    res_attrs = ((span.get("resource") or {}).get("attributes")) or {}
    if isinstance(res_attrs, dict) and key in res_attrs:
        return res_attrs[key]
    return None


def _parse_time(span: dict, keys: tuple) -> datetime | None:
    for key in keys:
        v = span.get(key)
        if not v:
            continue
        if key.endswith("UnixNano"):
            return datetime.fromtimestamp(int(v) / 1e9, tz=timezone.utc)
        if isinstance(v, (int, float)):  # epoch ms
            return datetime.fromtimestamp(v / 1000, tz=timezone.utc)
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                continue
    return None


def _span_times(span: dict) -> tuple[datetime, datetime]:
    """Distinct start and end times — run duration depends on them differing."""
    start = _parse_time(span, ("startTimeUnixNano", "startTime"))
    end = _parse_time(span, ("endTimeUnixNano", "endTime", "@timestamp", "timestamp"))
    if start is None and end is None:
        now = datetime.now(timezone.utc)
        return now, now
    return start or end, end or start  # type: ignore[return-value]


def _time(span: dict) -> datetime:
    return _span_times(span)[1]


def _span_failed(span: dict) -> bool:
    return str((span.get("status") or {}).get("code", "")).upper() in ("ERROR", "STATUS_CODE_ERROR", "2")


def _extract_error(span: dict, where: str) -> Optional[dict]:
    """Failure details from span status + OTel exception events."""
    if not _span_failed(span):
        return None
    error: dict = {"where": where}
    status_msg = (span.get("status") or {}).get("message")
    if status_msg:
        error["message"] = str(status_msg)[:500]
    for ev in span.get("events") or []:
        if not isinstance(ev, dict) or ev.get("name") != "exception":
            continue
        attrs = ev.get("attributes") or {}
        if attrs.get("exception.type"):
            error["type"] = str(attrs["exception.type"])[:200]
        if attrs.get("exception.message"):
            error["message"] = str(attrs["exception.message"])[:500]
        if attrs.get("exception.stacktrace"):
            error["stacktrace"] = str(attrs["exception.stacktrace"])[:2000]
        break  # first exception event is the root failure
    return error


def _agent_name(span: dict) -> str:
    # Prefer the deployed runtime name (service.name) over the framework's
    # generic agent name (e.g. "Strands Agents"), so spans attach to the same
    # node the control-plane sync created.
    name = str(
        _attr(span, "service.name")
        or span.get("serviceName")
        or _attr(span, "gen_ai.agent.name")
        or "unknown-agent"
    )
    # Strip the runtime endpoint qualifier ("my-agent.DEFAULT" -> "my-agent").
    if name.endswith(".DEFAULT"):
        name = name[: -len(".DEFAULT")]
    return name


def _span_to_events(span: dict, namespace: str) -> list[AgentRunEvent]:
    op = str(_attr(span, "gen_ai.operation.name") or "")
    tool_name = _attr(span, "gen_ai.tool.name")
    model = _attr(span, "gen_ai.request.model") or _attr(span, "gen_ai.response.model")
    if not op and not tool_name and not model:
        return []  # not a GenAI span

    run_id = str(
        _attr(span, "gen_ai.conversation.id")
        or _attr(span, "session.id")
        or span.get("traceId")
        or ""
    )
    if not run_id:
        return []
    ts = _time(span)
    agent = EntityRef(node_type="agent", name=_agent_name(span), namespace=namespace)
    events: list[AgentRunEvent] = []

    if op in ("invoke_agent", "create_agent"):
        # START at span start, COMPLETE at span end — distinct timestamps are
        # what give the run a real duration.
        start_ts, end_ts = _span_times(span)
        # Agent version, when the instrumentation reports it.
        version = _attr(span, "service.version") or _attr(span, "gen_ai.agent.version")
        # Observed invoker, when the span carries end-user / client claims.
        caller = (
            _attr(span, "enduser.id")
            or _attr(span, "user.id")
            or _attr(span, "gen_ai.request.client_id")
        )
        events.append(AgentRunEvent(
            eventType="START", eventTime=start_ts, runId=run_id,
            producer="cloudwatch-spans-poller", agent=agent,
            runFacets={"agent_version": str(version)} if version else {},
            onBehalfOf=(
                EntityRef(node_type="user_group", name=str(caller), namespace=namespace,
                          facets={"kind": "observed caller (span claims)"})
                if caller
                else None
            ),
        ))
        failed = _span_failed(span)
        events.append(AgentRunEvent(
            eventType="FAIL" if failed else "COMPLETE", eventTime=end_ts,
            runId=run_id, producer="cloudwatch-spans-poller", agent=agent,
            error=_extract_error(span, "agent"),
        ))
    elif model:
        # Guardrail applied to this model call, if the span records it.
        guardrail = (
            _attr(span, "gen_ai.guardrail.id")
            or _attr(span, "aws.bedrock.guardrail.id")
            or _attr(span, "aws.bedrock.guardrail_id")
        )
        events.append(AgentRunEvent(
            eventType="ACCESS", eventTime=ts, runId=run_id,
            producer="cloudwatch-spans-poller", agent=agent,
            error=_extract_error(span, f"llm:{model}"),
            llms=[LLMUsageRef(
                name=str(model), namespace=namespace,
                inputTokens=int(_attr(span, "gen_ai.usage.input_tokens") or 0),
                outputTokens=int(_attr(span, "gen_ai.usage.output_tokens") or 0),
            )],
            guardrailEvents=(
                [GuardrailEvent(
                    guardrail=EntityRef(
                        node_type="guardrail", name=str(guardrail), namespace=namespace
                    ),
                    llm=EntityRef(node_type="llm", name=str(model), namespace=namespace),
                    action="PASSED",
                )]
                if guardrail
                else []
            ),
        ))
    elif tool_name:
        events.append(AgentRunEvent(
            eventType="ACCESS", eventTime=ts, runId=run_id,
            producer="cloudwatch-spans-poller", agent=agent,
            error=_extract_error(span, f"tool:{tool_name}"),
            tools=[EntityRef(node_type="tool", name=str(tool_name), namespace=namespace)],
        ))
    return events


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    logs = session.client("logs")
    start_ms = int((datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)).timestamp() * 1000)

    scanned = 0
    ingested = 0
    runs: set[str] = set()
    token: Optional[str] = None
    # Diagnostics: discover how (or whether) spans mention guardrails at all.
    guardrail_mentions = 0
    guardrail_attr_keys: set[str] = set()
    while scanned < MAX_EVENTS:
        params = {
            "logGroupName": LOG_GROUP,
            "startTime": start_ms,
            "limit": 1000,
            # Only GenAI spans; skips infra span noise.
            "filterPattern": '"gen_ai"',
        }
        if token:
            params["nextToken"] = token
        try:
            resp = logs.filter_log_events(**params)
        except logs.exceptions.ResourceNotFoundException:
            return {
                "error_hint": (
                    f"log group '{LOG_GROUP}' not found — enable CloudWatch "
                    "Transaction Search / AgentCore Observability in this region"
                ),
                "spans_scanned": 0,
                "events_ingested": 0,
            }
        for le in resp.get("events", []):
            scanned += 1
            message = le.get("message", "")
            try:
                span = json.loads(message)
            except json.JSONDecodeError:
                continue
            if "guardrail" in message.lower():
                guardrail_mentions += 1
                for source in (
                    span.get("attributes") or {},
                    span,
                    ((span.get("resource") or {}).get("attributes")) or {},
                ):
                    if isinstance(source, dict):
                        guardrail_attr_keys.update(
                            k for k in source if "guardrail" in k.lower()
                        )
            for event in _span_to_events(span, namespace):
                ingest_event(db, event)
                runs.add(event.run_id)
                ingested += 1
        token = resp.get("nextToken")
        if not token:
            break

    result = {
        "spans_scanned": scanned,
        "events_ingested": ingested,
        "runs_touched": len(runs),
        "window_hours": WINDOW_HOURS,
        "log_group": LOG_GROUP,
        "guardrail_mentions_in_spans": guardrail_mentions,
        "guardrail_attr_keys_seen": sorted(guardrail_attr_keys)[:10],
    }
    if scanned == 0:
        result["hint"] = (
            f"no GenAI spans found in '{LOG_GROUP}' over the last {WINDOW_HOURS}h — "
            "check that AgentCore Observability / CloudWatch Transaction Search is "
            "enabled and that the agents ran within the window; override with "
            "AGENT_LINEAGE_SPANS_LOG_GROUP / AGENT_LINEAGE_SPANS_WINDOW_HOURS env vars"
        )
    return result
