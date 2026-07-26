import type {
  AccessRequest,
  AgentCost,
  CatalogEntry,
  CedarDecision,
  Evaluation,
  Graph,
  GuardrailIntervention,
  LlmStats,
  MeInfo,
  NamespaceInfo,
  RunsPage,
  RunTimeline,
} from "./types";

import { clearToken, getToken } from "./auth";

const BASE = "/api/v1";

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    // Session expired — clear and reload to trigger the login redirect.
    clearToken();
    window.location.reload();
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    handleUnauthorized(res);
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface AwsSyncResult {
  account_id: string;
  region: string;
  namespace: string;
  modules: Record<string, { ok: boolean; error?: string; [k: string]: unknown }>;
}

export async function syncAws(body: {
  region: string;
  profile?: string;
  role_arn?: string;
}): Promise<AwsSyncResult> {
  const res = await fetch(`${BASE}/aws/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    handleUnauthorized(res);
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<AwsSyncResult>;
}

export function fetchGraph(
  nodeIds: string[] = [],
  depth = 5,
  namespace?: string,
): Promise<Graph> {
  const params = new URLSearchParams();
  nodeIds.forEach((id) => params.append("node_id", id));
  params.set("depth", String(depth));
  if (namespace) params.set("namespace", namespace);
  return get<Graph>(`/lineage/graph?${params}`);
}

export function fetchRuns(
  agentId?: string,
  opts: { state?: string; limit?: number; offset?: number; since?: string } = {},
): Promise<RunsPage> {
  const params = new URLSearchParams();
  if (agentId) params.set("agent_id", agentId);
  if (opts.state) params.set("state", opts.state);
  if (opts.since) params.set("since", opts.since);
  params.set("limit", String(opts.limit ?? 25));
  params.set("offset", String(opts.offset ?? 0));
  return get<RunsPage>(`/runs?${params}`);
}

export function fetchLlmStats(llmId: string, since?: string): Promise<LlmStats> {
  const params = new URLSearchParams({ llm_id: llmId });
  if (since) params.set("since", since);
  return get<LlmStats>(`/llm-stats?${params}`);
}

export function fetchNamespaces(): Promise<NamespaceInfo[]> {
  return get<NamespaceInfo[]>(`/namespaces`);
}

/** Deep link to the CloudWatch trace view for a real (span-derived) run.
 *  Returns null for demo runs (UUIDs) or nodes without an account/region
 *  namespace. Trace IDs are converted to X-Ray format (1-xxxxxxxx-...). */
export function cloudWatchTraceUrl(nodeId: string, runId: string): string | null {
  const nsParts = (nodeId.split(":")[1] ?? "").split("/");
  if (nsParts.length < 3) return null; // "default" namespace — demo data
  const region = nsParts[1];
  if (!/^[0-9a-f]{32}$/i.test(runId)) return null; // not an OTel trace id
  const xrayId = `1-${runId.slice(0, 8)}-${runId.slice(8)}`;
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#xray:traces/${xrayId}`;
}

export function fetchCatalog(q?: string, namespace?: string): Promise<CatalogEntry[]> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (namespace) params.set("namespace", namespace);
  const qs = params.toString();
  return get<CatalogEntry[]>(`/search${qs ? `?${qs}` : ""}`);
}

// ---------- RBAC: identity & access requests ----------

export function fetchMe(): Promise<MeInfo> {
  return get<MeInfo>(`/me`);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    handleUnauthorized(res);
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function submitAccessRequest(body: {
  account_name: string;
  account_id: string;
  reason: string;
}): Promise<AccessRequest> {
  return post<AccessRequest>(`/access-requests`, body);
}

export function fetchAccessRequests(): Promise<AccessRequest[]> {
  return get<AccessRequest[]>(`/access-requests`);
}

export function decideAccessRequest(
  id: number,
  action: "approve" | "reject",
): Promise<AccessRequest> {
  return post<AccessRequest>(`/access-requests/${id}/decision`, { action });
}

export function fetchEvaluations(agentId: string): Promise<Evaluation[]> {
  return get<Evaluation[]>(`/evaluations?agent_id=${encodeURIComponent(agentId)}`);
}

export function fetchCost(agentId: string, since?: string): Promise<AgentCost> {
  const params = since ? `?since=${encodeURIComponent(since)}` : "";
  return get<AgentCost>(`/costs/${agentId}${params}`);
}

export function fetchGuardrailInterventions(
  guardrailId: string,
): Promise<GuardrailIntervention[]> {
  return get<GuardrailIntervention[]>(
    `/guardrail-interventions?guardrail_id=${encodeURIComponent(guardrailId)}`,
  );
}

export function fetchRunTimeline(runId: string): Promise<RunTimeline> {
  return get<RunTimeline>(`/runs/${encodeURIComponent(runId)}/timeline`);
}

export function fetchCedarDecisions(
  gatewayId: string,
  decision?: "ALLOW" | "DENY",
): Promise<CedarDecision[]> {
  const params = new URLSearchParams({ gateway_id: gatewayId });
  if (decision) params.set("decision", decision);
  return get<CedarDecision[]>(`/cedar-decisions?${params}`);
}
