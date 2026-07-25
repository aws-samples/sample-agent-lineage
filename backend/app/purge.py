"""Purge all lineage data for one namespace (e.g. the 'default' demo seed).

Run:  python -m app.purge default
Deletes nodes in the namespace plus everything referencing them
(edges, runs, events, usage, evaluations, decision/intervention logs).
"""
import sys

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from . import models
from .database import SessionLocal


def purge_namespace(db: Session, namespace: str) -> dict:
    node_ids = list(db.scalars(
        select(models.Node.id).where(models.Node.namespace == namespace)
    ))
    if not node_ids:
        return {"namespace": namespace, "nodes_deleted": 0}

    run_ids = list(db.scalars(
        select(models.Run.run_id).where(models.Run.agent_id.in_(node_ids))
    ))

    counts = {}
    if run_ids:
        counts["events"] = db.execute(
            delete(models.LineageEvent).where(models.LineageEvent.run_id.in_(run_ids))
        ).rowcount
    counts["llm_usage"] = db.execute(
        delete(models.LlmUsage).where(or_(
            models.LlmUsage.agent_id.in_(node_ids),
            models.LlmUsage.llm_id.in_(node_ids),
        ))
    ).rowcount
    counts["cedar_decisions"] = db.execute(
        delete(models.CedarDecision).where(or_(
            models.CedarDecision.agent_id.in_(node_ids),
            models.CedarDecision.gateway_id.in_(node_ids),
            models.CedarDecision.tool_id.in_(node_ids),
        ))
    ).rowcount
    counts["guardrail_interventions"] = db.execute(
        delete(models.GuardrailIntervention).where(or_(
            models.GuardrailIntervention.agent_id.in_(node_ids),
            models.GuardrailIntervention.guardrail_id.in_(node_ids),
        ))
    ).rowcount
    counts["evaluations"] = db.execute(
        delete(models.Evaluation).where(models.Evaluation.agent_id.in_(node_ids))
    ).rowcount
    counts["runs"] = db.execute(
        delete(models.Run).where(models.Run.agent_id.in_(node_ids))
    ).rowcount
    counts["edges"] = db.execute(
        delete(models.Edge).where(or_(
            models.Edge.source_id.in_(node_ids),
            models.Edge.target_id.in_(node_ids),
        ))
    ).rowcount
    counts["nodes_deleted"] = db.execute(
        delete(models.Node).where(models.Node.id.in_(node_ids))
    ).rowcount
    db.commit()
    return {"namespace": namespace, **counts}


if __name__ == "__main__":
    ns = sys.argv[1] if len(sys.argv) > 1 else "default"
    db = SessionLocal()
    try:
        print(purge_namespace(db, ns))
    finally:
        db.close()
