"""Event ingestion: turn AgentRunEvents into graph upserts (idempotent)."""
from datetime import datetime
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models, pricing
from .schemas import AgentRunEvent, EntityRef, node_id


def upsert_node(db: Session, ref: EntityRef) -> models.Node:
    node = db.get(models.Node, ref.id)
    if node is None:
        node = models.Node(
            id=ref.id,
            namespace=ref.namespace,
            node_type=ref.node_type,
            name=ref.name,
            facets=ref.facets or {},
        )
        db.add(node)
        # Flush immediately so a second upsert of the same id within this
        # transaction finds the row instead of double-inserting (PK collision).
        db.flush()
    elif ref.facets:
        node.facets = {**(node.facets or {}), **ref.facets}
    return node


def upsert_edge(
    db: Session,
    source_id: str,
    target_id: str,
    edge_type: str,
    origin: str,
    observed_at: Optional[datetime] = None,
    facets: Optional[dict] = None,
) -> models.Edge:
    edge = db.scalar(
        select(models.Edge).where(
            models.Edge.source_id == source_id,
            models.Edge.target_id == target_id,
            models.Edge.edge_type == edge_type,
        )
    )
    if edge is None:
        edge = models.Edge(
            source_id=source_id,
            target_id=target_id,
            edge_type=edge_type,
            origin=origin,
            facets=facets or {},
        )
        db.add(edge)
    else:
        if edge.origin != origin:
            edge.origin = "both"
        if facets:
            edge.facets = {**(edge.facets or {}), **facets}
    if origin == "observed":
        edge.call_count = (edge.call_count or 0) + 1
        edge.last_observed_at = observed_at
    return edge


def backfill_run_participants(db: Session) -> int:
    """One-time: derive run participation from stored raw events for data
    ingested before run_participants existed. No-op once the table has rows
    (new events record participants at ingest). Returns rows added."""
    if db.scalar(select(func.count()).select_from(models.RunParticipant)):
        return 0
    known = set(db.scalars(select(models.Node.id).where(models.Node.node_type == "agent")))
    pairs: set[tuple[str, str]] = set()
    for run_id, payload in db.execute(
        select(models.LineageEvent.run_id, models.LineageEvent.payload)
        .where(models.LineageEvent.run_id.is_not(None))
    ):
        p = payload or {}
        for ref in [p.get("agent") or {}, *(p.get("subAgents") or [])]:
            if ref.get("name"):
                aid = node_id(ref.get("namespace") or "default", "agent", ref["name"])
                if aid in known:
                    pairs.add((run_id, aid))
    db.add_all(models.RunParticipant(run_id=r, agent_id=a) for r, a in pairs)
    db.commit()
    return len(pairs)


def ingest_event(db: Session, event: AgentRunEvent) -> models.Run:
    # Store the raw event for audit / replay.
    db.add(
        models.LineageEvent(
            event_time=event.event_time,
            event_type=event.event_type,
            run_id=event.run_id,
            producer=event.producer,
            payload=event.model_dump(mode="json", by_alias=True),
        )
    )

    agent = upsert_node(db, event.agent)

    # Run lifecycle.
    run = db.get(models.Run, event.run_id)
    if run is None:
        run = models.Run(run_id=event.run_id, agent_id=agent.id, facets=event.run_facets or {})
        db.add(run)
    if event.run_facets:
        run.facets = {**(run.facets or {}), **event.run_facets}

    # A trace (run) can carry several agent spans arriving in any order:
    # keep the earliest start and the latest end so duration stays truthful.
    def _naive(dt: datetime) -> datetime:
        return dt.replace(tzinfo=None) if dt.tzinfo else dt

    if event.event_type == "START":
        if run.started_at is None or _naive(event.event_time) < _naive(run.started_at):
            run.started_at = event.event_time
        if run.state not in ("COMPLETE", "FAIL"):
            run.state = "RUNNING"
        # Version fallback: if neither the event nor prior events carried the
        # agent version, stamp the agent node's current runtime version.
        if "agent_version" not in (run.facets or {}):
            node_version = (agent.facets or {}).get("version")
            if node_version:
                run.facets = {**(run.facets or {}), "agent_version": str(node_version)}
    elif event.event_type in ("COMPLETE", "FAIL"):
        if run.ended_at is None or _naive(event.event_time) > _naive(run.ended_at):
            run.ended_at = event.event_time
        run.state = event.event_type
    # Any step's failure details roll up onto the run for quick triage.
    if event.error:
        run.facets = {**(run.facets or {}), "error": event.error}

    # Observed edges.
    ts = event.event_time
    if event.on_behalf_of:
        group = upsert_node(db, event.on_behalf_of)
        upsert_edge(db, group.id, agent.id, "INVOKES", "observed", ts)
        # Stamp the caller onto the run so cost/usage can be attributed per
        # calling user group / OAuth client (see /api/v1/costs/by-caller).
        if "caller" not in (run.facets or {}):
            run.facets = {**(run.facets or {}), "caller": group.name, "caller_id": group.id}
    for ref, edge_type in (
        *[(r, "DELEGATES_TO") for r in event.sub_agents],
        *[(r, "USES_TOOL") for r in event.tools],
        *[(r, "CALLS_LLM") for r in event.llms],
        *[(r, "ACCESSES") for r in event.resources],
    ):
        target = upsert_node(db, ref)
        upsert_edge(db, agent.id, target.id, edge_type, "observed", ts)

    # Run participation: the acting agent and any agent it delegates to, so a
    # sub-agent's runs are listable from the sub-agent itself.
    for participant_id in {agent.id, *(r.id for r in event.sub_agents)}:
        if db.get(models.RunParticipant, (event.run_id, participant_id)) is None:
            db.add(models.RunParticipant(run_id=event.run_id, agent_id=participant_id))

    # Gateway-routed tool calls with Cedar decisions.
    # agent -> gateway edge accumulates ALLOW/DENY counts; the gateway -> tool
    # ROUTES_TO edge is only observed when the Cedar policy allowed the call.
    for call in event.gateway_calls:
        gw = upsert_node(db, call.gateway)
        tool = upsert_node(db, call.tool)
        agent_gw = upsert_edge(db, agent.id, gw.id, "USES_TOOL", "observed", ts)
        facets = dict(agent_gw.facets or {})
        key = "cedar_allow_count" if call.decision == "ALLOW" else "cedar_deny_count"
        facets[key] = int(facets.get(key, 0)) + 1
        if call.policy_id:
            facets["last_policy_id"] = call.policy_id
        if call.decision == "DENY":
            facets["last_denied_at"] = ts.isoformat()
        agent_gw.facets = facets
        if call.decision == "ALLOW":
            upsert_edge(db, gw.id, tool.id, "ROUTES_TO", "observed", ts)
        # Audit log: every individual decision is queryable later.
        db.add(
            models.CedarDecision(
                run_id=event.run_id,
                agent_id=agent.id,
                gateway_id=gw.id,
                tool_id=tool.id,
                decision=call.decision,
                policy_id=call.policy_id,
                decided_at=ts,
            )
        )

    # Guardrail decisions on model traffic.
    for ge in event.guardrail_events:
        guardrail = upsert_node(db, ge.guardrail)
        llm_id = None
        if ge.llm:
            llm_node = upsert_node(db, ge.llm)
            llm_id = llm_node.id
            upsert_edge(db, llm_node.id, guardrail.id, "GUARDED_BY", "observed", ts)
        db.add(
            models.GuardrailIntervention(
                run_id=event.run_id,
                agent_id=agent.id,
                guardrail_id=guardrail.id,
                llm_id=llm_id,
                action=ge.action,
                category=ge.category,
                occurred_at=ts,
            )
        )

    # Token usage -> cost metrics. If the emitter didn't provide cost, derive it
    # from the LLM node's pricing facet: {"pricing_per_1k": {"input_usd": x, "output_usd": y}}.
    for llm_ref in event.llms:
        if llm_ref.input_tokens or llm_ref.output_tokens or llm_ref.cost_usd:
            cost = llm_ref.cost_usd
            if not cost:
                llm_node = db.get(models.Node, llm_ref.id)
                node_pricing = ((llm_node.facets or {}).get("pricing_per_1k") or {}) if llm_node else {}
                if node_pricing:
                    cost = (
                        llm_ref.input_tokens / 1000 * float(node_pricing.get("input_usd", 0))
                        + llm_ref.output_tokens / 1000 * float(node_pricing.get("output_usd", 0))
                    )
                else:
                    # Built-in catalog fallback, matched by model-id substring.
                    cost = pricing.cost_for(
                        llm_ref.name, llm_ref.input_tokens, llm_ref.output_tokens
                    )
            db.add(
                models.LlmUsage(
                    run_id=event.run_id,
                    agent_id=agent.id,
                    llm_id=llm_ref.id,
                    input_tokens=llm_ref.input_tokens,
                    output_tokens=llm_ref.output_tokens,
                    cost_usd=round(cost, 6),
                    recorded_at=ts,
                )
            )

    db.commit()
    db.refresh(run)
    return run
