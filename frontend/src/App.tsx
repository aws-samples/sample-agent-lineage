import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchGraph, fetchMe, fetchNamespaces } from "./api";
import { AccessRequestForm } from "./components/AccessRequestForm";
import { AccessRequestsModal } from "./components/AccessRequestsModal";
import { AwsConnectModal } from "./components/AwsConnectModal";
import { CatalogSearch } from "./components/CatalogSearch";
import { DetailPanel } from "./components/DetailPanel";
import { LineageGraph } from "./components/LineageGraph";
import {
  NODE_TYPE_META,
  type CatalogEntry,
  type Graph,
  type GraphNode,
  type MeInfo,
  type NamespaceInfo,
  type NodeType,
} from "./types";

type Timeframe = "24h" | "7d" | "30d" | "all";

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [focusNodes, setFocusNodes] = useState<CatalogEntry[]>([]);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<NodeType>>(new Set());
  const [showAwsModal, setShowAwsModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
  const [me, setMe] = useState<MeInfo | null>(null);
  // "" = all accounts in scope; otherwise one selected namespace.
  const [namespace, setNamespace] = useState<string>("");
  const [showRequestsModal, setShowRequestsModal] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [timeframe, setTimeframe] = useState<Timeframe>("30d");
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
  );

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("al_theme", next);
  };

  useEffect(() => {
    fetchNamespaces().then(setNamespaces).catch(() => setNamespaces([]));
    fetchMe().then(setMe).catch(() => setMe(null));
  }, [refreshKey]);

  const isAdmin = !me || me.role === "admin"; // fail open only pre-load; backend enforces
  // A viewer with no grants sees the access-request form instead of the graph.
  const noAccess = !!me && me.role === "viewer" && me.namespaces.length === 0;

  // Observability metrics (costs, runs, LLM stats) are scoped to this window.
  const since = useMemo(() => {
    const hours = { "24h": 24, "7d": 168, "30d": 720 }[timeframe as Exclude<Timeframe, "all">];
    if (timeframe === "all" || !hours) return undefined;
    return new Date(Date.now() - hours * 3600 * 1000).toISOString();
  }, [timeframe]);

  const toggleType = (t: NodeType) =>
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  // Hide filtered layers; drop edges touching hidden nodes; optionally hide
  // nodes with no remaining connections.
  const visibleGraph = useMemo(() => {
    if (!graph) return graph;
    let nodes = graph.nodes.filter((n) => !hiddenTypes.has(n.node_type));
    let ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    if (hideIsolated) {
      const connected = new Set<string>();
      edges.forEach((e) => {
        connected.add(e.source);
        connected.add(e.target);
      });
      nodes = nodes.filter((n) => connected.has(n.id));
    }
    return { nodes, edges };
  }, [graph, hiddenTypes, hideIsolated]);

  const load = useCallback((nodeIds: string[]) => {
    fetchGraph(nodeIds, 5, namespace || undefined)
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [namespace]);

  // Focus priority: explicit node focus (from detail panel) > catalog selection.
  // Nothing selected -> empty state (unless the user asked for the full graph).
  const hasFocus = focusNodeId !== null || focusNodes.length > 0;
  useEffect(() => {
    if (!hasFocus && !showAll) {
      setGraph(null);
      setSelected(null);
      return;
    }
    load(focusNodeId ? [focusNodeId] : focusNodes.map((a) => a.id));
  }, [load, focusNodeId, focusNodes, hasFocus, showAll, refreshKey]);

  const selectedAgents = focusNodes.filter((n) => n.node_type === "agent");
  const totalSelectedCost = selectedAgents.reduce((s, a) => s + a.total_cost_usd, 0);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            {/* Mini lineage graph: source -> branches -> target */}
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <path
                d="M6 12 L12 6.5 M6 12 L12 17.5 M12 6.5 L18 12 M12 17.5 L18 12"
                stroke="rgba(255,255,255,0.85)"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <circle cx="6" cy="12" r="2.6" fill="#fff" />
              <circle cx="12" cy="6.5" r="2.2" fill="#fff" fillOpacity="0.9" />
              <circle cx="12" cy="17.5" r="2.2" fill="#fff" fillOpacity="0.9" />
              <circle cx="18" cy="12" r="2.6" fill="#fff" />
            </svg>
          </div>
          <div className="brand-text">
            <h1>Agent Lineage</h1>
            <span className="subtitle">Provenance · Governance · Cost — for agentic AI</span>
          </div>
        </div>
        {namespaces.length > 0 && (
          <label className="window-select ns-select" title="Scope the lineage to one account/region">
            ☁️ Account
            <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
              <option value="">
                {namespaces.length > 1 ? `All (${namespaces.length})` : "All"}
              </option>
              {namespaces.map((ns) => (
                <option key={ns.namespace} value={ns.namespace}>
                  {ns.namespace} ({ns.nodes})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="window-select">
          Window
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <button
          className="theme-toggle"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle color theme"
          onClick={toggleTheme}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        {isAdmin ? (
          <>
            <button
              className="focus-btn"
              title="Review viewer access requests"
              onClick={() => setShowRequestsModal(true)}
            >
              🔑 Requests
            </button>
            <button className="focus-btn aws-connect-btn" onClick={() => setShowAwsModal(true)}>
              ☁️ Connect AWS
            </button>
          </>
        ) : (
          <button
            className="focus-btn"
            title="Request access to another AWS account"
            onClick={() => setShowRequestForm((v) => !v)}
          >
            🔑 Request access
          </button>
        )}
      </header>

      {showAwsModal && (
        <AwsConnectModal
          onClose={() => setShowAwsModal(false)}
          onSynced={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {showRequestsModal && (
        <AccessRequestsModal onClose={() => setShowRequestsModal(false)} />
      )}

      <div className="searchbar">
        <CatalogSearch
          selected={focusNodes}
          refreshSignal={refreshKey}
          namespace={namespace}
          onChange={(entries) => {
            setFocusNodes(entries);
            setFocusNodeId(null);
            setShowAll(false);
          }}
        />
        {focusNodes.length > 0 && (
          <span className="search-summary">
            {focusNodes.length} in focus
            {selectedAgents.length > 0 && (
              <> · agent LLM cost ${totalSelectedCost.toFixed(2)}</>
            )}
          </span>
        )}
        {focusNodeId && (
          <button className="focus-btn" onClick={() => setFocusNodeId(null)}>
            Clear node focus
          </button>
        )}
        {showAll && !hasFocus && (
          <button className="focus-btn" onClick={() => setShowAll(false)}>
            Clear graph
          </button>
        )}
      </div>

      <div className="body">
        {selected && graph && (
          <DetailPanel
            node={selected}
            graph={graph}
            since={since}
            onFocus={(id) => setFocusNodeId(id)}
          />
        )}

        <main className="canvas">
          {(noAccess || showRequestForm) ? (
            <div className="empty-state">
              <AccessRequestForm />
              {showRequestForm && !noAccess && (
                <button className="focus-btn" onClick={() => setShowRequestForm(false)}>
                  Back to lineage
                </button>
              )}
            </div>
          ) : (
            <>
          {error && <div className="error">Backend unreachable: {error}</div>}
          {visibleGraph ? (
            <LineageGraph graph={visibleGraph} onSelect={setSelected} />
          ) : (
            !error && (
              <div className="empty-state">
                <div className="empty-icon">⛓️</div>
                <h2>Pick an agent to trace</h2>
                <p>
                  Search the AgentCore catalog above and select one or more agents to see
                  their end-to-end lineage: user groups, sub-agents, tools, LLMs and resources.
                </p>
                <button className="focus-btn" onClick={() => setShowAll(true)}>
                  Or show the entire platform graph
                </button>
              </div>
            )
          )}
            </>
          )}
        </main>

        <nav className="sidebar sidebar-right">
          <h3>Layers</h3>
          <ul className="legend">
            {(Object.keys(NODE_TYPE_META) as NodeType[]).map((t) => (
              <li key={t}>
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={!hiddenTypes.has(t)}
                    onChange={() => toggleType(t)}
                  />
                  <span className="swatch" style={{ background: NODE_TYPE_META[t].color }} />
                  {NODE_TYPE_META[t].label}
                </label>
              </li>
            ))}
            <li><span className="edge-sample dashed" /> declared, never used</li>
            <li><span className="edge-sample solid-green" /> declared ✓ observed</li>
            <li><span className="edge-sample solid" /> observed, undeclared ⚠</li>
            <li><span className="edge-sample solid-red" /> has Cedar denials</li>
            <li>
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={hideIsolated}
                  onChange={() => setHideIsolated((v) => !v)}
                />
                Hide isolated nodes
              </label>
            </li>
          </ul>
          <h3>How to read</h3>
          <p className="hint">
            Search the AgentCore catalog above and pick one or more agents to scope the
            lineage. Click any node for engine, hosting, Cedar policies, A2A auth,
            evaluations and cost details.
          </p>
        </nav>
      </div>
    </div>
  );
}
