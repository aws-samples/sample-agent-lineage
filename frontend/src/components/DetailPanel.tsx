import { useEffect, useId, useState } from "react";
import {
  cloudWatchTraceUrl,
  fetchCallerCosts,
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
  type CallerCosts,
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
import { GuardrailInterventionsExplorer } from "./GuardrailInterventionsExplorer";
import { RunsExplorer } from "./RunsExplorer";
import { RunTimelineView } from "./RunTimelineView";
import { Icon } from "./Icon";
import { AnimatePresence, m } from "motion/react";
import { AnimatedNumber, TabPill, usd2 } from "./Motion";

interface Props {
  node: GraphNode;
  graph: Graph;
  since?: string;
  until?: string;
  onFocus: (nodeId: string) => void;
  onClose?: () => void;
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
    label: "undeclared",
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
      {origin === "observed" && <Icon name="alert" size={10} />}
      {meta.label}
    </span>
  );
}

/** Least-privilege read of a set of edges at a glance. */
function AccessSummary({ edges }: { edges: GraphEdge[] }) {
  const count = (o: string) => edges.filter((e) => e.origin === o).length;
  const both = count("both"), declared = count("declared"), observed = count("observed");
  return (
    <div className="access-summary">
      {both > 0 && (
        <span className="origin origin-both" title={ORIGIN_META.both.title}>
          {both} declared ✓ observed
        </span>
      )}
      {declared > 0 && (
        <span className="origin origin-declared" title={ORIGIN_META.declared.title}>
          {declared} declared, unused
        </span>
      )}
      {observed > 0 && (
        <span className="origin origin-observed" title={ORIGIN_META.observed.title}>
          <Icon name="alert" size={11} /> {observed} undeclared
        </span>
      )}
    </div>
  );
}

/** Undeclared (drift) first, then confirmed, then unused declarations. */
const ORIGIN_RANK: Record<string, number> = { observed: 0, both: 1, declared: 2 };

function EdgeList({
  edges,
  direction,
  nameOf,
}: {
  edges: GraphEdge[];
  direction: "up" | "down";
  nameOf: (id: string) => string;
}) {
  // Group by relationship type so the badge reads once per group instead of
  // repeating on every row; largest groups first.
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const list = groups.get(e.edge_type) ?? [];
    list.push(e);
    groups.set(e.edge_type, list);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  return (
    <>
      {ordered.map(([edgeType, group]) => (
        <div key={edgeType} className="edge-group">
          <h4 className="edge-group-title">
            {edgeType.replace(/_/g, " ")} <span className="count">({group.length})</span>
          </h4>
          <ul className="edge-list">
            {[...group]
              .sort(
                (a, b) =>
                  (ORIGIN_RANK[a.origin] ?? 3) - (ORIGIN_RANK[b.origin] ?? 3) ||
                  b.call_count - a.call_count,
              )
              .map((e) => {
                const otherId = direction === "up" ? e.source : e.target;
                return (
                  <li key={e.id} className="edge-item">
                    <div className="edge-head">
                      <span className="edge-arrow">{direction === "up" ? "←" : "→"}</span>
                      <span className="edge-node-name">{nameOf(otherId)}</span>
                      <OriginChip origin={e.origin} />
                      {e.call_count > 0 && <span className="count">{e.call_count} calls</span>}
                    </div>
                    {(e.last_observed_at || Object.keys(e.facets).length > 0) && (
                      <div className="edge-meta">
                        {e.last_observed_at && (
                          <span className="edge-last-seen">
                            last observed {new Date(e.last_observed_at).toLocaleString()}
                          </span>
                        )}
                        {Object.keys(e.facets).length > 0 && (
                          <details className="edge-facets">
                            <summary>details</summary>
                            <dl className="nested-facets edge-detail">
                              {Object.entries(e.facets).map(([k, v]) => (
                                <div key={k} className="nested-row">
                                  <dt>{prettyKey(k)}</dt>
                                  <dd><FacetValue value={v} /></dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </>
  );
}

export function DetailPanel({ node, graph, since, until, onFocus, onClose }: Props) {
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
  const [callerCosts, setCallerCosts] = useState<CallerCosts | null>(null);
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const [showAllInterventions, setShowAllInterventions] = useState(false);
  const [showInterventionsExplorer, setShowInterventionsExplorer] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const tabGroup = useId(); // scopes the sliding tab pill to this panel
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<RunTimeline | null>(null);

  // UI state resets only when a different node is opened — changing the time
  // window keeps the user on their current tab and view.
  useEffect(() => {
    setShowAllDecisions(false);
    setShowAllInterventions(false);
    setTab("overview");
    setShowExplorer(false);
    setShowEvalExplorer(false);
    setShowCedarExplorer(false);
    setShowToolsExplorer(false);
    setShowInterventionsExplorer(false);
  }, [node]);

  // Data follows the node AND the time window.
  useEffect(() => {
    setExpandedRun(null); // an expanded run may not exist in the new window
    setTimeline(null);
    setOwnerRuns([]);
    const win = { since, until };
    if (node.node_type === "agent") {
      fetchRuns(node.id, { limit: 50, ...win }) // 50 for version stats; UI shows the latest 5
        .then((p) => { setRuns(p.runs); setRunsTotal(p.total); })
        .catch(() => { setRuns([]); setRunsTotal(0); });
      fetchEvaluations(node.id).then(setEvals).catch(() => setEvals([]));
      fetchCost(node.id, win).then(setCost).catch(() => setCost(null));
    } else {
      setRuns([]); setEvals([]); setCost(null); setRunsTotal(0);
    }
    if (node.node_type === "llm") {
      fetchLlmStats(node.id, win).then(setLlmStats).catch(() => setLlmStats(null));
    } else {
      setLlmStats(null);
    }
    if (node.node_type === "gateway") {
      fetchCedarDecisions(node.id, undefined, win).then(setDecisions).catch(() => setDecisions([]));
    } else {
      setDecisions([]);
    }
    if (node.node_type === "guardrail") {
      // Match the explorer's window (backend max) so summary counts agree.
      fetchGuardrailInterventions(node.id, 500, win).then(setInterventions).catch(() => setInterventions([]));
    } else {
      setInterventions([]);
    }
    // Caller attribution: who spends through this agent / what this calling
    // client (e.g. Entra ID app registration) spends, per agent.
    if (node.node_type === "agent") {
      fetchCallerCosts({ agentId: node.id, ...win }).then(setCallerCosts).catch(() => setCallerCosts(null));
    } else if (node.node_type === "user_group") {
      fetchCallerCosts({ caller: node.name, ...win }).then(setCallerCosts).catch(() => setCallerCosts(null));
    } else {
      setCallerCosts(null);
    }
  }, [node, since, until]);

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
    fetchRuns(ownerEdge.source, { limit: 5, since, until })
      .then((p) => setOwnerRuns(p.runs))
      .catch(() => setOwnerRuns([]));
  }, [node, graph, since, until]);

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
        (llmStats !== null && llmStats.invocations > 0) ||
        (callerCosts !== null && callerCosts.callers.length > 0),
    },
  ];

  return (
    <m.aside
      className="detail-panel"
      aria-label={`${meta.label} details`}
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10, transition: { duration: 0.14 } }}
      transition={{ duration: 0.22 }}
    >
      {/* Header + tabs pin together as ONE sticky unit, so the tab bar always
          sits directly beneath the header regardless of its height and no
          content can scroll up between them. */}
      <div className="detail-pinned">
      <div className="detail-header" style={{ borderTopColor: meta.color }}>
        <div className="detail-header-row">
          <span className="detail-type" style={{ color: meta.color }}>
            <Icon name={meta.icon} size={12} /> {meta.label}
          </span>
          {onClose && (
            <button className="panel-close" aria-label="Close details" onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
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
            {tab === t.id && <TabPill layoutId={`${tabGroup}-pill`} />}
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </div>
      </div>{/* /detail-pinned */}

      {tab === "usage" && cost && cost.by_llm.length > 0 && (
        <section>
          <h3><Icon name="cost" /> Cost (LLM token usage)</h3>
          <div className="cost-summary">
            <div className="cost-big"><AnimatedNumber value={cost.total_cost_usd} format={usd2} /></div>
            <div className="cost-sub">
              <AnimatedNumber value={cost.run_count} /> runs ·{" "}
              <AnimatedNumber value={cost.total_input_tokens} /> in /{" "}
              <AnimatedNumber value={cost.total_output_tokens} /> out tokens
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
          <h3><Icon name="signal" /> Online evaluations (continuous)</h3>
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

      <AnimatePresence>
        {showEvalExplorer && (
          <EvaluationsExplorer
            agentId={node.id}
            agentName={node.name}
            onClose={() => setShowEvalExplorer(false)}
          />
        )}
      </AnimatePresence>

      {tab === "governance" && evals.some((e) => e.eval_type !== "online") && (
        <section>
          <h3><Icon name="flask" /> On-demand evaluations ({evals.filter((e) => e.eval_type !== "online").length})</h3>
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
          <h3><Icon name="card" /> AgentCore Registry record</h3>
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
            <h3><Icon name="gateway" /> Cedar policies enforced</h3>
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
          <h3><Icon name="tool" /> Tools behind this gateway</h3>
          <button className="focus-btn" onClick={() => setShowToolsExplorer(true)}>
            Open tool catalog (
            {outgoing.filter((e) => e.edge_type === "ROUTES_TO").length}) →
          </button>
        </section>
      )}

      <AnimatePresence>
        {showToolsExplorer && (
          <GatewayToolsExplorer
            gateway={node}
            graph={graph}
            onClose={() => setShowToolsExplorer(false)}
          />
        )}
      </AnimatePresence>

      {tab === "governance" && isGateway && decisions.length > 0 && (
        <section>
          <h3><Icon name="scroll" /> Cedar decision log</h3>
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

      <AnimatePresence>
        {showCedarExplorer && (
          <CedarDecisionsExplorer
            gatewayId={node.id}
            gatewayName={node.name}
            since={since}
            until={until}
            onClose={() => setShowCedarExplorer(false)}
          />
        )}
      </AnimatePresence>

      {tab === "overview" && (runVersions.size > 0 || Array.isArray(node.facets.versions)) && (
        <section>
          <h3><Icon name="tag" /> Version history</h3>
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
            <h3><Icon name="link" /> Data lineage (OpenLineage)</h3>
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

      {tab === "usage" && node.node_type === "agent" && callerCosts && callerCosts.callers.length > 0 && (
        <section>
          <h3><Icon name="users" /> Cost by caller</h3>
          <p className="hint run-hint">
            Which user groups / OAuth clients this agent's spend is attributable
            to, from the caller claim on each run.
          </p>
          <table className="cost-table">
            <thead>
              <tr><th>Caller</th><th>Runs</th><th>Tokens (in/out)</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {callerCosts.callers.map((c) => (
                <tr key={c.caller}>
                  <td>{c.caller}</td>
                  <td>{c.run_count}</td>
                  <td>{c.input_tokens.toLocaleString()} / {c.output_tokens.toLocaleString()}</td>
                  <td>${c.cost_usd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === "usage" && node.node_type === "user_group" && callerCosts && callerCosts.callers.length > 0 && (
        <section>
          <h3><Icon name="cost" /> Cost incurred by this caller</h3>
          {(() => {
            const me = callerCosts.callers[0];
            return (
              <>
                <div className="cost-summary">
                  <div className="cost-big"><AnimatedNumber value={me.cost_usd} format={usd2} /></div>
                  <div className="cost-sub">
                    <AnimatedNumber value={me.run_count} /> runs ·{" "}
                    <AnimatedNumber value={me.input_tokens} /> in /{" "}
                    <AnimatedNumber value={me.output_tokens} /> out tokens
                  </div>
                </div>
                <table className="cost-table">
                  <thead>
                    <tr><th>Agent</th><th>Runs</th><th>Tokens (in/out)</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {me.by_agent.map((a) => (
                      <tr key={a.agent_id}>
                        <td>{a.agent_name}</td>
                        <td>{a.run_count}</td>
                        <td>{a.input_tokens.toLocaleString()} / {a.output_tokens.toLocaleString()}</td>
                        <td>${a.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            );
          })()}
        </section>
      )}

      {tab === "usage" && isLlm && llmStats && llmStats.invocations > 0 && (
        <section>
          <h3><Icon name="cost" /> Model usage</h3>
          <div className="cost-summary">
            <div className="cost-big"><AnimatedNumber value={llmStats.cost_usd} format={usd2} /></div>
            <div className="cost-sub">
              <AnimatedNumber value={llmStats.invocations} /> invocations ·{" "}
              <AnimatedNumber value={llmStats.input_tokens} /> in /{" "}
              <AnimatedNumber value={llmStats.output_tokens} /> out tokens
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
          <h3><Icon name="guardrail" /> Guardrails applied to this model</h3>
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
          <h3><Icon name="guardrail" /> Guardrail intervention log</h3>
          <div className="decision-summary">
            <span className="deny-chip">
              {interventions.filter((i) => i.action === "BLOCKED").length} blocked
            </span>
            <span className="mask-chip">
              {interventions.filter((i) => i.action === "MASKED").length} masked
            </span>
            <span className="allow-chip">
              {interventions.filter((i) => i.action === "PASSED").length} passed
            </span>
            <button
              className="clear-all"
              onClick={() => setShowAllInterventions((v) => !v)}
            >
              {showAllInterventions ? "interventions only" : "show all checks"}
            </button>
          </div>
          {(() => {
            // Category breakdown of interventions: what this guardrail is
            // actually catching (pii, prompt-injection, ...).
            const byCategory = new Map<string, number>();
            for (const i of interventions) {
              if (i.action === "PASSED" || !i.category) continue;
              byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + 1);
            }
            if (byCategory.size === 0) return null;
            return (
              <div className="tag-row category-breakdown">
                {[...byCategory.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([cat, n]) => (
                    <span key={cat} className="tag">{cat} × {n}</span>
                  ))}
              </div>
            );
          })()}
          <ul className="decision-list">
            {interventions
              .filter((i) => showAllInterventions || i.action !== "PASSED")
              .slice(0, 5)
              .map((i) => (
                <li key={i.id}>
                  <span
                    className={
                      i.action === "PASSED" ? "allow-chip"
                      : i.action === "MASKED" ? "mask-chip"
                      : "deny-chip"
                    }
                  >
                    {i.action}
                  </span>{" "}
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
          <button
            className="focus-btn eval-browse-btn"
            onClick={() => setShowInterventionsExplorer(true)}
          >
            Browse all {interventions.length} guardrail checks →
          </button>
        </section>
      )}

      <AnimatePresence>
        {showInterventionsExplorer && (
          <GuardrailInterventionsExplorer
            guardrailId={node.id}
            guardrailName={node.name}
            since={since}
            until={until}
            onClose={() => setShowInterventionsExplorer(false)}
          />
        )}
      </AnimatePresence>

      {tab === "overview" && node.node_type === "identity" && (
        <section>
          <h3><Icon name="identity" /> Identity traceability</h3>
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
                        <Icon name="agent" size={13} /> <b>{nameOf(ownerEdge.source)}</b>
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
                        <span key={e.id} className="tag"><Icon name="credential" size={11} />{nameOf(e.target)}</span>
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

      {tab === "access" && (incoming.length > 0 || outgoing.length > 0) && (
        <AccessSummary edges={[...incoming, ...outgoing]} />
      )}

      {tab === "access" && incoming.length > 0 && (
        <section>
          <h3>← Upstream ({incoming.length}) — what reaches this node</h3>
          <EdgeList edges={incoming} direction="up" nameOf={nameOf} />
        </section>
      )}

      {tab === "access" && outgoing.length > 0 && (
        <section>
          <h3>→ Downstream ({outgoing.length}) — what this node uses</h3>
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

      <AnimatePresence>
        {showExplorer && (
          <RunsExplorer
            agentId={node.id}
            agentName={node.name}
            since={since}
            until={until}
            onClose={() => setShowExplorer(false)}
          />
        )}
      </AnimatePresence>
    </m.aside>
  );
}
