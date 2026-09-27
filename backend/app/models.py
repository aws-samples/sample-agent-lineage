"""Property-graph model: nodes, typed edges, runs and raw lineage events.

Design follows the OpenLineage pattern (small core + JSON facets) adapted to agents:
- Node types: user_group | agent | tool | llm | resource (sub-agents are agents).
- Edge types: INVOKES, DELEGATES_TO, USES_TOOL, CALLS_LLM, ACCESSES.
- Every edge records whether it is 'declared' (registry) or 'observed' (runtime events),
  plus call counts, enabling declared-vs-observed drift analysis.
"""
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

NODE_TYPES = (
    "user_group", "agent", "skill", "prompt", "identity", "credential",
    "gateway", "guardrail", "tool", "llm", "resource",
)
EDGE_TYPES = (
    "INVOKES", "DELEGATES_TO", "HAS_SKILL", "USES_PROMPT", "AUTHENTICATES_AS",
    "USES_CREDENTIAL", "GRANTS_ACCESS_TO", "USES_TOOL", "CALLS_LLM",
    "ACCESSES", "ROUTES_TO", "GUARDED_BY",
)
EDGE_ORIGINS = ("declared", "observed", "both")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Node(Base):
    __tablename__ = "nodes"
    __table_args__ = (UniqueConstraint("namespace", "node_type", "name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)  # e.g. "agent:default/support-orchestrator"
    namespace: Mapped[str] = mapped_column(String, default="default")
    node_type: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    facets: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Edge(Base):
    __tablename__ = "edges"
    __table_args__ = (UniqueConstraint("source_id", "target_id", "edge_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    edge_type: Mapped[str] = mapped_column(String)
    origin: Mapped[str] = mapped_column(String, default="declared")  # declared | observed | both
    call_count: Mapped[int] = mapped_column(Integer, default=0)
    last_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    facets: Mapped[dict] = mapped_column(JSON, default=dict)


class Run(Base):
    __tablename__ = "runs"

    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    state: Mapped[str] = mapped_column(String, default="RUNNING")  # RUNNING | COMPLETE | FAIL
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    facets: Mapped[dict] = mapped_column(JSON, default=dict)


class CedarDecision(Base):
    """Every Cedar authorization decision a gateway made, for audit drill-down."""
    __tablename__ = "cedar_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String, index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    gateway_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    tool_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"))
    decision: Mapped[str] = mapped_column(String)  # ALLOW | DENY
    policy_id: Mapped[str] = mapped_column(String, default="")
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GuardrailIntervention(Base):
    """Guardrail decisions on model traffic (blocked / masked / passed), for audit."""
    __tablename__ = "guardrail_interventions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String, index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    guardrail_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    llm_id: Mapped[str | None] = mapped_column(ForeignKey("nodes.id"), nullable=True)
    action: Mapped[str] = mapped_column(String)  # BLOCKED | MASKED | PASSED
    category: Mapped[str] = mapped_column(String, default="")  # e.g. pii, prompt-injection
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Evaluation(Base):
    """AgentCore Evaluations executed against an agent (trajectory, correctness, safety...)."""
    __tablename__ = "evaluations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    eval_type: Mapped[str] = mapped_column(String)   # trajectory | correctness | safety | latency | custom
    status: Mapped[str] = mapped_column(String)      # PASSED | FAILED | RUNNING
    score: Mapped[float | None] = mapped_column(nullable=True)  # 0.0 - 1.0
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    facets: Mapped[dict] = mapped_column(JSON, default=dict)


class LlmUsage(Base):
    """Per-run, per-LLM token usage; aggregated into agent cost metrics."""
    __tablename__ = "llm_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String, index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    llm_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(default=0.0)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AccessRequest(Base):
    """A viewer's request for access to an AWS account's lineage data.

    Requests are immutable history: rejected requests stay rejected and the
    viewer files a new one. Approval appends the account id to the requester's
    Cognito custom:allowed_namespaces attribute.
    """
    __tablename__ = "access_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requester_sub: Mapped[str] = mapped_column(String, index=True)
    requester_username: Mapped[str] = mapped_column(String, default="")
    requester_email: Mapped[str] = mapped_column(String, default="")
    account_name: Mapped[str] = mapped_column(String)
    account_id: Mapped[str] = mapped_column(String)  # 12-digit AWS account id
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="pending")  # pending | approved | rejected
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decided_by: Mapped[str] = mapped_column(String, default="")  # admin email/username


class RunParticipant(Base):
    """Every agent that took part in a run: the root agent that emitted START
    and each delegated sub-agent. A run row is keyed to its root agent only,
    so without this a sub-agent's activity (which lives inside the root's run)
    was invisible from the sub-agent's own view."""
    __tablename__ = "run_participants"

    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), primary_key=True, index=True)


class LineageEvent(Base):
    """Raw event storage for audit / replay (OpenLineage-style)."""
    __tablename__ = "lineage_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    event_type: Mapped[str] = mapped_column(String)  # START | COMPLETE | FAIL | ACCESS
    run_id: Mapped[str | None] = mapped_column(String, index=True, nullable=True)
    producer: Mapped[str] = mapped_column(String, default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
