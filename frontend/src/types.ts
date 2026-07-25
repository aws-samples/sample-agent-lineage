export type NodeType =
  | "user_group"
  | "agent"
  | "skill"
  | "prompt"
  | "identity"
  | "credential"
  | "gateway"
  | "guardrail"
  | "tool"
  | "llm"
  | "resource";

export interface GraphNode {
  id: string;
  node_type: NodeType;
  name: string;
  namespace: string;
  description: string;
  facets: Record<string, unknown>;
}

export interface GraphEdge {
  id: number;
  source: string;
  target: string;
  edge_type: string;
  origin: "declared" | "observed" | "both";
  call_count: number;
  last_observed_at: string | null;
  facets: Record<string, unknown>;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A run = one end-to-end agent invocation (a session/task execution);
 *  all sub-agent activity shares the same runId. */
export interface Run {
  run_id: string;
  agent_id: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  facets: Record<string, unknown>;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface RunsPage {
  total: number;
  runs: Run[];
}

export interface CatalogEntry {
  id: string;
  node_type: NodeType;
  name: string;
  namespace: string;
  description: string;
  engine: string;
  run_count: number;
  eval_count: number;
  total_cost_usd: number;
}

export interface Evaluation {
  id: number;
  agent_id: string;
  name: string;
  eval_type: string;
  status: string;
  score: number | null;
  executed_at: string | null;
  facets: Record<string, unknown>;
}

export interface LlmCostBreakdown {
  llm_id: string;
  llm_name: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  call_count: number;
}

export interface CedarDecision {
  id: number;
  run_id: string;
  agent_id: string;
  agent_name: string;
  tool_id: string;
  tool_name: string;
  decision: "ALLOW" | "DENY";
  policy_id: string;
  decided_at: string | null;
}

export interface GuardrailIntervention {
  id: number;
  run_id: string;
  agent_id: string;
  agent_name: string;
  llm_name: string;
  action: "BLOCKED" | "MASKED" | "PASSED";
  category: string;
  occurred_at: string | null;
}

export interface RunTimelineStep {
  time: string;
  event_type: string;
  agent: string;
  on_behalf_of: string | null;
  sub_agents: string[];
  tools: string[];
  gateway_calls: { gateway: string; tool: string; decision: string; policy_id: string }[];
  guardrails: { guardrail: string; action: string; category: string }[];
  llms: { name: string; input_tokens: number; output_tokens: number }[];
  resources: string[];
  run_facets: Record<string, unknown>;
  repeat?: number;
  error?: { where?: string; type?: string; message?: string; stacktrace?: string } | null;
}

export interface RunTimeline {
  run_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  steps: RunTimelineStep[];
}

export interface LlmAgentUsage {
  agent_id: string;
  agent_name: string;
  invocations: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface LlmStats {
  llm_id: string;
  invocations: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  by_agent: LlmAgentUsage[];
}

export interface NamespaceInfo {
  namespace: string;
  nodes: number;
}

export interface AgentCost {
  agent_id: string;
  run_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  by_llm: LlmCostBreakdown[];
}

/** Visual config per node type; column enforces the left-to-right story. */
export const NODE_TYPE_META: Record<
  NodeType,
  { label: string; color: string; icon: string; column: number }
> = {
  user_group: { label: "User Group", color: "#8b5cf6", icon: "👥", column: 0 },
  agent: { label: "Agent", color: "#2563eb", icon: "🤖", column: 1 },
  skill: { label: "Skill", color: "#db2777", icon: "🎯", column: 2 },
  prompt: { label: "Prompt", color: "#6366f1", icon: "📝", column: 2 },
  identity: { label: "Identity", color: "#0d9488", icon: "🪪", column: 2 },
  credential: { label: "Credential", color: "#ca8a04", icon: "🔑", column: 3 },
  gateway: { label: "Gateway", color: "#0891b2", icon: "🛡️", column: 2 },
  guardrail: { label: "Guardrail", color: "#e11d48", icon: "🚧", column: 4 },
  tool: { label: "Tool", color: "#059669", icon: "🔧", column: 3 },
  llm: { label: "LLM", color: "#d97706", icon: "🧠", column: 3 },
  resource: { label: "Resource", color: "#dc2626", icon: "🗄️", column: 4 },
};
