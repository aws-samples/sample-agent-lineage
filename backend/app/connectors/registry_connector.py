"""Sync AWS Agent Registry (AgentCore Registry) records: agents, MCP tools, skills.

Field names verified against the botocore 1.43.51 service model:
- list_registries -> registries[{registryId, name, status, authorizerType, ...}]
- list_registry_records(registryId=...) -> registryRecords[{recordId, name,
  descriptorType: MCP|A2A|CUSTOM|AGENT_SKILLS, recordVersion, status, ...}]
- get_registry_record(registryId, recordId) -> descriptors:
    {mcp: {server, tools}, a2a: {agentCard}, custom: {...}, agentSkills: {...}}

NOTE: the service moves from the bedrock-agentcore namespace to agent-registry
in August 2026 — update the client name and IAM actions when migrating.
"""
import boto3
from sqlalchemy.orm import Session

from ..ingest import upsert_edge, upsert_node
from ..schemas import EntityRef
from .base import paginate

# descriptorType -> our node types.
TYPE_MAP = {
    "MCP": "tool",
    "A2A": "agent",
    "AGENT_SKILLS": "skill",
    "CUSTOM": "tool",
}


def _tool_names(mcp_descriptor: dict) -> list[str]:
    tools = mcp_descriptor.get("tools") or []
    names = []
    for t in tools:
        if isinstance(t, dict):
            names.append(t.get("name", "unknown"))
        else:
            names.append(str(t))
    return names


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock-agentcore-control")
    records = 0
    skills_linked = 0

    for registry in paginate(client, "list_registries", "registries"):
        registry_id = registry.get("registryId", "")
        registry_name = registry.get("name", registry_id)

        for rec in paginate(
            client, "list_registry_records", "registryRecords", registryId=registry_id
        ):
            rec_type = (rec.get("descriptorType") or "CUSTOM").upper()
            node_type = TYPE_MAP.get(rec_type, "tool")
            name = rec.get("name", "unknown")
            registry_facet = {
                "registry_name": registry_name,
                "registry_id": registry_id,
                "record_id": rec.get("recordId", ""),
                "record_arn": rec.get("recordArn", ""),
                "record_type": rec_type,
                "record_version": rec.get("recordVersion", ""),
                "status": rec.get("status", ""),
                "source": "aws:bedrock-agentcore-control:list_registry_records",
            }

            # Detail call for descriptors (MCP tool definitions, A2A card, skills).
            descriptors: dict = {}
            try:
                detail = client.get_registry_record(
                    registryId=registry_id, recordId=rec.get("recordId", "")
                )
                descriptors = detail.get("descriptors") or {}
                registry_facet["sync_type"] = detail.get("synchronizationType", "")
            except Exception:
                pass

            facets: dict = {"registry": registry_facet}
            if rec_type == "MCP":
                mcp = descriptors.get("mcp") or {}
                defs = _tool_names(mcp)
                if defs:
                    facets["registry"]["tool_definitions"] = defs
            elif rec_type == "AGENT_SKILLS":
                sk = descriptors.get("agentSkills") or {}
                if sk.get("skillDefinition"):
                    facets["registry"]["skill_definition"] = str(sk["skillDefinition"])[:2000]

            node = upsert_node(db, EntityRef(
                node_type=node_type,  # type: ignore[arg-type]
                name=name,
                namespace=namespace,
                facets=facets,
            ))
            node.description = rec.get("description", "") or node.description
            records += 1

            # A2A agent cards may declare skills -> HAS_SKILL edges.
            card = (descriptors.get("a2a") or {}).get("agentCard") or {}
            if isinstance(card, dict):
                for skill in card.get("skills", []) or []:
                    if not isinstance(skill, dict):
                        continue
                    skill_name = skill.get("name") or skill.get("id", "")
                    if not skill_name:
                        continue
                    sk_node = upsert_node(db, EntityRef(
                        node_type="skill", name=skill_name, namespace=namespace,
                        facets={"registry": {"source": "A2A agent card", **registry_facet}},
                    ))
                    sk_node.description = skill.get("description", "") or sk_node.description
                    db.flush()
                    upsert_edge(
                        db, node.id, sk_node.id, "HAS_SKILL",
                        origin="declared",
                        facets={"source": "A2A agent card (registry)"},
                    )
                    skills_linked += 1

    db.commit()
    return {"records": records, "skills_linked": skills_linked}
