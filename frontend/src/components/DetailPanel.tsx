import { useEffect, useState } from "react";
import {
  cloudWatchTraceUrl,
  fetchCedarDecisions,
  fetchCost,
  fetchEvaluations,
  fetchGuardrailInterventions,
  fetchLlmStats,
  fetchRuns,
  fetchRunTimeline,
} from "../api";
import {
  NODE_TYPE_META,
  type AgentCost,
  type CedarDecision,
  type Evaluation,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GuardrailIntervention,
  type LlmStats,
  type Run,
  type RunTimeline,
} from "../types";
import { CedarDecisionsExplorer } from "./CedarDecisionsExplorer";
import { EvaluationsExplorer } from "./EvaluationsExplorer";
import { GatewayToolsExplorer } from "./GatewayToolsExplorer";
import { RunsExplorer } from "./RunsExplorer";
import { RunTimelineView } from "./RunTimelineView";

interface Props {
  node: GraphNode;
  graph: Graph;
  since?: string;
  onFocus: (nodeId: string) => void;
}

type TabId = "overview" | "access" | "governance" | "usage";

const isScalar = (v: unknown) => v === null || typeof v !== "object";

const prettyKey = (k: string) => k.replace(/_/g, " ");

/** Render one facet value for readability:
 *  - multiline strings (Cedar policies) -> code block
 *  - ARNs / URLs -> monospace
 *  - arrays of scalars -> tag chips
 *  - flat objects -> nested key/value rows (no raw JSON)
 *  - deep objects -> pretty JSON as last resort */
function FacetValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.includes("\n")) return <pre className="facet-code">{value}</pre>;
    if (/^(arn:|https?:\/\/)/.test(value)) return <code className="mono-value">{value}</code>;
    return <span className="facet-scalar">{value}</span>;
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return (
      <span className="tag-row">
        {value.map((v, i) => (
          <span key={i} className="tag">{String(v)}</span>
        ))}
      </span>
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.every(([, v]) => isScalar(v))) {
      return (
        <dl className="nested-facets">
          {entries.map(([k, v]) => (
            <div key={k} className="nested-row">
              <dt>{prettyKey(k)}</dt>
              <dd><FacetValue value={v} /></dd>
            </div>
          ))}
        </dl>
      );
    }
    return <pre className="facet-code">{JSON.stringify(value, null, 2)}</pre>;
  }
  return <span className="facet-scalar">{String(value)}</span>;
}

function FacetTable({ facets }: { facets: Record<string, unknown> }) {
  const entries = Object.entries(facets);
  if (entries.length === 0) return null;
  return (
    <dl className="facet-table">
      {entries.map(([k, v]) => (
        <div key={k} className="facet-row">
          <dt>{prettyKey(k)}</dt>
          <dd><FacetValue value={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** Edge origin = declared (registry) vs observed (runtime events) vs both. */
const ORIGIN_META: Record<string, { label: string; title: string }> = {
  declared: {
    label: "declared, unused",
    title: "Access is declared in the registry but has never been observed at runtime. Candidate for least-privilege tightening.",
  },
  observed: {
    label: "⚠ undeclared",
    title: "Access was observed at runtime but is not declared in the registry. Possible drift or policy violation.",
  },
  both: {
    label: "declared ✓ observed",
    title: "Access is declared in the registry and confirmed by runtime traffic. Healthy state.",
  },
};

function OriginChip({ origin }: { origin: string }) {
  const meta = ORIGIN_META[origin] ?? { label: origin, title: origin };
  return (
    <span className={`origin origin-${origin}`} title={meta.title}>
      {meta.label}
    </span>
  );
}

function EdgeList({
  edges,
  direction,
  nameOf,
}: {
  edges: GraphEdge[];
  direction: "up" | "down";
  nameOf: (id: string) => string;
}) {
  return (
    <ul className="edge-list">
      {edges.map((e) => {
        const otherId = direction === "up" ? e.source : e.target;
        return (
          <li key={e.id} className="edge-item">
            <div className="edge-head">
              <span className="edge-arrow">{direction === "up" ? "←" : "→"}</span>
              <span className="edge-node-name">{nameOf(otherId)}</span>
              <span className="edge-type-badge">{e.edge_type.replace(/_/g, " ")}</span>
              <OriginChip origin={e.origin} />
              {e.call_count > 0 && <span className="count">{e.call_count} calls</span>}
            </div>
            {Object.keys(e.facets).length > 0 && (
              <dl className="nested-facets edge-detail">
                {Object.entries(e.facets).map(([k, v]) => (
                  <div key={k} className="nested-row">
                    <dt>{prettyKey(k)}</dt>
                    <dd><FacetValue value={v} /></dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DetailPanel({ node, graph, since, onFocus }: Props) {
  const meta = NODE_TYPE_META[node.node_type];
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [showExplorer, setShowExplorer] = useState(false);
  const [showEvalExplorer, setShowEvalExplorer] = useState(false);
  const [showCedarExplorer, setShowCedarExplorer] = useState(false);
  const [showToolsExplorer, setShowToolsExplorer] = useState(false);
  const [ownerRuns, setOwnerRuns] = useState<Run[]>([]);
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [cost, setCost] = useState<AgentCost | null>(null);
  const [decisions, setDecisions] = useState<CedarDecision[]>([]);
  const [llmStats, setLlmStats] = useState<LlmStats | null>(null);
  const [interventions, setInterventions] = useState<GuardrailIntervention[]>([]);
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<RunTimeline | null>(null);

  useEffect(() => {
    setShowAllDecisions(false);
    setTab("overview");
    setExpandedRun(null);
    setTimeline(null);
    setShowExplorer(false);
    setShowEvalExplorer(false);
    setShowCedarExplorer(false);
    setShowToolsExplorer(false);
    setOwnerRuns([]);
    if (node.node_type === "agent") {
      fetchRuns(node.id, { limit: 50, since }) // 50 for version stats; UI shows the latest 5
        .then((p) => { setRuns(p.runs); setRunsTotal(p.total); })
        .catch(() => { setRuns([]); setRunsTotal(0); });
      fetchEvaluations(node.id).then(setEvals).catch(() => setEvals([]));
      fetchCost(node.id, since).then(setCost).catch(() => setCost(null));
    } else {
      setRuns([]); setEvals([]); setCost(null); setRunsTotal(0);
    }
    if (node.node_type === "llm") {
      fetchLlmStats(node.id, since).then(setLlmStats).catch(() => setLlmStats(null));
    } else {
      setLlmStats(null);
    }
    if (node.node_type === "gateway") {
      fetchCedarDecisions(node.id).then(setDecisions).catch(() => setDecisions([]));
    } else {
      setDecisions([]);
    }
    if (node.node_type === "guardrail") {
      fetchGuardrailInterventions(node.id).then(setInterventions).catch(() => setInterventions([]));
    } else {
      setInterventions([]);
    }
  }, [node, since]);

  // Identity traceability: the owning agent's recent runs are the activity
  // record for this identity (every run executes under it).
  useEffect(() => {
    if (node.node_type !== "identity") {
      setOwnerRuns([]);
      return;
    }
    const ownerEdge = graph.edges.find(
      (e) => e.target === node.id && e.edge_type === "AUTHENTICATES_AS",
    );
    if (!ownerEdge) {
      setOwnerRuns([]);
      return;
    }
    fetchRuns(ownerEdge.source, { limit: 5, since })
      .then((p) => setOwnerRuns(p.runs))
      .catch(() => setOwnerRuns([]));
  }, [node, graph, since]);

  const toggleRun = (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      setTimeline(null);
      return;
    }
    setExpandedRun(runId);
    setTimeline(null);
    fetchRunTimeline(runId).then(setTimeline).catch(() => setTimeline(null));
  };

  const outgoing = graph.edges.filter((e) => e.source === node.id);
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const nameOf = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;
  // Registry, Cedar and data-lineage facets get dedicated sections; the rest is "Details".
  const SPECIAL_FACETS = ["cedar_policies", "registry", "data_lineage", "versions"];
  const generalFacets = Object.fromEntries(
    Object.entries(node.facets).filter(([k]) => !SPECIAL_FACETS.includes(k)),
  );

  // Version history: declared versions (prompt nodes) or versions observed across runs.
  const runVersions = new Map<string, { count: number; last: string | null }>();
  for (const r of runs) {
    const v = r.facets.agent_version;
    if (typeof v !== "string") continue;
    const cur = runVersions.get(v) ?? { count: 0, last: null };
    cur.count += 1;
    if (r.started_at && (!cur.last || r.started_at > cur.last)) cur.last = r.started_at;
    runVersions.set(v, cur);
  }

  const denyCount = decisions.filter((d) => d.decision === "DENY").length;
  const blockedCount = interventions.filter((i) => i.action !== "PASSED").length;
  const isGateway = node.node_type === "gateway";
  const isGuardrail = node.node_type === "guardrail";
  const isLlm = node.node_type === "llm";
  // Guardrails applied to this model (GUARDED_BY edges from this LLM).
  const guardedBy = outgoing.filter((e) => e.edge_type === "GUARDED_BY");
  // Only show tabs that have content for this node.
  const warn = denyCount > 0 ? ` ⚠${denyCount}` : blockedCount > 0 ? ` ⚠${blockedCount}` : "";
  const tabs: { id: TabId; label: string; show: boolean }[] = [
    { id: "overview", label: "Overview", show: true },
    { id: "access", label: `Access (${incoming.length + outgoing.length})`, show: incoming.length + outgoing.length > 0 },
    {
      id: "governance",
      label: `Governance${warn || (evals.length > 0 ? ` (${evals.length})` : "")}`,
      show: isGateway || isGuardrail || evals.length > 0 || (isLlm && guardedBy.length > 0),
    },
    {
      id: "usage",
      label: "Usage",
      show:
        (cost !== null && cost.by_llm.length > 0) ||
        runs.length > 0 ||
        (llmStats !== null && llmStats.invocations > 0),
    },
  ];

  return (
    <aside className="detail-panel">
      <div className="detail-header" style={{ borderColor: meta.color }}>
        <span className="detail-type" style={{ background: meta.color }}>
          {meta.icon} {meta.label}
        </span>
        <h2>{node.name}</h2>
        {node.description && <p className="detail-desc">{node.description}</p>}
        <button className="focus-btn" onClick={() => onFocus(node.id)}>
          Focus lineage on this node
        </button>
      </div>

      <div className="tab-bar" role="tablist" aria-label="Node details">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "usage" && cost && cost.by_llm.length > 0 && (
        <section>
          <h3>💰 Cost (LLM token usage)</h3>
          <div className="cost-summary">
            <div className="cost-big">${cost.total_cost_usd.toFixed(2)}</div>
            <div className="cost-sub">
              {cost.run_count} runs · {cost.total_input_tokens.toLocaleString()} in /{" "}
              {cost.total_output_tokens.toLocaleString()} out tokens
            </div>
          </div>
          <table className="cost-table">
            <thead>
              <tr><th>LLM</th><th>Calls</th><th>Tokens (in/out)</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {cost.by_llm.map((b) => (
                <tr key={b.llm_id}>
                  <td>{b.llm_name}</td>
                  <td>{b.call_count}</td>
                  <td>{b.input_tokens.toLocaleString()} / {b.output_tokens.toLocaleString()}</td>
                  <td>${b.cost_usd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "governance" && evals.some((e) => e.eval_type === "online") && (
        <section>
          <h3>📡 Online evaluations (continuous)</h3>
          <p className="hint run-hint">
            Online configs evaluate each invocation as it happens — the status
            below is the monitor's state, not a test result.
          </p>
          <ul className="eval-list">
            {evals
              .filter((e) => e.eval_type === "online")
              .map((ev) => (
                <li key={ev.id}>
                  <div>
                    <span className={`eval-status eval-${ev.status.toLowerCase()}`}>
                      {ev.status}
                    </span>{" "}
                    <b>{ev.name}</b>
                    {typeof ev.facets.avg_score === "number" && (
                      <span className="eval-score">
                        avg {(ev.facets.avg_score as number).toFixed(2)}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const last = ev.facets.last_result as
                      | { time: string; evaluator: string; score: number }
                      | undefined;
                    const count = ev.facets.recent_results_count as number | undefined;
                    if (last) {
                      return (
                        <small>
                          last result: <b>{last.score}</b>
                          {last.evaluator && <> ({last.evaluator})</>} ·{" "}
                          {new Date(last.time).toLocaleString()}
                          {typeof count === "number" && count > 1 && (
                            <> · {count} results in window</>
                          )}
                        </small>
                      );
                    }
                    const scanned = ev.facets.results_scanned as number | undefined;
                    const unparsed = ev.facets.unparsed_record_keys as string[] | undefined;
                    if (scanned && scanned > 0 && unparsed) {
                      return (
                        <small className="eval-notes">
                          {scanned} result records found but no scores parsed — record
                          keys: {unparsed.join(", ")}
                        </small>
                      );
                    }
                    return (
                      <small>
                        {runs.length > 0 && runs[0].started_at
                          ? `no eval results in window — last invocation ${new Date(runs[0].started_at).toLocaleString()}`
                          : "agent idle — no invocations to evaluate in the selected window"}
                      </small>
                    );
                  })()}
                  {typeof ev.facets.failure_reason === "string" && ev.facets.failure_reason && (
                    <small className="eval-notes"> · {ev.facets.failure_reason}</small>
                  )}
                  {typeof ev.facets.results_error === "string" && (
                    <small className="eval-notes"> · results: {ev.facets.results_error}</small>
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}

      {tab === "governance" && evals.length > 0 && (
        <button className="focus-btn eval-browse-btn" onClick={() => setShowEvalExplorer(true)}>
          Browse all evaluation results →
        </button>
      )}

      {showEvalExplorer && (
        <EvaluationsExplorer
          agentId={node.id}
          agentName={node.name}
          onClose={() => setShowEvalExplorer(false)}
        />
      )}

      {tab === "governance" && evals.some((e) => e.eval_type !== "online") && (
        <section>
          <h3>🧪 On-demand evaluations ({evals.filter((e) => e.eval_type !== "online").length})</h3>
          <ul className="eval-list">
            {evals
              .filter((e) => e.eval_type !== "online")
              .map((ev) => (
                <li key={ev.id}>
                  <div>
                    <span className={`eval-status eval-${ev.status.toLowerCase()}`}>{ev.status}</span>{" "}
                    <b>{ev.name}</b> <em className="eval-type">{ev.eval_type}</em>
                    {ev.score != null && (
                      <span className="eval-score">{(ev.score * 100).toFixed(0)}%</span>
                    )}
                  </div>
                  {ev.executed_at && (
                    <small>{new Date(ev.executed_at).toLocaleDateString()}</small>
                  )}
                  {typeof ev.facets.notes === "string" && (
                    <small className="eval-notes"> · {ev.facets.notes}</small>
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}

      {tab === "overview" &&
        node.facets.registry !== undefined &&
        typeof node.facets.registry === "object" && (
        <section>
          <h3>📇 AgentCore Registry record</h3>
          {(() => {
            const reg = node.facets.registry as Record<string, unknown>;
            const status = String(reg.status ?? "");
            return (
              <>
                {status && (
                  <span className={`reg-status reg-${status.toLowerCase()}`}>{status}</span>
                )}
                <FacetTable
                  facets={Object.fromEntries(
                    Object.entries(reg).filter(([k]) => k !== "status"),
                  )}
                />
              </>
            );
          })()}
        </section>
      )}

      {tab === "governance" &&
        isGateway &&
        node.facets.cedar_policies !== undefined &&
        typeof node.facets.cedar_policies === "object" && (
          <section>
            <h3>🛡️ Cedar policies enforced</h3>
            {Object.entries(node.facets.cedar_policies as Record<string, string>).map(
              ([policyId, policy]) => (
                <div key={policyId} className="cedar-policy">
                  <div className="cedar-policy-id">{policyId}</div>
                  <pre className="facet-code">{policy}</pre>
                </div>
              ),
            )}
          </section>
        )}

      {tab === "governance" && isGateway && (
        <section>
          <h3>🔧 Tools behind this gateway</h3>
          <button className="focus-btn" onClick={() => setShowToolsExplorer(true)}>
            Open tool catalog (
            {outgoing.filter((e) => e.edge_type === "ROUTES_TO").length}) →
          </button>
        </section>
      )}

      {showToolsExplorer && (
        <GatewayToolsExplorer
          gateway={node}
          graph={graph}
          onClose={() => setShowToolsExplorer(false)}
        />
      )}

      {tab === "governance" && isGateway && decisions.length > 0 && (
        <section>
          <h3>📜 Cedar decision log</h3>
          <div className="decision-summary">
            <span className="origin origin-both">
              {decisions.filter((d) => d.decision === "ALLOW").length} allowed
            </span>
            <span className="deny-chip">
              {decisions.filter((d) => d.decision === "DENY").length} denied
            </span>
            <button
              className="clear-all"
              onClick={() => setShowAllDecisions((v) => !v)}
            >
              {showAllDecisions ? "show denied only" : "show all"}
            </button>
          </div>
          <ul className="decision-list">
            {decisions
              .filter((d) => showAllDecisions || d.decision === "DENY")
              .slice(0, 5)
              .map((d) => (
                <li key={d.id}>
                  <span className={d.decision === "DENY" ? "deny-chip" : "allow-chip"}>
                    {d.decision}
                  </span>{" "}
                  <b>{d.agent_name}</b> → {d.tool_name}
                  <div className="decision-meta">
                    policy <code>{d.policy_id || "—"}</code> · run{" "}
                    <code>{d.run_id.slice(0, 8)}</code>
                    {d.decided_at && (
                      <> · {new Date(d.decided_at).toLocaleString()}</>
                    )}
                  </div>
                </li>
              ))}
          </ul>
          <button className="focus-btn eval-browse-btn" onClick={() => setShowCedarExplorer(true)}>
            Browse all {decisions.length} Cedar decisions →
          </button>
        </section>
      )}

      {showCedarExplorer && (
        <CedarDecisionsExplorer
          gatewayId={node.id}
          gatewayName={node.name}
          onClose={() => setShowCedarExplorer(false)}
        />
      )}

      {tab === "overview" && (runVersions.size > 0 || Array.isArray(node.facets.versions)) && (
        <section>
          <h3>🏷️ Version history</h3>
          {runVersions.size > 0 && (
            <ul>
              {[...runVersions.entries()]
                .sort((a, b) => b[0].localeCompare(a[0]))
                .map(([v, info], i) => (
                  <li key={v}>
                    <b>v{v.replace(/^v/, "")}</b>
                    {i === 0 && <span className="tag" style={{ marginLeft: 6 }}>current</span>}
                    <span className="count"> {info.count} runs</span>
                    {info.last && (
                      <small> · last {new Date(info.last).toLocaleDateString()}</small>
                    )}
                  </li>
                ))}
            </ul>
          )}
          {Array.isArray(node.facets.versions) && (
            <ul>
              {(node.facets.versions as Record<string, string>[]).map((v, i) => (
                <li key={v.version}>
                  <b>{v.version}</b>
                  {i === 0 && <span className="tag" style={{ marginLeft: 6 }}>current</span>}
                  <small> · {v.date} · {v.author}</small>
                  <div className="decision-meta">{v.summary}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "overview" &&
        node.facets.data_lineage !== undefined &&
        typeof node.facets.data_lineage === "object" && (
          <section>
            <h3>🔗 Data lineage (OpenLineage)</h3>
            <FacetTable
              facets={Object.fromEntries(
                Object.entries(node.facets.data_lineage as Record<string, unknown>).filter(
                  ([k]) => k !== "lineage_url",
                ),
              )}
            />
            {typeof (node.facets.data_lineage as Record<string, unknown>).lineage_url ===
              "string" &&
              (() => {
                const url = String(
                  (node.facets.data_lineage as Record<string, unknown>).lineage_url,
                );
                const isPlaceholder = url.includes(".internal") || url.includes("example.com");
                // Facet values are ingested data: only render as a link for
                // http(s) schemes (blocks javascript:/data: stored XSS).
                const isSafeUrl = /^https?:\/\//i.test(url);
                return (
                  <>
                    {isSafeUrl && (
                      <a
                        className="lineage-open-btn"
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open dataset lineage in catalog ↗
                      </a>
                    )}
                    <code className="mono-value">{url}</code>
                    {isPlaceholder && (
                      <div className="hint">
                        Demo placeholder host — point the resource's{" "}
                        <code>data_lineage.lineage_url</code> facet at your real
                        Marquez / DataZone catalog to make this link resolve.
                      </div>
                    )}
                  </>
                );
              })()}
          </section>
        )}

      {tab === "usage" && isLlm && llmStats && llmStats.invocations > 0 && (
        <section>
          <h3>💰 Model usage</h3>
          <div className="cost-summary">
            <div className="cost-big">${llmStats.cost_usd.toFixed(2)}</div>
            <div className="cost-sub">
              {llmStats.invocations.toLocaleString()} invocations ·{" "}
              {llmStats.input_tokens.toLocaleString()} in /{" "}
              {llmStats.output_tokens.toLocaleString()} out tokens
            </div>
          </div>
          <table className="cost-table">
            <thead>
              <tr><th>Agent</th><th>Calls</th><th>Tokens (in/out)</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {llmStats.by_agent.map((a) => (
                <tr key={a.agent_id}>
                  <td>{a.agent_name}</td>
                  <td>{a.invocations}</td>
                  <td>
                    {a.input_tokens.toLocaleString()} / {a.output_tokens.toLocaleString()}
                  </td>
                  <td>${a.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "governance" && isLlm && guardedBy.length > 0 && (
        <section>
          <h3>🚧 Guardrails applied to this model</h3>
          <ul>
            {guardedBy.map((e) => (
              <li key={e.id}>
                <b>{nameOf(e.target)}</b>
                <OriginChip origin={e.origin} />
                {e.call_count > 0 && <span className="count">{e.call_count} checks</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "governance" && isGuardrail && interventions.length > 0 && (
        <section>
          <h3>🚧 Guardrail intervention log</h3>
          <div className="decision-summary">
            <span className="origin origin-both">
              {interventions.filter((i) => i.action === "PASSED").length} passed
            </span>
            <span className="deny-chip">{blockedCount} intervened</span>
          </div>
          <ul className="decision-list">
            {interventions
              .filter((i) => i.action !== "PASSED")
              .slice(0, 25)
              .map((i) => (
                <li key={i.id}>
                  <span className="deny-chip">{i.action}</span>{" "}
                  <b>{i.agent_name}</b>
                  {i.llm_name && <> → {i.llm_name}</>}
                  {i.category && <span className="tag" style={{ marginLeft: 6 }}>{i.category}</span>}
                  <div className="decision-meta">
                    run <code>{i.run_id.slice(0, 8)}</code>
                    {i.occurred_at && <> · {new Date(i.occurred_at).toLocaleString()}</>}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}

      {tab === "overview" && node.node_type === "identity" && (
        <section>
          <h3>🪪 Identity traceability</h3>
          <dl className="nested-facets">
            <div className="nested-row">
              <dt>identity type</dt>
              <dd>
                {String(node.facets.provider ?? "workload identity")}
                {typeof node.facets.kind === "string" && <> · {node.facets.kind}</>}
              </dd>
            </div>
            {(() => {
              const ownerEdge = incoming.find((e) => e.edge_type === "AUTHENTICATES_AS");
              return (
                <div className="nested-row">
                  <dt>assumed by</dt>
                  <dd>
                    {ownerEdge ? (
                      <>
                        🤖 <b>{nameOf(ownerEdge.source)}</b>
                        <OriginChip origin={ownerEdge.origin} />
                      </>
                    ) : (
                      "no owner linked — registry/system identity"
                    )}
                  </dd>
                </div>
              );
            })()}
            <div className="nested-row">
              <dt>credentials used</dt>
              <dd>
                {outgoing.filter((e) => e.edge_type === "USES_CREDENTIAL").length > 0 ? (
                  <span className="tag-row">
                    {outgoing
                      .filter((e) => e.edge_type === "USES_CREDENTIAL")
                      .map((e) => (
                        <span key={e.id} className="tag">🔑 {nameOf(e.target)}</span>
                      ))}
                  </span>
                ) : (
                  "none from the credential vault"
                )}
              </dd>
            </div>
            <div className="nested-row">
              <dt>last exercised</dt>
              <dd>
                {ownerRuns.length > 0 && ownerRuns[0].started_at
                  ? new Date(ownerRuns[0].started_at).toLocaleString()
                  : "no activity in the selected window"}
              </dd>
            </div>
          </dl>
          {ownerRuns.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Recent activity under this identity</h3>
              <ul>
                {ownerRuns.map((r) => (
                  <li key={r.run_id}>
                    <span className={`run-state run-${r.state.toLowerCase()}`}>{r.state}</span>{" "}
                    <code>{r.run_id.slice(0, 8)}</code>
                    {r.started_at && <small> {new Date(r.started_at).toLocaleString()}</small>}
                    <span className="run-cost">${r.cost_usd.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {tab === "overview" && Object.keys(generalFacets).length > 0 && (
        <section>
          <h3>Details</h3>
          <FacetTable facets={generalFacets} />
        </section>
      )}

      {tab === "access" && incoming.length > 0 && (
        <section>
          <h3>Upstream ({incoming.length})</h3>
          <EdgeList edges={incoming} direction="up" nameOf={nameOf} />
        </section>
      )}

      {tab === "access" && outgoing.length > 0 && (
        <section>
          <h3>Downstream ({outgoing.length})</h3>
          <EdgeList edges={outgoing} direction="down" nameOf={nameOf} />
        </section>
      )}

      {tab === "usage" && runs.length > 0 && (
        <section>
          <h3>Recent runs — click for trajectory</h3>
          <p className="hint run-hint">
            A run = one end-to-end agent invocation (session); sub-agent activity
            shares the same run ID.
          </p>
          <ul>
            {runs.slice(0, 5).map((r) => (
              <li key={r.run_id}>
                <button className="run-row" onClick={() => toggleRun(r.run_id)}>
                  <span className={`run-state run-${r.state.toLowerCase()}`}>{r.state}</span>{" "}
                  <code>{r.run_id.slice(0, 8)}</code>
                  {typeof r.facets.agent_version === "string" && (
                    <span className="tag">v{String(r.facets.agent_version)}</span>
                  )}
                  <span className="run-cost">${r.cost_usd.toFixed(3)}</span>
                  <span className="expand-caret">{expandedRun === r.run_id ? "▾" : "▸"}</span>
                </button>
                {expandedRun === r.run_id &&
                  (timeline ? (
                    <RunTimelineView
                      timeline={timeline}
                      traceUrl={cloudWatchTraceUrl(node.id, r.run_id)}
                    />
                  ) : (
                    <p className="hint">loading trajectory…</p>
                  ))}
              </li>
            ))}
          </ul>
          <button className="focus-btn" onClick={() => setShowExplorer(true)}>
            Browse all {runsTotal.toLocaleString()} runs →
          </button>
        </section>
      )}

      {showExplorer && (
        <RunsExplorer
          agentId={node.id}
          agentName={node.name}
          since={since}
          onClose={() => setShowExplorer(false)}
        />
      )}
    </aside>
  );
}
