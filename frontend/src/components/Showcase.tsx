import { useState } from "react";
import { Icon, type IconName } from "./Icon";

/** Tabbed feature showcase for the landing page. Each tab is an authored SVG
 *  panel of one product view, drawn from the same primitives as the hero so
 *  the visuals stay crisp, weigh nothing, and never go stale like screenshots.
 *  Keyboard: arrow keys move between tabs (WAI-ARIA tabs pattern). */

interface Tab { id: string; icon: IconName; label: string; kicker: string; blurb: string; panel: () => JSX.Element }

const TABS: Tab[] = [
  { id: "graph", icon: "agent", label: "Lineage graph", kicker: "See",
    blurb: "Every user group, agent, sub-agent, gateway, tool, model and resource in one connected, searchable graph.",
    panel: GraphPanel },
  { id: "drift", icon: "alert", label: "Declared vs observed", kicker: "Least privilege",
    blurb: "Each edge knows how it is known. Declared-only is idle privilege; observed-only is drift. The delta is your work queue.",
    panel: DriftPanel },
  { id: "governance", icon: "gateway", label: "Cedar decisions", kicker: "Govern",
    blurb: "Every ALLOW and DENY a gateway made — which agent, which tool, which policy, which run — filterable, not searchable.",
    panel: GovernancePanel },
  { id: "cost", icon: "cost", label: "Cost attribution", kicker: "Attribute",
    blurb: "Tokens become dollars per model, per agent, per run and per calling team. Sub-agent spend rolls up to the team that invoked it.",
    panel: CostPanel },
  { id: "guardrails", icon: "guardrail", label: "Guardrail log", kicker: "Trace",
    blurb: "Blocked, masked and passed checks per guardrail, per model, per category — each one traceable to its run.",
    panel: GuardrailPanel },
];

export function Showcase() {
  const [active, setActive] = useState(0);
  const tab = TABS[active];
  const Panel = tab.panel;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); setActive((a) => (a + 1) % TABS.length); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setActive((a) => (a - 1 + TABS.length) % TABS.length); }
    if (e.key === "Home") { e.preventDefault(); setActive(0); }
    if (e.key === "End") { e.preventDefault(); setActive(TABS.length - 1); }
  };

  return (
    <section className="showcase" aria-labelledby="showcase-title">
      <div className="showcase-head">
        <h2 id="showcase-title">One graph. Every question.</h2>
        <p>Pick a view. Each one attaches to the same lineage graph.</p>
      </div>
      <div className="showcase-tabs" role="tablist" aria-label="Product views" onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            id={`sc-tab-${t.id}`}
            aria-selected={i === active}
            aria-controls={`sc-panel-${t.id}`}
            tabIndex={i === active ? 0 : -1}
            className={`showcase-tab${i === active ? " showcase-tab-active" : ""}${t.id === "drift" ? " showcase-tab-signal" : ""}`}
            onClick={() => setActive(i)}
          >
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="showcase-body" role="tabpanel" id={`sc-panel-${tab.id}`} aria-labelledby={`sc-tab-${tab.id}`}>
        <div className="showcase-copy">
          <div className={`showcase-kicker${tab.id === "drift" ? " showcase-kicker-signal" : ""}`}>{tab.kicker}</div>
          <h3>{tab.label}</h3>
          <p>{tab.blurb}</p>
        </div>
        <div className="showcase-panel" key={tab.id}>
          <Panel />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Panels: 560 x 300 stage, shared primitives                          */
/* ------------------------------------------------------------------ */
const C = { group: "#8b5cf6", agent: "#2563eb", gateway: "#0891b2", tool: "#059669", llm: "#d97706", resource: "#dc2626", identity: "#0d9488", guardrail: "#e11d48" };
const NW = 118, NH = 30;

function Node({ x, y, label, color, dim }: { x: number; y: number; label: string; color: string; dim?: boolean }) {
  return (
    <g opacity={dim ? 0.45 : 1}>
      <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx="6" className="sc-box" style={{ stroke: color }} />
      <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={7} rx="6" style={{ fill: color }} />
      <rect x={x - NW / 2} y={y - NH / 2 + 4} width={NW} height={3} style={{ fill: color }} />
      <text x={x} y={y + 8} textAnchor="middle" className="sc-label">{label}</text>
    </g>
  );
}
function curve(x1: number, y1: number, x2: number, y2: number) {
  const a = x1 + NW / 2, b = x2 - NW / 2, c = (b - a) * 0.5;
  return `M ${a} ${y1} C ${a + c} ${y1}, ${b - c} ${y2}, ${b} ${y2}`;
}
function Edge({ d, kind, label }: { d: string; kind: "declared" | "ok" | "signal" | "bad"; label?: string }) {
  return (
    <g className={`sc-edge sc-edge-${kind}`}>
      <path d={d} className="sc-line" />
      {kind !== "declared" && <circle r="2.8" className="sc-packet"><animateMotion dur="2.4s" repeatCount="indefinite" path={d} /></circle>}
      {label && <text className="sc-edge-label"><textPath href={`#${label}`} /></text>}
    </g>
  );
}
function Chip({ x, y, text, kind }: { x: number; y: number; text: string; kind: "ok" | "signal" | "bad" | "muted" }) {
  const w = text.length * 6.2 + 14;
  return (
    <g className={`sc-chip sc-chip-${kind}`}>
      <rect x={x} y={y - 9} width={w} height={18} rx="9" />
      <text x={x + w / 2} y={y + 3.5} textAnchor="middle">{text}</text>
    </g>
  );
}
function Frame({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <svg className="sc-svg" viewBox="0 0 560 300" role="img" aria-label={title}>
      <rect x="0.5" y="0.5" width="559" height="299" rx="10" className="sc-frame" />
      {children}
    </svg>
  );
}

function GraphPanel() {
  return (
    <Frame title="Lineage graph view">
      <Node x={70} y={150} label="customer-service" color={C.group} />
      <Node x={205} y={150} label="case-triage" color={C.agent} />
      <Node x={345} y={70} label="refunds-agent" color={C.agent} />
      <Node x={345} y={230} label="commerce-gw" color={C.gateway} />
      <Node x={485} y={40} label="claude-sonnet" color={C.llm} />
      <Node x={485} y={120} label="issue-refund" color={C.tool} />
      <Node x={485} y={200} label="order-lookup" color={C.tool} />
      <Node x={485} y={265} label="ledger-postgres" color={C.resource} />
      <Edge d={curve(70, 150, 205, 150)} kind="ok" />
      <Edge d={curve(205, 150, 345, 70)} kind="ok" />
      <Edge d={curve(205, 150, 345, 230)} kind="ok" />
      <Edge d={curve(345, 70, 485, 40)} kind="ok" />
      <Edge d={curve(345, 70, 485, 120)} kind="ok" />
      <Edge d={curve(345, 230, 485, 200)} kind="ok" />
      <Edge d={curve(345, 230, 485, 265)} kind="ok" />
    </Frame>
  );
}

function DriftPanel() {
  return (
    <Frame title="Declared versus observed access">
      <Node x={110} y={150} label="close-analyst-agent" color={C.agent} />
      <Node x={400} y={60} label="claude-haiku" color={C.llm} />
      <Node x={400} y={130} label="journal-export" color={C.tool} />
      <Node x={400} y={200} label="fx-rates" color={C.tool} />
      <Node x={400} y={265} label="reconcile-ledger" color={C.tool} dim />
      {/* fan the exit points across the agent's height so four edges
          leave cleanly instead of knotting at one centre point */}
      <Edge d={curve(110, 141, 400, 60)} kind="signal" />
      <Edge d={curve(110, 147, 400, 130)} kind="signal" />
      <Edge d={curve(110, 153, 400, 200)} kind="signal" />
      <Edge d={curve(110, 159, 400, 265)} kind="declared" />
      <Chip x={470} y={60} text="undeclared" kind="signal" />
      <Chip x={470} y={130} text="undeclared" kind="signal" />
      <Chip x={470} y={200} text="undeclared" kind="signal" />
      <Chip x={470} y={265} text="unused" kind="muted" />
      <text x={18} y={26} className="sc-caption">3 undeclared · 1 declared, never used</text>
    </Frame>
  );
}

function GovernancePanel() {
  const rows: [string, string, string, string, "ok" | "bad"][] = [
    ["DENY", "refunds-agent", "issue-refund", "refund-cap-500", "bad"],
    ["ALLOW", "case-triage", "order-lookup", "cs-read", "ok"],
    ["ALLOW", "refunds-agent", "order-lookup", "cs-read", "ok"],
    ["DENY", "close-analyst", "journal-post", "close-window-only", "bad"],
    ["ALLOW", "case-triage", "shipment-status", "cs-read", "ok"],
    ["ALLOW", "close-analyst", "journal-export", "finance-read", "ok"],
  ];
  return (
    <Frame title="Cedar decision log">
      <text x={18} y={26} className="sc-caption">commerce-gateway · Cedar decisions</text>
      <Chip x={388} y={22} text="412 allowed" kind="ok" />
      <Chip x={478} y={22} text="17 denied" kind="bad" />
      {["decision", "agent", "tool", "policy"].map((h, i) => (
        <text key={h} x={[18, 110, 240, 390][i]} y={56} className="sc-th">{h}</text>
      ))}
      <line x1="18" y1="64" x2="542" y2="64" className="sc-rule" />
      {rows.map((r, i) => {
        const y = 88 + i * 34;
        return (
          <g key={i}>
            <Chip x={18} y={y} text={r[0]} kind={r[4]} />
            <text x={110} y={y + 4} className="sc-td sc-td-strong">{r[1]}</text>
            <text x={240} y={y + 4} className="sc-td">{r[2]}</text>
            <text x={390} y={y + 4} className="sc-td sc-mono">{r[3]}</text>
            <line x1="18" y1={y + 17} x2="542" y2={y + 17} className="sc-rule sc-rule-soft" />
          </g>
        );
      })}
    </Frame>
  );
}

function CostPanel() {
  const rows: [string, string, number][] = [
    ["case-triage-agent", "$48.20", 1.0],
    ["refunds-agent", "$21.75", 0.45],
    ["policy-lookup-agent", "$9.40", 0.20],
    ["shipment-status-agent", "$3.15", 0.07],
  ];
  return (
    <Frame title="Cost attribution by caller">
      <text x={18} y={26} className="sc-caption">customer-service · cost incurred by this caller</text>
      <text x={18} y={70} className="sc-big">$82.50</text>
      <text x={132} y={70} className="sc-sub">1,284 runs · 14.2M in / 2.9M out tokens · last 30 days</text>
      <line x1="18" y1="90" x2="542" y2="90" className="sc-rule" />
      {rows.map((r, i) => {
        const y = 118 + i * 40;
        return (
          <g key={i}>
            <text x={18} y={y + 4} className="sc-td sc-td-strong">{r[0]}</text>
            <rect x={230} y={y - 6} width={220} height={12} rx="3" className="sc-bar-track" />
            <rect x={230} y={y - 6} width={220 * r[2]} height={12} rx="3" className="sc-bar" />
            <text x={542} y={y + 4} textAnchor="end" className="sc-td sc-mono sc-td-strong">{r[1]}</text>
          </g>
        );
      })}
      <text x={18} y={286} className="sc-footnote">Sub-agent tokens roll up to the invoking team — attribution follows the run, not the entry point.</text>
    </Frame>
  );
}

function GuardrailPanel() {
  const rows: [string, string, string, "bad" | "signal" | "ok"][] = [
    ["BLOCKED", "pii", "case-triage → claude-sonnet", "bad"],
    ["MASKED", "pii", "refunds-agent → claude-sonnet", "signal"],
    ["BLOCKED", "prompt-injection", "policy-lookup → claude-haiku", "bad"],
    ["PASSED", "—", "shipment-status → claude-haiku", "ok"],
    ["MASKED", "card-number", "refunds-agent → claude-sonnet", "signal"],
  ];
  return (
    <Frame title="Guardrail intervention log">
      <text x={18} y={26} className="sc-caption">customer-data-shield · 3,061 checks</text>
      <Chip x={312} y={22} text="19 blocked" kind="bad" />
      <Chip x={398} y={22} text="46 masked" kind="signal" />
      <Chip x={476} y={22} text="2,996 passed" kind="ok" />
      <text x={18} y={56} className="sc-th">action</text>
      <text x={120} y={56} className="sc-th">category</text>
      <text x={250} y={56} className="sc-th">agent → model</text>
      <line x1="18" y1="64" x2="542" y2="64" className="sc-rule" />
      {rows.map((r, i) => {
        const y = 92 + i * 40;
        return (
          <g key={i}>
            <Chip x={18} y={y} text={r[0]} kind={r[3]} />
            <text x={120} y={y + 4} className="sc-td sc-mono">{r[1]}</text>
            <text x={250} y={y + 4} className="sc-td">{r[2]}</text>
            <line x1="18" y1={y + 20} x2="542" y2={y + 20} className="sc-rule sc-rule-soft" />
          </g>
        );
      })}
    </Frame>
  );
}
