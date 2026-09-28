import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchGraph, fetchMe, fetchNamespaces } from "./api";
import { clearPostLoginIntent, peekPostLoginIntent, signOut } from "./auth";
import { AccessRequestForm } from "./components/AccessRequestForm";
import { AccessRequestsModal } from "./components/AccessRequestsModal";
import { AwsConnectModal } from "./components/AwsConnectModal";
import { CatalogSearch } from "./components/CatalogSearch";
import { DetailPanel } from "./components/DetailPanel";
import { Icon } from "./components/Icon";
import { LineageDepthToggle } from "./components/LineageDepthToggle";
import { LineageGraph } from "./components/LineageGraph";
import { AnimatePresence, m } from "motion/react";
import { AnimatedNumber, usd2 } from "./components/Motion";
import { LogoLockup } from "./components/Logo";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  NODE_TYPE_META,
  type CatalogEntry,
  type Graph,
  type GraphNode,
  type MeInfo,
  type NamespaceInfo,
  type NodeType,
} from "./types";

type Timeframe = "24h" | "7d" | "30d" | "all" | "custom";

/** Local calendar date as YYYY-MM-DD (the value format of <input type="date">). */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const fmtDay = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  // Bumped per landed graph: remounts the canvas so React Flow re-measures
  // nodes (fresh node objects drop its cached handle bounds, and nodes whose
  // size didn't change are never re-observed — edges would silently vanish).
  const [graphVersion, setGraphVersion] = useState(0);
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
  // Opened directly when the user arrived via the landing page's
  // "Request viewer access" link.
  const [showRequestForm, setShowRequestForm] = useState(
    () => peekPostLoginIntent() === "request-access",
  );
  useEffect(() => clearPostLoginIntent(), []);
  const [timeframe, setTimeframe] = useState<Timeframe>("30d");
  // Custom range, as local calendar days (inclusive). Defaults to the last week.
  const today = isoDay(new Date());
  const [customFrom, setCustomFrom] = useState(() => isoDay(new Date(Date.now() - 7 * 86400000)));
  const [customTo, setCustomTo] = useState(today);
  const [layersOpen, setLayersOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false); // multi-focus: direct links only

  useEffect(() => {
    fetchNamespaces().then(setNamespaces).catch(() => setNamespaces([]));
    fetchMe().then(setMe).catch(() => setMe(null));
  }, [refreshKey]);

  const isAdmin = !me || me.role === "admin"; // fail open only pre-load; backend enforces
  // A viewer with no grants sees the access-request form instead of the graph.
  const noAccess = !!me && me.role === "viewer" && me.namespaces.length === 0;

  // The time window scopes everything time-bound: the lineage graph's observed
  // traffic, runs, costs, model stats, Cedar decisions and guardrail checks.
  // Custom ranges are whole local days, inclusive at both ends.
  const { since, until, windowLabel } = useMemo(() => {
    if (timeframe === "custom") {
      const [a, b] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom];
      return {
        since: new Date(`${a}T00:00:00`).toISOString(),
        until: new Date(`${b}T23:59:59.999`).toISOString(),
        windowLabel:
          a === b ? fmtDay(a)
          : a.slice(0, 4) === b.slice(0, 4)
            // same year: state it once ("Aug 20 – Sep 6, 2026")
            ? `${new Date(`${a}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${fmtDay(b)}`
            : `${fmtDay(a)} – ${fmtDay(b)}`,
      };
    }
    const hours = { "24h": 24, "7d": 168, "30d": 720 }[timeframe as "24h" | "7d" | "30d"];
    if (timeframe === "all" || !hours) return { since: undefined, until: undefined, windowLabel: "all time" };
    const label = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" }[timeframe as "24h" | "7d" | "30d"];
    return { since: new Date(Date.now() - hours * 3600 * 1000).toISOString(), until: undefined, windowLabel: label };
  }, [timeframe, customFrom, customTo]);
  const windowed = timeframe !== "all";

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

  // Only the latest request may land: rapid window/focus changes overlap, and
  // an older response must never overwrite a newer one.
  const graphReq = useRef(0);
  // Several catalog selections at once: offer collapsing each to its direct
  // links (depth 1) so they can be compared side by side. The choice sticks
  // while the multi-selection lasts; a single focus always shows full lineage.
  const multiFocus = focusNodeId === null && focusNodes.length > 1;
  const depth = multiFocus && collapsed ? 1 : 5;
  useEffect(() => {
    if (!multiFocus) setCollapsed(false);
  }, [multiFocus]);
  const load = useCallback((nodeIds: string[]) => {
    const req = ++graphReq.current;
    fetchGraph(nodeIds, depth, namespace || undefined, { since, until })
      .then((g) => {
        if (req !== graphReq.current) return;
        setGraph(g);
        setGraphVersion((v) => v + 1);
        setError(null);
      })
      .catch((e: Error) => {
        if (req === graphReq.current) setError(e.message);
      });
  }, [namespace, since, until, depth]);

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
          <h1 className="brand-h1"><LogoLockup size={22} /></h1>
        </div>
        {namespaces.length > 0 && (
          <label className="window-select ns-select" title="Scope the lineage to one account/region">
            <Icon name="cloud" size={13} /> Account
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
            <option value="custom">Custom range…</option>
          </select>
        </label>
        <ThemeToggle />
        {isAdmin ? (
          <>
            <button
              className="focus-btn"
              title="Review viewer access requests"
              onClick={() => setShowRequestsModal(true)}
            >
              <Icon name="key" size={13} />Requests
            </button>
            <button className="focus-btn aws-connect-btn" onClick={() => setShowAwsModal(true)}>
              <Icon name="cloud" size={13} />Connect AWS
            </button>
          </>
        ) : (
          <button
            className="focus-btn"
            title="Request access to another AWS account"
            onClick={() => setShowRequestForm((v) => !v)}
          >
            <Icon name="key" size={13} />Request access
          </button>
        )}
        {me?.auth_enabled && (
          <div className="session" title={`Signed in as ${me.email} (${me.role})`}>
            <span className="session-who">
              <span className="session-email">{me.email}</span>
              <span className={`session-role session-role-${me.role}`}>{me.role}</span>
            </span>
            <button className="session-out" onClick={() => signOut()} aria-label="Sign out">
              <Icon name="logout" size={14} /> Sign out
            </button>
          </div>
        )}
      </header>

      <AnimatePresence>
        {showAwsModal && (
          <AwsConnectModal
            key="aws"
            onClose={() => setShowAwsModal(false)}
            onSynced={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {showRequestsModal && (
          <AccessRequestsModal key="requests" onClose={() => setShowRequestsModal(false)} />
        )}
      </AnimatePresence>

      {/* Command strip: the search is the primary action, scoped by the
          focus/clear controls beside it. Sits directly on the map ground. */}
      <div className="command-strip">
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
            <span className="metric">{focusNodes.length}</span> in focus
            {selectedAgents.length > 0 && (
              // Catalog totals are all-time; say so when a window is active.
              <> · {windowed ? "all-time " : ""}LLM cost <span className="metric"><AnimatedNumber value={totalSelectedCost} format={usd2} /></span></>
            )}
          </span>
        )}
        {multiFocus && (
          <LineageDepthToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
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
        {/* Custom time range: scopes the graph's observed traffic and every
            time-bound metric. Sits with the search — both scope what you see. */}
        <AnimatePresence initial={false}>
        {timeframe === "custom" && (
          <m.fieldset
            key="range"
            className="range-picker"
            aria-label="Custom time range"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10, transition: { duration: 0.12 } }}
          >
            <label>
              <span>From</span>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
              />
            </label>
            <span className="range-arrow" aria-hidden>→</span>
            <label>
              <span>To</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={(e) => e.target.value && setCustomTo(e.target.value)}
              />
            </label>
          </m.fieldset>
        )}
        </AnimatePresence>
      </div>

      <div className="stage">
        <AnimatePresence>
        {selected && graph && (
          <DetailPanel
            key="detail" // one panel instance: switching nodes updates in place
            node={selected}
            graph={graph}
            since={since}
            until={until}
            onFocus={(id) => setFocusNodeId(id)}
            onClose={() => setSelected(null)}
          />
        )}
        </AnimatePresence>

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
            <LineageGraph key={graphVersion} graph={visibleGraph} onSelect={setSelected} />
          ) : (
            !error && (
              <div className="empty-state">
                <div className="empty-icon"><Icon name="link" size={42} /></div>
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

        {/* Layers palette floats over the map, top-right, like a GIS legend. */}
        <nav className={`layers-palette ${layersOpen ? "" : "layers-collapsed"}`} aria-label="Map layers">
          <button
            className="layers-toggle"
            aria-expanded={layersOpen}
            onClick={() => setLayersOpen((v) => !v)}
          >
            <span>Layers</span>
            <span className="layers-caret" aria-hidden>{layersOpen ? "−" : "+"}</span>
          </button>
          {layersOpen && (
            <>
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
              </ul>
              <div className="legend-divider" />
              <div className="legend-window" title="Observed traffic on the graph is scoped to this window. Declared edges reflect current configuration.">
                Traffic · <b>{windowLabel}</b>
              </div>
              {depth === 1 && (
                <div className="legend-window" title="Each selected node's direct links only. Use Expand lineage to trace further.">
                  Depth · <b>direct links</b>
                </div>
              )}
              <ul className="legend legend-edges">
                <li><span className="edge-sample solid-amber" /> observed, undeclared</li>
                <li><span className="edge-sample solid-red" /> has Cedar denials</li>
                <li><span className="edge-sample solid-green" /> declared &amp; observed</li>
                <li><span className="edge-sample dashed" /> {windowed ? "declared, unused in window" : "declared, never used"}</li>
              </ul>
              <div className="legend-divider" />
              <label className="layer-toggle legend-option">
                <input
                  type="checkbox"
                  checked={hideIsolated}
                  onChange={() => setHideIsolated((v) => !v)}
                />
                Hide isolated nodes
              </label>
            </>
          )}
        </nav>
      </div>
    </div>
  );
}
