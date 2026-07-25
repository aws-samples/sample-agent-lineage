"""Sync agents from AgentCore Runtime (bedrock-agentcore-control).

Also derives user_group nodes from each runtime's inbound authorizer config:
every allowed OAuth client (customJWTAuthorizer.allowedClients / audiences) is
a consumer group permitted to invoke the agent -> declared INVOKES edges.
"""
import boto3
from sqlalchemy.orm import Session

from ..ingest import upsert_edge, upsert_node
from ..schemas import EntityRef
from .base import paginate


def _sync_inbound_groups(db: Session, namespace: str, agent_id: str, detail: dict) -> int:
    """user_group nodes + INVOKES edges from the runtime's JWT authorizer config."""
    jwt = (detail.get("authorizerConfiguration") or {}).get("customJWTAuthorizer") or {}
    if not jwt:
        return 0
    clients = list(jwt.get("allowedClients") or []) or list(jwt.get("allowedAudience") or [])
    created = 0
    for client_id in clients:
        group = upsert_node(db, EntityRef(
            node_type="user_group",
            name=str(client_id),
            namespace=namespace,
            facets={
                "kind": "OAuth client (inbound authorizer)",
                "idp_discovery_url": jwt.get("discoveryUrl", ""),
                "allowed_scopes": list(jwt.get("allowedScopes") or []),
                "source": "aws:get_agent_runtime:authorizerConfiguration",
            },
        ))
        db.flush()
        upsert_edge(
            db, group.id, agent_id, "INVOKES", origin="declared",
            facets={"mechanism": "AgentCore Runtime invoke",
                    "auth": "OAuth2 JWT (custom authorizer)"},
        )
        created += 1
    return created


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock-agentcore-control")
    count = 0
    groups = 0
    for rt in paginate(client, "list_agent_runtimes", "agentRuntimes"):
        name = rt.get("agentRuntimeName") or rt.get("agentRuntimeId", "unknown")
        facets = {
            "engine": "AgentCore Runtime",
            "arn": rt.get("agentRuntimeArn", ""),
            "runtime_id": rt.get("agentRuntimeId", ""),
            "status": rt.get("status", ""),
            "version": rt.get("agentRuntimeVersion", ""),
            "last_updated": str(rt.get("lastUpdatedAt", "")),
            "source": "aws:bedrock-agentcore-control:list_agent_runtimes",
        }
        # Enrich with detail call when available (network mode, role, authorizer).
        detail: dict = {}
        try:
            detail = client.get_agent_runtime(agentRuntimeId=rt["agentRuntimeId"])
            net = (detail.get("networkConfiguration") or {})
            facets["network_mode"] = net.get("networkMode", "")
            facets["execution_role"] = detail.get("roleArn", "")
            facets["protocol"] = (detail.get("protocolConfiguration") or {}).get(
                "serverProtocol", ""
            )
            wid = (detail.get("workloadIdentityDetails") or {}).get(
                "workloadIdentityArn", ""
            )
            if wid:
                facets["workload_identity_arn"] = wid
        except Exception:  # detail is best-effort
            pass
        node = upsert_node(
            db, EntityRef(node_type="agent", name=name, namespace=namespace, facets=facets)
        )
        node.description = rt.get("description", "") or node.description
        count += 1
        if detail:
            db.flush()
            groups += _sync_inbound_groups(db, namespace, node.id, detail)
    db.commit()
    return {"agents": count, "inbound_user_groups": groups}
