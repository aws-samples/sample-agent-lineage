"""Graph queries: full graph or BFS neighborhood around a node (both directions).

Optionally scoped to a time window [since, until]. Edges carry cumulative,
all-time traffic (call_count, last_observed_at), so a window cannot be read
off the edge rows. Instead the raw lineage_events inside the window are
replayed through the same edge derivation ingest.py uses, and each edge is
re-stated for that window:

- observed-only edge with no traffic in the window  -> dropped
- declared+observed edge with no traffic in window  -> shown as declared (unused in window)
- any edge with traffic in the window               -> call_count / last_observed_at
                                                       / Cedar counts for the window only

Declared edges reflect CURRENT configuration: config history is not stored,
so the window scopes runtime traffic, not what was declared at the time.
"""
from collections import deque
from datetime import datetime
from types import SimpleNamespace
from typing import Optional

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .schemas import AgentRunEvent, Graph, GraphEdge, GraphNode

EdgeKey = tuple[str, str, str]  # (source_id, target_id, edge_type)


def _to_graph(nodes: list, edges: list) -> Graph:
    return Graph(
        nodes=[
            GraphNode(
                id=n.id,
                node_type=n.node_type,
                name=n.name,
                namespace=n.namespace,
                description=n.description or "",
                facets=n.facets or {},
            )
            for n in nodes
        ],
        edges=[
            GraphEdge(
                id=e.id,
                source=e.source_id,
                target=e.target_id,
                edge_type=e.edge_type,
                origin=e.origin,
                call_count=e.call_count or 0,
                last_observed_at=e.last_observed_at,
                facets=e.facets or {},
            )
            for e in edges
        ],
    )


def _scope_filter(nodes: list, edges: list, ns_allowed) -> tuple[list, list]:
    """Drop nodes outside the caller's namespace scope and edges touching them."""
    if ns_allowed is None:
        return nodes, edges
    nodes = [n for n in nodes if ns_allowed(n.namespace)]
    ids = {n.id for n in nodes}
    edges = [e for e in edges if e.source_id in ids and e.target_id in ids]
    return nodes, edges


# ---------------------------------------------------------------- window ----

class _Traffic:
    __slots__ = ("count", "last", "allow", "deny")

    def __init__(self) -> None:
        self.count = 0
        self.last: Optional[datetime] = None
        self.allow = 0
        self.deny = 0


def observed_in_window(
    db: Session, since: Optional[datetime], until: Optional[datetime]
) -> dict[EdgeKey, _Traffic]:
    """Observed traffic per edge inside [since, until], replayed from the raw
    lineage_events with the same edge derivation as ingest.ingest_event."""
    stmt = select(models.LineageEvent)
    if since:
        stmt = stmt.where(models.LineageEvent.event_time >= since)
    if until:
        stmt = stmt.where(models.LineageEvent.event_time <= until)

    traffic: dict[EdgeKey, _Traffic] = {}

    def hit(key: EdgeKey, ts: datetime) -> _Traffic:
        t = traffic.get(key)
        if t is None:
            t = traffic[key] = _Traffic()
        t.count += 1
        if t.last is None or ts > t.last:
            t.last = ts
        return t

    for row in db.scalars(stmt):
        try:
            ev = AgentRunEvent.model_validate(row.payload)
        except ValidationError:
            continue  # malformed historic payload: skip, never fail the read
        ts = row.event_time
        agent = ev.agent.id
        if ev.on_behalf_of:
            hit((ev.on_behalf_of.id, agent, "INVOKES"), ts)
        for ref, edge_type in (
            *[(r, "DELEGATES_TO") for r in ev.sub_agents],
            *[(r, "USES_TOOL") for r in ev.tools],
            *[(r, "CALLS_LLM") for r in ev.llms],
            *[(r, "ACCESSES") for r in ev.resources],
        ):
            hit((agent, ref.id, edge_type), ts)
        for call in ev.gateway_calls:
            t = hit((agent, call.gateway.id, "USES_TOOL"), ts)
            if call.decision == "ALLOW":
                t.allow += 1
                hit((call.gateway.id, call.tool.id, "ROUTES_TO"), ts)
            else:
                t.deny += 1
        for ge in ev.guardrail_events:
            if ge.llm:
                hit((ge.llm.id, ge.guardrail.id, "GUARDED_BY"), ts)
    return traffic


def _apply_window(edges: list, traffic: dict[EdgeKey, _Traffic]) -> list:
    """Re-state each edge for the window. Returns detached copies; the ORM
    rows are never mutated (a read must not dirty the session)."""
    out = []
    for e in edges:
        t = traffic.get((e.source_id, e.target_id, e.edge_type))
        facets = dict(e.facets or {})
        if t is None:
            if e.origin == "observed":
                continue  # no traffic in window and nothing declares it
            origin, count, last = "declared", 0, None
            facets.pop("cedar_allow_count", None)
            facets.pop("cedar_deny_count", None)
        else:
            origin, count, last = e.origin, t.count, t.last
            if t.allow or t.deny or "cedar_allow_count" in facets or "cedar_deny_count" in facets:
                facets["cedar_allow_count"] = t.allow
                facets["cedar_deny_count"] = t.deny
        out.append(SimpleNamespace(
            id=e.id, source_id=e.source_id, target_id=e.target_id,
            edge_type=e.edge_type, origin=origin, call_count=count,
            last_observed_at=last, facets=facets,
        ))
    return out


# ----------------------------------------------------------------- query ----

def get_graph(
    db: Session,
    node_ids: Optional[list[str]] = None,
    depth: int = 5,
    ns_allowed=None,  # Optional[Callable[[str], bool]]; None = unrestricted
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
) -> Graph:
    all_edges: list = list(db.scalars(select(models.Edge)))
    windowed = since is not None or until is not None
    if windowed:
        original = all_edges
        all_edges = _apply_window(all_edges, observed_in_window(db, since, until))

    if not node_ids:
        nodes = list(db.scalars(select(models.Node)))
        if windowed:
            # A node whose every edge fell outside the window had no role in
            # it (observed-only traffic elsewhere in time): leave it out.
            # Nodes with no edges at all are unaffected by the window.
            had_edges = {x for e in original for x in (e.source_id, e.target_id)}
            has_edges = {x for e in all_edges for x in (e.source_id, e.target_id)}
            nodes = [n for n in nodes if n.id not in had_edges or n.id in has_edges]
        nodes, all_edges = _scope_filter(nodes, all_edges, ns_allowed)
        return _to_graph(nodes, all_edges)

    # Directional lineage traversal (Marquez-style), not an undirected
    # neighborhood: downstream follows outgoing edges (everything the focus
    # uses), upstream follows incoming edges (everything that can reach it).
    # Undirected BFS would leak through shared hubs — e.g. focus -> gateway ->
    # every other agent using that gateway. In a window, traversal runs over
    # the windowed edges, so out-of-window observed paths are not followed.
    downstream: dict[str, list] = {}
    upstream: dict[str, list] = {}
    for e in all_edges:
        downstream.setdefault(e.source_id, []).append(e)
        upstream.setdefault(e.target_id, []).append(e)

    visited = set(node_ids)
    kept_edges: dict[int, object] = {}

    def walk(adjacency: dict[str, list], forward: bool) -> None:
        queue = deque([(nid, 0) for nid in node_ids])
        seen = set(node_ids)
        while queue:
            current, d = queue.popleft()
            if d >= depth:
                continue
            for e in adjacency.get(current, []):
                kept_edges[e.id] = e
                nxt = e.target_id if forward else e.source_id
                visited.add(nxt)
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append((nxt, d + 1))

    walk(downstream, forward=True)
    walk(upstream, forward=False)

    nodes = list(db.scalars(select(models.Node).where(models.Node.id.in_(visited))))
    nodes, edges = _scope_filter(nodes, list(kept_edges.values()), ns_allowed)
    return _to_graph(nodes, edges)
