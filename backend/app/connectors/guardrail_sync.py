"""Sync Bedrock Guardrails as guardrail nodes."""
import boto3
from sqlalchemy.orm import Session

from ..ingest import upsert_node
from ..schemas import EntityRef
from .base import paginate


def sync(db: Session, session: boto3.Session, namespace: str) -> dict:
    client = session.client("bedrock")
    count = 0
    for g in paginate(client, "list_guardrails", "guardrails"):
        node = upsert_node(db, EntityRef(
            node_type="guardrail",
            name=g.get("name") or g.get("id", "unknown"),
            namespace=namespace,
            facets={
                "provider": "Amazon Bedrock Guardrails",
                "arn": g.get("arn", ""),
                "guardrail_id": g.get("id", ""),
                "status": g.get("status", ""),
                "version": g.get("version", ""),
                "source": "aws:bedrock:list_guardrails",
            },
        ))
        node.description = g.get("description", "") or node.description
        count += 1
    db.commit()
    return {"guardrails": count}
