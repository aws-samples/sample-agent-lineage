"""Graph queries: full graph or BFS neighborhood around a node (both directions)."""
from collections import deque
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models
from .schemas import Graph, GraphEdge, GraphNode


def _to_graph(nodes: list[models.Node], edges: list[models.Edge]) -> Graph:
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


def _scope_filter(
    nodes: list[models.Node],
    edges: list[models.Edge],
    ns_allowed,
) -> tuple[list[models.Node], list[models.Edge]]:
    """Drop nodes outside the caller's namespace scope and edges touching them."""
    if ns_allowed is None:
        return nodes, edges
    nodes = [n for n in nodes if ns_allowed(n.namespace)]
    ids = {n.id for n in nodes}
    edges = [e for e in edges if e.source_id in ids and e.target_id in ids]
    return nodes, edges


def get_graph(
    db: Session,
    node_ids: Optional[list[str]] = None,
    depth: int = 5,
    ns_allowed=None,  # Optional[Callable[[str], bool]]; None = unrestricted
) -> Graph:
    all_edges = list(db.scalars(select(models.Edge)))

    if not node_ids:
        nodes = list(db.scalars(select(models.Node)))
        nodes, all_edges = _scope_filter(nodes, all_edges, ns_allowed)
        return _to_graph(nodes, all_edges)

    # Directional lineage traversal (Marquez-style), not an undirected
    # neighborhood: downstream follows outgoing edges (everything the focus
    # uses), upstream follows incoming edges (everything that can reach it).
    # Undirected BFS would leak through shared hubs — e.g. focus -> gateway ->
    # every other agent using that gateway.
    downstream: dict[str, list[models.Edge]] = {}
    upstream: dict[str, list[models.Edge]] = {}
    for e in all_edges:
        downstream.setdefault(e.source_id, []).append(e)
        upstream.setdefault(e.target_id, []).append(e)

    visited = set(node_ids)
    kept_edges: dict[int, models.Edge] = {}

    def walk(adjacency: dict[str, list[models.Edge]], forward: bool) -> None:
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
