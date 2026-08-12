"""Agent Lineage API — end-to-end lineage for agents in an Agentic AI platform.

NOTE: v1 has no authentication. Do not expose beyond localhost / trusted networks
until authn/z is added (see docs/RESEARCH.md roadmap).
"""
from datetime import datetime
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import auth, rbac
from . import graph as graph_service
from . import ingest, models, registry_sync
from .database import Base, engine, get_db
from sqlalchemy import func

from .schemas import (
    AccessRequestIn,
    AccessRequestOut,
    AgentCatalogEntry,
    AgentCost,
    AgentRunEvent,
    CedarDecisionOut,
    EdgeIn,
    EdgeOut,
    EvaluationIn,
    EvaluationOut,
    Graph,
    GuardrailInterventionOut,
    LlmCostBreakdown,
    MeOut,
    NodeIn,
    NodeOut,
    RunOut,
    RunsPage,
    node_id,
)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Agent Lineage", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Authentication (Cognito JWT; disabled when env vars absent) ----------

import os
import secrets as _secrets

# Service credential for the OTel translator (F5): a deployment-generated key
# that authorizes ONLY the lineage-events ingestion endpoint. Set via the
# IngestApiKey stack parameter -> INGEST_API_KEY env var; empty disables it.
INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "")
INGEST_PATH = "/api/v1/lineage/events"
_SERVICE_CLAIMS = {
    "cognito:groups": [rbac.ADMIN_GROUP],
    "sub": "svc-otel-translator",
    "username": "svc-otel-translator",
    "email": "svc-otel-translator@service",
}


@app.middleware("http")
async def cognito_auth_middleware(request, call_next):
    if (
        not auth.ENABLED
        or request.method == "OPTIONS"
        or not request.url.path.startswith("/api/")
        or request.url.path in auth.PUBLIC_PATHS
    ):
        return await call_next(request)
    # Machine identity: ingest key grants the events endpoint only.
    if request.url.path == INGEST_PATH and INGEST_API_KEY:
        provided = request.headers.get("x-ingest-key", "")
        if provided and _secrets.compare_digest(provided, INGEST_API_KEY):
            request.state.claims = _SERVICE_CLAIMS
            return await call_next(request)
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer "):
        try:
            # Stash claims for downstream RBAC checks (role, namespace scope).
            request.state.claims = auth.verify_token(header[7:])
            return await call_next(request)
        except Exception:
            pass
    from fastapi.responses import JSONResponse

    return JSONResponse({"detail": "unauthorized"}, status_code=401)


@app.get("/api/v1/auth/config")
def get_auth_config():
    return auth.auth_config()


# ---------- Identity & access scope ----------

def _visible_namespaces(db: Session, entries) -> list[str]:
    rows = db.execute(select(models.Node.namespace).distinct()).scalars().all()
    return sorted(ns for ns in rows if rbac.ns_allowed(ns, entries))


def _check_node_scope(db: Session, nid: str, entries) -> None:
    """403 when a node-id-addressed resource is outside the caller's scope."""
    if entries is None:
        return
    node = db.get(models.Node, nid)
    if node is not None:
        rbac.check_ns(node.namespace, entries)


@app.get("/api/v1/me", response_model=MeOut)
def me(request: Request, db: Session = Depends(get_db)):
    """Caller's role and account scope; the frontend shapes its UI from this."""
    claims = getattr(request.state, "claims", None)
    entries = rbac.allowed_entries(claims)
    return MeOut(
        auth_enabled=auth.ENABLED,
        role="admin" if rbac.is_admin(claims) else "viewer",
        email=rbac.email_of(claims),
        allowed_entries=sorted(entries) if entries is not None else [],
        namespaces=_visible_namespaces(db, entries),
    )


# ---------- Access requests (viewer asks, admin approves in-app) ----------

@app.post("/api/v1/access-requests", response_model=AccessRequestOut)
def create_access_request(
    payload: AccessRequestIn, request: Request, db: Session = Depends(get_db)
):
    """A viewer requests access to an AWS account. Admins are notified by
    email (best-effort) and approve or reject in the app."""
    claims = getattr(request.state, "claims", None)
    req = models.AccessRequest(
        requester_sub=rbac.sub_of(claims),
        requester_username=rbac.username_of(claims),
        requester_email=rbac.email_of(claims),
        account_name=payload.account_name,
        account_id=payload.account_id,
        reason=payload.reason,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    rbac.notify_admins(
        subject=f"[Agent Lineage] Access request: {payload.account_name} ({payload.account_id})",
        body=(
            f"{req.requester_email or req.requester_username} requested access to "
            f"AWS account {payload.account_name} ({payload.account_id}).\n\n"
            f"Reason: {payload.reason}\n\n"
            f"Review and approve/reject in the Agent Lineage app (Access Requests)."
        ),
    )
    return req


@app.get("/api/v1/access-requests", response_model=list[AccessRequestOut])
def list_access_requests(request: Request, db: Session = Depends(get_db)):
    """Admins see every request; viewers see only their own history."""
    claims = getattr(request.state, "claims", None)
    stmt = select(models.AccessRequest).order_by(models.AccessRequest.created_at.desc())
    if not rbac.is_admin(claims):
        stmt = stmt.where(models.AccessRequest.requester_sub == rbac.sub_of(claims))
    return list(db.scalars(stmt))


class AccessDecision(BaseModel):
    action: str  # approve | reject


@app.post(
    "/api/v1/access-requests/{request_id}/decision",
    response_model=AccessRequestOut,
    dependencies=[Depends(rbac.require_admin)],
)
def decide_access_request(
    request_id: int, decision: AccessDecision, request: Request,
    db: Session = Depends(get_db),
):
    if decision.action not in ("approve", "reject"):
        raise HTTPException(400, "action must be approve or reject")
    req = db.get(models.AccessRequest, request_id)
    if req is None:
        raise HTTPException(404, "access request not found")
    if req.status != "pending":
        raise HTTPException(409, f"request already {req.status}; file a new one")
    if decision.action == "approve":
        try:
            # Grant the whole account (all regions): entry is the account id.
            rbac.grant_account(req.requester_username or req.requester_sub, req.account_id)
        except Exception as e:
            raise HTTPException(502, f"Cognito grant failed: {type(e).__name__}: {e}")
    req.status = "approved" if decision.action == "approve" else "rejected"
    req.decided_at = models.utcnow()
    req.decided_by = rbac.email_of(getattr(request.state, "claims", None))
    db.commit()
    db.refresh(req)
    return req


# ---------- Registry (declared lineage) ----------

@app.post("/api/v1/nodes", response_model=NodeOut, dependencies=[Depends(rbac.require_admin)])
def create_node(payload: NodeIn, db: Session = Depends(get_db)):
    nid = node_id(payload.namespace, payload.node_type, payload.name)
    node = db.get(models.Node, nid)
    if node is None:
        node = models.Node(id=nid, **payload.model_dump())
        db.add(node)
    else:
        node.description = payload.description or node.description
        node.facets = {**(node.facets or {}), **payload.facets}
    db.commit()
    db.refresh(node)
    return node


@app.get("/api/v1/nodes", response_model=list[NodeOut])
def list_nodes(
    node_type: Optional[str] = None,
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    stmt = select(models.Node)
    if entries is not None:
        stmt = stmt.where(models.Node.namespace.in_(_visible_namespaces(db, entries)))
    if node_type:
        stmt = stmt.where(models.Node.node_type == node_type)
    return list(db.scalars(stmt))


@app.get("/api/v1/nodes/{nid:path}", response_model=NodeOut)
def get_node(nid: str, db: Session = Depends(get_db), entries=Depends(rbac.scope)):
    node = db.get(models.Node, nid)
    if node is None:
        raise HTTPException(404, "node not found")
    rbac.check_ns(node.namespace, entries)
    return node


@app.post("/api/v1/edges", response_model=EdgeOut, dependencies=[Depends(rbac.require_admin)])
def create_edge(payload: EdgeIn, db: Session = Depends(get_db)):
    for nid in (payload.source_id, payload.target_id):
        if db.get(models.Node, nid) is None:
            raise HTTPException(400, f"unknown node: {nid}")
    edge = ingest.upsert_edge(
        db, payload.source_id, payload.target_id, payload.edge_type,
        origin="declared", facets=payload.facets,
    )
    db.commit()
    db.refresh(edge)
    return edge


# ---------- Lineage events (observed lineage) ----------

def _run_out(run: models.Run, usage: dict[str, tuple]) -> RunOut:
    cost, inp, out = usage.get(run.run_id, (0.0, 0, 0))
    return RunOut(
        run_id=run.run_id, agent_id=run.agent_id, state=run.state,
        started_at=run.started_at, ended_at=run.ended_at, facets=run.facets or {},
        cost_usd=round(float(cost or 0), 4),
        input_tokens=int(inp or 0), output_tokens=int(out or 0),
    )


def _usage_by_run(db: Session, run_ids: list[str]) -> dict[str, tuple]:
    if not run_ids:
        return {}
    rows = db.execute(
        select(
            models.LlmUsage.run_id,
            func.sum(models.LlmUsage.cost_usd),
            func.sum(models.LlmUsage.input_tokens),
            func.sum(models.LlmUsage.output_tokens),
        )
        .where(models.LlmUsage.run_id.in_(run_ids))
        .group_by(models.LlmUsage.run_id)
    ).all()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


@app.post(
    "/api/v1/lineage/events",
    response_model=RunOut,
    dependencies=[Depends(rbac.require_admin)],
)
def post_lineage_event(event: AgentRunEvent, db: Session = Depends(get_db)):
    """Ingest an observed runtime event. Admin-gated: decision/guardrail fields
    become audit records, so writes are restricted to the admin persona (see
    'Roles and trust model' in the README)."""
    run = ingest.ingest_event(db, event)
    return _run_out(run, _usage_by_run(db, [run.run_id]))


@app.get("/api/v1/runs", response_model=RunsPage)
def list_runs(
    agent_id: Optional[str] = None,
    state: Optional[str] = Query(default=None, pattern="^(RUNNING|COMPLETE|FAIL)$"),
    since: Optional[datetime] = None,
    limit: int = Query(default=25, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    """Paginated run history with per-run LLM cost rollups. A run is one
    end-to-end agent invocation (all sub-agent activity under the same runId)."""
    conditions = []
    if agent_id:
        _check_node_scope(db, agent_id, entries)
        conditions.append(models.Run.agent_id == agent_id)
    if state:
        conditions.append(models.Run.state == state)
    if since:
        conditions.append(models.Run.started_at >= since)
    if entries is not None:
        allowed = _visible_namespaces(db, entries)
        agent_ids = select(models.Node.id).where(models.Node.namespace.in_(allowed))
        conditions.append(models.Run.agent_id.in_(agent_ids))
    total = db.scalar(
        select(func.count()).select_from(models.Run).where(*conditions)
    ) or 0
    runs = list(db.scalars(
        select(models.Run).where(*conditions)
        .order_by(models.Run.started_at.desc())
        .limit(limit).offset(offset)
    ))
    usage = _usage_by_run(db, [r.run_id for r in runs])
    return RunsPage(total=total, runs=[_run_out(r, usage) for r in runs])


# ---------- Graph for the UI ----------

@app.get("/api/v1/lineage/graph", response_model=Graph)
def get_lineage_graph(
    node_id: Optional[list[str]] = Query(default=None),
    depth: int = Query(default=5, ge=1, le=10),
    namespace: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    """Full graph, or the union of BFS neighborhoods around one or more focus
    nodes -- always limited to the caller's namespace scope, optionally
    narrowed further to one selected namespace."""
    if namespace:
        rbac.check_ns(namespace, entries)

    def allowed(ns: str) -> bool:
        if namespace and ns != namespace:
            return False
        return rbac.ns_allowed(ns, entries)

    restrict = allowed if (namespace or entries is not None) else None
    return graph_service.get_graph(db, node_ids=node_id, depth=depth, ns_allowed=restrict)


# ---------- Cross-type catalog search ----------

@app.get("/api/v1/search")
def search_nodes(
    q: Optional[str] = None,
    node_type: Optional[str] = None,
    namespace: Optional[str] = None,
    limit: int = Query(default=60, ge=1, le=200),
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    """Search the whole catalog: agents, tools, skills, gateways, LLMs, etc.
    Agent rows include run/eval/cost aggregates. Scoped to the caller's
    allowed namespaces, optionally narrowed to one."""
    stmt = select(models.Node)
    if namespace:
        rbac.check_ns(namespace, entries)
        stmt = stmt.where(models.Node.namespace == namespace)
    elif entries is not None:
        stmt = stmt.where(models.Node.namespace.in_(_visible_namespaces(db, entries)))
    if q:
        stmt = stmt.where(models.Node.name.ilike(f"%{q}%"))
    if node_type:
        stmt = stmt.where(models.Node.node_type == node_type)
    nodes = list(db.scalars(stmt.order_by(models.Node.node_type, models.Node.name).limit(limit)))

    agent_ids = [n.id for n in nodes if n.node_type == "agent"]
    run_counts: dict = {}
    eval_counts: dict = {}
    costs: dict = {}
    if agent_ids:
        run_counts = dict(db.execute(
            select(models.Run.agent_id, func.count())
            .where(models.Run.agent_id.in_(agent_ids))
            .group_by(models.Run.agent_id)
        ).all())
        eval_counts = dict(db.execute(
            select(models.Evaluation.agent_id, func.count())
            .where(models.Evaluation.agent_id.in_(agent_ids))
            .group_by(models.Evaluation.agent_id)
        ).all())
        costs = dict(db.execute(
            select(models.LlmUsage.agent_id, func.sum(models.LlmUsage.cost_usd))
            .where(models.LlmUsage.agent_id.in_(agent_ids))
            .group_by(models.LlmUsage.agent_id)
        ).all())

    def engine_of(n: models.Node) -> str:
        f = n.facets or {}
        return str(
            f.get("engine") or f.get("hosting") or f.get("provider") or f.get("kind")
            or ((f.get("registry") or {}).get("record_type") if isinstance(f.get("registry"), dict) else "")
            or ""
        )

    return [
        {
            "id": n.id,
            "node_type": n.node_type,
            "name": n.name,
            "namespace": n.namespace,
            "description": n.description or "",
            "engine": engine_of(n),
            "run_count": run_counts.get(n.id, 0),
            "eval_count": eval_counts.get(n.id, 0),
            "total_cost_usd": round(float(costs.get(n.id) or 0.0), 4),
        }
        for n in nodes
    ]


# ---------- Agent catalog (AgentCore registry search) ----------

@app.get("/api/v1/agents/catalog", response_model=list[AgentCatalogEntry])
def agent_catalog(
    q: Optional[str] = None,
    namespace: Optional[str] = None,
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    stmt = select(models.Node).where(models.Node.node_type == "agent")
    if namespace:
        rbac.check_ns(namespace, entries)
        stmt = stmt.where(models.Node.namespace == namespace)
    elif entries is not None:
        stmt = stmt.where(models.Node.namespace.in_(_visible_namespaces(db, entries)))
    if q:
        stmt = stmt.where(models.Node.name.ilike(f"%{q}%"))
    agents = list(db.scalars(stmt))

    run_counts = dict(db.execute(
        select(models.Run.agent_id, func.count()).group_by(models.Run.agent_id)
    ).all())
    eval_counts = dict(db.execute(
        select(models.Evaluation.agent_id, func.count()).group_by(models.Evaluation.agent_id)
    ).all())
    costs = dict(db.execute(
        select(models.LlmUsage.agent_id, func.sum(models.LlmUsage.cost_usd))
        .group_by(models.LlmUsage.agent_id)
    ).all())

    return [
        AgentCatalogEntry(
            id=a.id,
            name=a.name,
            namespace=a.namespace,
            description=a.description or "",
            engine=(a.facets or {}).get("engine", ""),
            facets=a.facets or {},
            run_count=run_counts.get(a.id, 0),
            eval_count=eval_counts.get(a.id, 0),
            total_cost_usd=round(costs.get(a.id) or 0.0, 4),
        )
        for a in agents
    ]


# ---------- Evaluations (AgentCore Evaluations) ----------

@app.post(
    "/api/v1/evaluations",
    response_model=EvaluationOut,
    dependencies=[Depends(rbac.require_admin)],
)
def create_evaluation(payload: EvaluationIn, db: Session = Depends(get_db)):
    if db.get(models.Node, payload.agent_id) is None:
        raise HTTPException(400, f"unknown agent: {payload.agent_id}")
    ev = models.Evaluation(**payload.model_dump(exclude_none=True))
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/v1/evaluations", response_model=list[EvaluationOut])
def list_evaluations(
    agent_id: Optional[str] = None,
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    stmt = select(models.Evaluation).order_by(models.Evaluation.executed_at.desc())
    if agent_id:
        _check_node_scope(db, agent_id, entries)
        stmt = stmt.where(models.Evaluation.agent_id == agent_id)
    elif entries is not None:
        allowed = _visible_namespaces(db, entries)
        agent_ids = select(models.Node.id).where(models.Node.namespace.in_(allowed))
        stmt = stmt.where(models.Evaluation.agent_id.in_(agent_ids))
    return list(db.scalars(stmt))


# ---------- Cost metrics (LLM token usage) ----------

@app.get("/api/v1/llm-stats")
def llm_stats(
    llm_id: str,
    since: Optional[datetime] = None,
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    """Usage rollup for one model: invocations, tokens, cost, per-agent breakdown."""
    if db.get(models.Node, llm_id) is None:
        raise HTTPException(404, "llm not found")
    _check_node_scope(db, llm_id, entries)
    conditions = [models.LlmUsage.llm_id == llm_id]
    if since:
        conditions.append(models.LlmUsage.recorded_at >= since)
    rows = db.execute(
        select(
            models.LlmUsage.agent_id,
            func.count(),
            func.sum(models.LlmUsage.input_tokens),
            func.sum(models.LlmUsage.output_tokens),
            func.sum(models.LlmUsage.cost_usd),
        )
        .where(*conditions)
        .group_by(models.LlmUsage.agent_id)
    ).all()
    by_agent = [
        {
            "agent_id": aid,
            "agent_name": (db.get(models.Node, aid).name if db.get(models.Node, aid) else aid),
            "invocations": int(calls or 0),
            "input_tokens": int(inp or 0),
            "output_tokens": int(out or 0),
            "cost_usd": round(float(cost or 0), 4),
        }
        for aid, calls, inp, out, cost in rows
    ]
    return {
        "llm_id": llm_id,
        "invocations": sum(a["invocations"] for a in by_agent),
        "input_tokens": sum(a["input_tokens"] for a in by_agent),
        "output_tokens": sum(a["output_tokens"] for a in by_agent),
        "cost_usd": round(sum(a["cost_usd"] for a in by_agent), 4),
        "by_agent": by_agent,
    }


@app.get("/api/v1/namespaces")
def list_namespaces(db: Session = Depends(get_db), entries=Depends(rbac.scope)):
    """Distinct namespaces (account/region) present in the graph, limited to
    the caller's access scope."""
    rows = db.execute(
        select(models.Node.namespace, func.count()).group_by(models.Node.namespace)
    ).all()
    return [
        {"namespace": ns, "nodes": int(n)}
        for ns, n in rows
        if rbac.ns_allowed(ns, entries)
    ]


@app.get("/api/v1/costs/{agent_id:path}", response_model=AgentCost)
def agent_cost(
    agent_id: str,
    since: Optional[datetime] = None,
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    if db.get(models.Node, agent_id) is None:
        raise HTTPException(404, "agent not found")
    _check_node_scope(db, agent_id, entries)

    conditions = [models.LlmUsage.agent_id == agent_id]
    if since:
        conditions.append(models.LlmUsage.recorded_at >= since)
    rows = db.execute(
        select(
            models.LlmUsage.llm_id,
            func.sum(models.LlmUsage.input_tokens),
            func.sum(models.LlmUsage.output_tokens),
            func.sum(models.LlmUsage.cost_usd),
            func.count(),
        )
        .where(*conditions)
        .group_by(models.LlmUsage.llm_id)
    ).all()

    by_llm = [
        LlmCostBreakdown(
            llm_id=llm_id,
            llm_name=(db.get(models.Node, llm_id).name if db.get(models.Node, llm_id) else llm_id),
            input_tokens=int(inp or 0),
            output_tokens=int(out or 0),
            cost_usd=round(float(cost or 0), 4),
            call_count=int(calls or 0),
        )
        for llm_id, inp, out, cost, calls in rows
    ]
    run_count = db.scalar(
        select(func.count()).select_from(models.Run).where(models.Run.agent_id == agent_id)
    ) or 0
    return AgentCost(
        agent_id=agent_id,
        run_count=run_count,
        total_input_tokens=sum(b.input_tokens for b in by_llm),
        total_output_tokens=sum(b.output_tokens for b in by_llm),
        total_cost_usd=round(sum(b.cost_usd for b in by_llm), 4),
        by_llm=by_llm,
    )


# ---------- Cedar decision log ----------

@app.get("/api/v1/cedar-decisions", response_model=list[CedarDecisionOut])
def cedar_decisions(
    gateway_id: str,
    decision: Optional[str] = Query(default=None, pattern="^(ALLOW|DENY)$"),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    """Individual Cedar authorization decisions made by a gateway (audit drill-down)."""
    _check_node_scope(db, gateway_id, entries)
    stmt = (
        select(models.CedarDecision)
        .where(models.CedarDecision.gateway_id == gateway_id)
        .order_by(models.CedarDecision.decided_at.desc())
        .limit(limit)
    )
    if decision:
        stmt = stmt.where(models.CedarDecision.decision == decision)
    rows = list(db.scalars(stmt))
    name_of = {}
    for nid in {r.agent_id for r in rows} | {r.tool_id for r in rows}:
        node = db.get(models.Node, nid)
        name_of[nid] = node.name if node else nid
    return [
        CedarDecisionOut(
            id=r.id, run_id=r.run_id,
            agent_id=r.agent_id, agent_name=name_of[r.agent_id],
            tool_id=r.tool_id, tool_name=name_of[r.tool_id],
            decision=r.decision, policy_id=r.policy_id, decided_at=r.decided_at,
        )
        for r in rows
    ]


# ---------- Guardrail intervention log ----------

@app.get("/api/v1/guardrail-interventions", response_model=list[GuardrailInterventionOut])
def guardrail_interventions(
    guardrail_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    entries=Depends(rbac.scope),
):
    _check_node_scope(db, guardrail_id, entries)
    rows = list(db.scalars(
        select(models.GuardrailIntervention)
        .where(models.GuardrailIntervention.guardrail_id == guardrail_id)
        .order_by(models.GuardrailIntervention.occurred_at.desc())
        .limit(limit)
    ))
    def name(nid: Optional[str]) -> str:
        if not nid:
            return ""
        node = db.get(models.Node, nid)
        return node.name if node else nid
    return [
        GuardrailInterventionOut(
            id=r.id, run_id=r.run_id, agent_id=r.agent_id,
            agent_name=name(r.agent_id), llm_name=name(r.llm_id),
            action=r.action, category=r.category, occurred_at=r.occurred_at,
        )
        for r in rows
    ]


# ---------- Run timeline (audit drill-down) ----------

@app.get("/api/v1/runs/{run_id}/timeline")
def run_timeline(run_id: str, db: Session = Depends(get_db), entries=Depends(rbac.scope)):
    """Step-by-step trajectory of a run, reconstructed from raw lineage events."""
    run = db.get(models.Run, run_id)
    if run is not None:
        _check_node_scope(db, run.agent_id, entries)
    events = list(db.scalars(
        select(models.LineageEvent)
        .where(models.LineageEvent.run_id == run_id)
        .order_by(models.LineageEvent.event_time, models.LineageEvent.id)
    ))
    if not events:
        raise HTTPException(404, "run not found")
    cost, inp, out = _usage_by_run(db, [run_id]).get(run_id, (0.0, 0, 0))
    steps = []
    for ev in events:
        p = ev.payload or {}
        steps.append({
            "time": ev.event_time,
            "event_type": ev.event_type,
            "agent": (p.get("agent") or {}).get("name", ""),
            "on_behalf_of": (p.get("onBehalfOf") or {}).get("name"),
            "sub_agents": [s.get("name") for s in p.get("subAgents", [])],
            "tools": [t.get("name") for t in p.get("tools", [])],
            "gateway_calls": [
                {
                    "gateway": (c.get("gateway") or {}).get("name"),
                    "tool": (c.get("tool") or {}).get("name"),
                    "decision": c.get("decision", "ALLOW"),
                    "policy_id": c.get("policyId", ""),
                }
                for c in p.get("gatewayCalls", [])
            ],
            "guardrails": [
                {
                    "guardrail": (g.get("guardrail") or {}).get("name"),
                    "action": g.get("action", "PASSED"),
                    "category": g.get("category", ""),
                }
                for g in p.get("guardrailEvents", [])
            ],
            "llms": [
                {
                    "name": l.get("name"),
                    "input_tokens": l.get("inputTokens", 0),
                    "output_tokens": l.get("outputTokens", 0),
                }
                for l in p.get("llms", [])
            ],
            "resources": [r.get("name") for r in p.get("resources", [])],
            "run_facets": p.get("runFacets", {}),
            "error": p.get("error"),
        })

    # Collapse duplicate spans (e.g. client+server pairs) into one step with a
    # repeat counter: identical content within a 2-second window.
    def _sig(s: dict) -> str:
        import json as _json
        keys = ("event_type", "agent", "on_behalf_of", "sub_agents", "tools",
                "gateway_calls", "guardrails", "llms", "resources", "error")
        return _json.dumps({k: s[k] for k in keys}, sort_keys=True, default=str)

    collapsed: list[dict] = []
    for s in steps:
        if (
            collapsed
            and _sig(collapsed[-1]) == _sig(s)
            and abs((s["time"] - collapsed[-1]["time"]).total_seconds()) <= 2
        ):
            collapsed[-1]["repeat"] = collapsed[-1].get("repeat", 1) + 1
        else:
            s["repeat"] = 1
            collapsed.append(s)
    steps = collapsed

    return {
        "run_id": run_id,
        "cost_usd": round(float(cost or 0), 4),
        "input_tokens": int(inp or 0),
        "output_tokens": int(out or 0),
        "steps": steps,
    }


# ---------- Cost recompute ----------

@app.post("/api/v1/costs/recompute", dependencies=[Depends(rbac.require_admin)])
def recompute_costs(db: Session = Depends(get_db)):
    """Re-derive cost for usage rows that landed with $0 (e.g. ingested before
    pricing was known). Node `pricing_per_1k` facets win over the built-in catalog."""
    from . import pricing

    rows = list(db.scalars(
        select(models.LlmUsage).where(models.LlmUsage.cost_usd == 0)
    ))
    updated = 0
    total = 0.0
    for row in rows:
        llm = db.get(models.Node, row.llm_id)
        name = llm.name if llm else ""
        node_pricing = ((llm.facets or {}).get("pricing_per_1k") or {}) if llm else {}
        if node_pricing:
            cost = (
                row.input_tokens / 1000 * float(node_pricing.get("input_usd", 0))
                + row.output_tokens / 1000 * float(node_pricing.get("output_usd", 0))
            )
        else:
            cost = pricing.cost_for(name, row.input_tokens, row.output_tokens)
        if cost:
            row.cost_usd = round(cost, 6)
            updated += 1
            total += cost
    db.commit()
    return {"rows_checked": len(rows), "rows_updated": updated, "cost_added_usd": round(total, 4)}


# ---------- Namespace management ----------

@app.delete(
    "/api/v1/namespaces/{namespace:path}",
    dependencies=[Depends(rbac.require_admin)],
)
def delete_namespace(namespace: str, db: Session = Depends(get_db)):
    """Purge all lineage data for a namespace (e.g. the 'default' demo seed)."""
    from .purge import purge_namespace

    return purge_namespace(db, namespace)


# ---------- AWS account sync (real data) ----------

class AwsSyncRequest(BaseModel):
    region: str = "us-east-1"
    profile: Optional[str] = None
    role_arn: Optional[str] = None
    # Confused-deputy guard for cross-account AssumeRole. Defaults to the
    # deployment's SYNC_EXTERNAL_ID; override for locally-run syncs.
    external_id: Optional[str] = None


@app.post("/api/v1/aws/sync", dependencies=[Depends(rbac.require_admin)])
def aws_sync(req: AwsSyncRequest, db: Session = Depends(get_db)):
    """Pull real lineage data from an AWS account: AgentCore Runtime agents,
    Gateways + targets, Identity, Bedrock Guardrails, and Agent Registry records.
    Credentials come from a local profile or an assumable read-only role."""
    from .connectors.sync_all import sync_account

    try:
        return sync_account(
            db, req.region,
            profile=req.profile, role_arn=req.role_arn, external_id=req.external_id,
        )
    except Exception as e:  # credential/STS failures before any module ran
        raise HTTPException(400, f"AWS session failed: {type(e).__name__}: {e}")


# ---------- AgentCore Registry sync ----------

@app.post("/api/v1/registry/sync", dependencies=[Depends(rbac.require_admin)])
def sync_registry(db: Session = Depends(get_db)):
    """Pull agent / MCP server / skill records from AgentCore Registry and
    enrich lineage nodes with their catalog metadata."""
    return registry_sync.sync_registry(db)


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}
