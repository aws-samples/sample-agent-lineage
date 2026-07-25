"""Sync AgentCore Gateways and their targets (tools) + ROUTES_TO edges."""
import boto3
from sqlalchemy.orm import Session

from ..ingest import upsert_edge, upsert_node
from ..schemas import EntityRef
from .base import paginate


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock-agentcore-control")
    gateways = 0
    targets = 0
    for gw in paginate(client, "list_gateways", "items"):
        gw_name = gw.get("name") or gw.get("gatewayId", "unknown")
        gw_id = gw.get("gatewayId", "")
        gw_node = upsert_node(db, EntityRef(
            node_type="gateway", name=gw_name, namespace=namespace,
            facets={
                "arn": gw.get("gatewayArn", ""),
                "gateway_id": gw_id,
                "status": gw.get("status", ""),
                "protocol": gw.get("protocolType", ""),
                "inbound_auth": gw.get("authorizerType", ""),
                "source": "aws:bedrock-agentcore-control:list_gateways",
            },
        ))
        gw_node.description = gw.get("description", "") or gw_node.description
        gateways += 1
        db.flush()

        try:
            for tgt in paginate(
                client, "list_gateway_targets", "items", gatewayIdentifier=gw_id
            ):
                tool_name = tgt.get("name") or tgt.get("targetId", "unknown")
                tool = upsert_node(db, EntityRef(
                    node_type="tool", name=tool_name, namespace=namespace,
                    facets={
                        "hosting": "AgentCore Gateway target",
                        "target_id": tgt.get("targetId", ""),
                        "target_type": tgt.get("targetType", ""),
                        "status": tgt.get("status", ""),
                        "last_synchronized": str(tgt.get("lastSynchronizedAt", "")),
                        "source": "aws:bedrock-agentcore-control:list_gateway_targets",
                    },
                ))
                tool.description = tgt.get("description", "") or tool.description
                db.flush()
                upsert_edge(
                    db, gw_node.id, tool.id, "ROUTES_TO", origin="declared",
                    facets={"source": "gateway target config"},
                )
                targets += 1
        except Exception as e:  # keep gateway even if targets call fails
            gw_node.facets = {**gw_node.facets, "targets_error": str(e)}
    db.commit()
    return {"gateways": gateways, "targets": targets}
