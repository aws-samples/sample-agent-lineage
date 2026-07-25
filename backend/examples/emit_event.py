"""Example: emit an agent run lifecycle to the lineage API.

This is what an agent framework hook, OTel exporter, or MCP gateway would send.
Run:  python examples/emit_event.py   (backend must be running on :8000)
"""
import json
import urllib.request
import uuid
from datetime import datetime, timezone

API = "http://localhost:8000/api/v1/lineage/events"


def post(event: dict) -> None:
    req = urllib.request.Request(
        API, data=json.dumps(event).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as res:
        print(res.status, json.loads(res.read())["state"])


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


run_id = str(uuid.uuid4())
agent = {"node_type": "agent", "name": "kb-research-agent"}

post({
    "eventType": "START", "eventTime": now(), "runId": run_id, "producer": "example",
    "agent": agent,
    "onBehalfOf": {"node_type": "user_group", "name": "support-team"},
})
post({
    "eventType": "ACCESS", "eventTime": now(), "runId": run_id, "producer": "example",
    "agent": agent,
    "tools": [{"node_type": "tool", "name": "vector-search"}],
    # Token usage drives cost metrics; cost_usd is derived from the LLM node's
    # pricing facet when omitted.
    "llms": [{"node_type": "llm", "name": "claude-sonnet-4",
              "inputTokens": 4200, "outputTokens": 900}],
    "resources": [{"node_type": "resource", "name": "kb-index"}],
})
post({
    "eventType": "COMPLETE", "eventTime": now(), "runId": run_id, "producer": "example",
    "agent": agent, "runFacets": {"tokens": 5120, "cost_usd": 0.11},
})
print(f"run {run_id} complete — refresh the UI to see updated call counts")
