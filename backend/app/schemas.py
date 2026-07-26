"""Pydantic schemas for the API and the lineage event spec."""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

NodeType = Literal[
    "user_group", "agent", "skill", "prompt", "identity", "credential",
    "gateway", "guardrail", "tool", "llm", "resource",
]
EdgeType = Literal[
    "INVOKES", "DELEGATES_TO", "HAS_SKILL", "USES_PROMPT", "AUTHENTICATES_AS",
    "USES_CREDENTIAL", "GRANTS_ACCESS_TO", "USES_TOOL", "CALLS_LLM",
    "ACCESSES", "ROUTES_TO", "GUARDED_BY",
]


def node_id(namespace: str, node_type: str, name: str) -> str:
    return f"{node_type}:{namespace}/{name}"


# ---------- Registry (declared lineage) ----------

class NodeIn(BaseModel):
    namespace: str = "default"
    node_type: NodeType
    name: str
    description: str = ""
    facets: dict = Field(default_factory=dict)


class NodeOut(NodeIn):
    id: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class EdgeIn(BaseModel):
    source_id: str
    target_id: str
    edge_type: EdgeType
    facets: dict = Field(default_factory=dict)


class EdgeOut(EdgeIn):
    id: int
    origin: str
    call_count: int
    last_observed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------- Lineage events (observed lineage) ----------

class EntityRef(BaseModel):
    """Reference to an entity in an event; auto-registered if unknown."""
    node_type: NodeType
    name: str
    namespace: str = "default"
    facets: dict = Field(default_factory=dict)

    @property
    def id(self) -> str:
        return node_id(self.namespace, self.node_type, self.name)


class LLMUsageRef(EntityRef):
    """LLM reference with token usage for cost tracking (OTel GenAI attributes)."""
    node_type: Literal["llm"] = "llm"
    input_tokens: int = Field(default=0, alias="inputTokens")
    output_tokens: int = Field(default=0, alias="outputTokens")
    cost_usd: float = Field(default=0.0, alias="costUsd")

    model_config = {"populate_by_name": True}


class GatewayCall(BaseModel):
    """A tool invocation routed through an AgentCore Gateway, with the Cedar
    authorization decision the gateway made."""
    gateway: EntityRef
    tool: EntityRef
    decision: Literal["ALLOW", "DENY"] = "ALLOW"
    policy_id: str = Field(default="", alias="policyId")

    model_config = {"populate_by_name": True}


class GuardrailEvent(BaseModel):
    """A guardrail decision on model traffic within a run."""
    guardrail: EntityRef
    llm: Optional[EntityRef] = None
    action: Literal["BLOCKED", "MASKED", "PASSED"] = "PASSED"
    category: str = ""


class AgentRunEvent(BaseModel):
    """OpenLineage-inspired run event, mappable from OTel GenAI / OpenInference spans.

    eventType semantics:
      START    - agent run started (on_behalf_of = invoking user group)
      ACCESS   - agent touched tools / llms / resources / sub-agents mid-run
      COMPLETE / FAIL - run finished
    """
    event_type: Literal["START", "ACCESS", "COMPLETE", "FAIL"] = Field(alias="eventType")
    event_time: datetime = Field(alias="eventTime")
    run_id: str = Field(alias="runId")
    producer: str = ""
    agent: EntityRef
    on_behalf_of: Optional[EntityRef] = Field(default=None, alias="onBehalfOf")
    sub_agents: list[EntityRef] = Field(default_factory=list, alias="subAgents")
    tools: list[EntityRef] = Field(default_factory=list)
    gateway_calls: list[GatewayCall] = Field(default_factory=list, alias="gatewayCalls")
    guardrail_events: list[GuardrailEvent] = Field(default_factory=list, alias="guardrailEvents")
    llms: list[LLMUsageRef] = Field(default_factory=list)
    resources: list[EntityRef] = Field(default_factory=list)
    run_facets: dict = Field(default_factory=dict, alias="runFacets")
    # Failure details for this step: {"where": "tool:x"|"llm:y"|"agent", "type", "message"}
    error: Optional[dict] = None

    model_config = {"populate_by_name": True}


class RunOut(BaseModel):
    run_id: str
    agent_id: str
    state: str
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    facets: dict = Field(default_factory=dict)
    # Per-run LLM usage rollup.
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0

    model_config = {"from_attributes": True}


class RunsPage(BaseModel):
    total: int
    runs: list[RunOut]


# ---------- Graph API ----------

class GraphNode(BaseModel):
    id: str
    node_type: str
    name: str
    namespace: str
    description: str = ""
    facets: dict = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: int
    source: str
    target: str
    edge_type: str
    origin: str
    call_count: int
    last_observed_at: Optional[datetime] = None
    facets: dict = Field(default_factory=dict)


class Graph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


# ---------- Evaluations, cost & catalog ----------

class EvaluationIn(BaseModel):
    agent_id: str
    name: str
    eval_type: str
    status: str
    score: Optional[float] = None
    executed_at: Optional[datetime] = None
    facets: dict = Field(default_factory=dict)


class EvaluationOut(EvaluationIn):
    id: int

    model_config = {"from_attributes": True}


class LlmCostBreakdown(BaseModel):
    llm_id: str
    llm_name: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    call_count: int


class AgentCost(BaseModel):
    agent_id: str
    run_count: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    by_llm: list[LlmCostBreakdown]


class GuardrailInterventionOut(BaseModel):
    id: int
    run_id: str
    agent_id: str
    agent_name: str
    llm_name: str = ""
    action: str
    category: str
    occurred_at: Optional[datetime] = None


class CedarDecisionOut(BaseModel):
    id: int
    run_id: str
    agent_id: str
    agent_name: str
    tool_id: str
    tool_name: str
    decision: str
    policy_id: str
    decided_at: Optional[datetime] = None


# ---------- RBAC: identity & access requests ----------

class MeOut(BaseModel):
    """Who am I: role and account scope, for the frontend to shape the UI."""
    auth_enabled: bool
    role: Literal["admin", "viewer"]
    email: str = ""
    # None/absent list semantics flattened for the UI: admins get all
    # namespaces; viewers get only those matching their grants.
    allowed_entries: list[str] = Field(default_factory=list)  # raw grant entries
    namespaces: list[str] = Field(default_factory=list)       # visible namespaces


class AccessRequestIn(BaseModel):
    account_name: str = Field(min_length=1, max_length=200)
    account_id: str = Field(pattern=r"^\d{12}$")
    reason: str = Field(min_length=1, max_length=2000)


class AccessRequestOut(BaseModel):
    id: int
    requester_email: str
    account_name: str
    account_id: str
    reason: str
    status: str
    created_at: Optional[datetime] = None
    decided_at: Optional[datetime] = None
    decided_by: str = ""

    model_config = {"from_attributes": True}


class AgentCatalogEntry(BaseModel):
    """One row in the AgentCore registry catalog search."""
    id: str
    name: str
    namespace: str
    description: str
    engine: str = ""
    facets: dict = Field(default_factory=dict)
    run_count: int = 0
    eval_count: int = 0
    total_cost_usd: float = 0.0
