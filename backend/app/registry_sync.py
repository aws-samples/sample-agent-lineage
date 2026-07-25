"""Sync metadata from AgentCore Registry (AWS Agent Registry) into the lineage graph.

The registry is the platform catalog for agents, MCP servers/tools, and skills:
- Agent records hold an A2A agent card (capabilities, skills, interface).
- MCP server records hold server + tool definitions, validated against MCP schema.
- Skill records hold descriptor metadata, package/repository info and docs.
- Records carry version, approval status (DRAFT/APPROVED/DEPRECATED), publisher,
  curator, and optional URL synchronization from live endpoints.

In production, replace `fetch_registry_records()` with boto3 calls:

    client = boto3.client("bedrock-agentcore-control")
    records = client.list_registry_records(registryIdentifier=...)
    # or bedrock-agentcore search_registry_records(query=..., searchType="HYBRID")

Here we ship a representative demo dataset with the same shape.
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from .ingest import upsert_edge, upsert_node
from .schemas import EntityRef, node_id

REGISTRY_NAME = "platform-prod-registry"
REGISTRY_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/platform-prod"


def _record(record_type: str, version: str, status: str, publisher: str, **extra) -> dict:
    return {
        "registry_name": REGISTRY_NAME,
        "registry_arn": REGISTRY_ARN,
        "record_type": record_type,
        "record_version": version,
        "status": status,
        "publisher": publisher,
        "curator": "ai-governance-team",
        "inbound_auth": "JWT (corporate IdP)",
        **extra,
    }


def fetch_registry_records() -> dict:
    """Demo stand-in for list_registry_records / search_registry_records."""
    return {
        # ---- Agent records (A2A agent cards) ----
        ("agent", "support-orchestrator"): _record(
            "Agent (A2A agent card)", "2.3.1", "APPROVED", "platform-team",
            record_id="rec-agt-7f21",
            a2a_endpoint="https://agents.internal.example.com/support-orchestrator/a2a",
            protocol_validation="A2A schema: PASSED",
            sync="URL sync from runtime endpoint (IAM credential provider)",
            skills=["ticket-triage", "ticket-summarization"],
        ),
        ("agent", "billing-agent"): _record(
            "Agent (A2A agent card)", "1.8.0", "APPROVED", "billing-team",
            record_id="rec-agt-9c44",
            protocol_validation="A2A schema: PASSED",
            skills=["refund-processing"],
        ),
        ("agent", "kb-research-agent"): _record(
            "Agent (A2A agent card)", "3.0.2", "APPROVED", "platform-team",
            record_id="rec-agt-2b18",
            protocol_validation="A2A schema: PASSED",
            skills=["grounded-answering"],
        ),
        ("agent", "fraud-review-agent"): _record(
            "Agent (A2A agent card)", "0.9.1", "DRAFT", "risk-team",
            record_id="rec-agt-5e02",
            protocol_validation="A2A schema: PASSED",
            note="Partner-hosted; pending curator approval",
            skills=[],
        ),
        # ---- MCP server / tool records ----
        ("tool", "stripe-mcp"): _record(
            "MCP server", "4.1.0", "APPROVED", "billing-team",
            record_id="rec-mcp-1a90",
            protocol_validation="MCP schema: PASSED",
            sync="URL sync from gateway endpoint (OAuth credential provider)",
            tool_definitions=["create_refund(charge_id, amount_usd)", "get_charge(charge_id)",
                              "list_charges(customer_id, limit)"],
        ),
        ("tool", "zendesk-api"): _record(
            "MCP server", "2.0.3", "APPROVED", "support-tools-team",
            record_id="rec-mcp-3c72",
            protocol_validation="MCP schema: PASSED",
            tool_definitions=["create_ticket(subject, body, priority)",
                              "update_ticket(ticket_id, status, comment)"],
        ),
        ("tool", "vector-search"): _record(
            "MCP server", "1.5.2", "APPROVED", "platform-team",
            record_id="rec-mcp-8d31",
            protocol_validation="MCP schema: PASSED",
            sync="URL sync from runtime MCP endpoint (IAM credential provider)",
            tool_definitions=["semantic_search(query, top_k)", "get_document(doc_id)"],
        ),
        ("tool", "code-interpreter"): _record(
            "Custom resource", "1.0.0", "APPROVED", "platform-team",
            record_id="rec-cus-4f55",
            note="AgentCore built-in tool, registered for discoverability",
        ),
    }


def fetch_skill_records() -> list[dict]:
    """Skill records: reusable capabilities shared across agents."""
    return [
        {
            "name": "ticket-triage",
            "description": "Classify and route incoming support tickets by intent and severity",
            "registry": _record(
                "Skill", "1.2.0", "APPROVED", "platform-team",
                record_id="rec-skl-6a10",
                package="pypi: acme-skills-triage==1.2.0",
                repository="https://git.example.com/acme/skills/triage",
                documentation="Prompts + few-shot examples for intent/severity classification.",
            ),
        },
        {
            "name": "ticket-summarization",
            "description": "Summarize long ticket threads into agent-ready briefs",
            "registry": _record(
                "Skill", "1.0.4", "APPROVED", "support-tools-team",
                record_id="rec-skl-7b21",
                package="pypi: acme-skills-summarize==1.0.4",
                repository="https://git.example.com/acme/skills/summarize",
            ),
        },
        {
            "name": "refund-processing",
            "description": "Policy-aware refund decisioning and Stripe execution steps",
            "registry": _record(
                "Skill", "2.1.0", "APPROVED", "billing-team",
                record_id="rec-skl-8c32",
                package="pypi: acme-skills-refunds==2.1.0",
                repository="https://git.example.com/acme/skills/refunds",
                documentation="Encodes refund policy thresholds; pairs with payments-gateway Cedar limits.",
            ),
        },
        {
            "name": "grounded-answering",
            "description": "RAG answer generation with citation enforcement",
            "registry": _record(
                "Skill", "3.0.0", "APPROVED", "platform-team",
                record_id="rec-skl-9d43",
                package="pypi: acme-skills-rag==3.0.0",
                repository="https://git.example.com/acme/skills/rag",
            ),
        },
    ]


def sync_registry(db: Session) -> dict:
    """Enrich existing nodes with registry metadata and materialize skills
    (skill nodes + declared HAS_SKILL edges). Idempotent."""
    now = datetime.now(timezone.utc).isoformat()
    enriched = 0

    # Skills first, so HAS_SKILL edges can point at them.
    for skill in fetch_skill_records():
        node = upsert_node(db, EntityRef(
            node_type="skill", name=skill["name"],
            facets={"registry": {**skill["registry"], "last_synced_at": now}},
        ))
        node.description = skill["description"]
    db.flush()

    for (ntype, name), record in fetch_registry_records().items():
        nid = node_id("default", ntype, name)
        skills = record.pop("skills", None)
        node = upsert_node(db, EntityRef(
            node_type=ntype, name=name,  # type: ignore[arg-type]
            facets={"registry": {**record, "last_synced_at": now}},
        ))
        enriched += 1
        if skills:
            db.flush()
            for skill_name in skills:
                upsert_edge(
                    db, nid, node_id("default", "skill", skill_name), "HAS_SKILL",
                    origin="declared", facets={"source": "A2A agent card (registry)"},
                )

    db.commit()
    return {
        "registry": REGISTRY_NAME,
        "records_enriched": enriched,
        "skills_synced": len(fetch_skill_records()),
        "synced_at": now,
    }
