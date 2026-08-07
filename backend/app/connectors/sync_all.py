"""Run every AWS connector against one account/region and report per-module results.

Each connector is independent: a failure (missing permission, service not in
region, preview API absent from botocore) is captured as that module's error
without aborting the rest. Evaluations and the runtime data plane (spans ->
events) are intentionally not polled here — runs/costs arrive through the
OTel translator posting to /api/v1/lineage/events (see integrations/).
"""
from sqlalchemy.orm import Session

from . import (
    evaluations_sync,
    gateway_sync,
    guardrail_sync,
    identity_sync,
    observability_sync,
    registry_connector,
    runtime_sync,
)
from .base import account_id, make_session

# Order matters: agents must exist before evaluations try to associate with them.
CONNECTORS = {
    "runtime_agents": runtime_sync.sync,
    "gateways": gateway_sync.sync,
    "identity": identity_sync.sync,
    "guardrails": guardrail_sync.sync,
    "registry": registry_connector.sync,
    "evaluations": evaluations_sync.sync,
    "observability_runs": observability_sync.sync,
}


def sync_account(
    db: Session,
    region: str,
    profile: str | None = None,
    role_arn: str | None = None,
    external_id: str | None = None,
) -> dict:
    session = make_session(region, profile=profile, role_arn=role_arn, external_id=external_id)
    acct = account_id(session)  # also validates credentials up front
    namespace = f"{acct}/{region}"

    modules: dict[str, dict] = {}
    for name, sync_fn in CONNECTORS.items():
        try:
            modules[name] = {"ok": True, **sync_fn(db, session, namespace)}
        except Exception as e:  # noqa: BLE001 — per-module isolation is the point
            db.rollback()
            modules[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}

    return {"account_id": acct, "region": region, "namespace": namespace, "modules": modules}
