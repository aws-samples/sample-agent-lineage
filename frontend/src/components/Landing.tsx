import { useState } from "react";
import { Icon } from "./Icon";
import { LogoLockup } from "./Logo";
import { REPO_URL } from "./Markdown";
import { Showcase } from "./Showcase";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  /** "signin": auth enabled, the action starts the Cognito hosted-UI flow.
   *  "local": auth disabled, the action simply enters the app. */
  mode: "signin" | "local";
  onEnter: () => void | Promise<void>;
}

/** Pre-auth landing (Persuade surface). Credentials are never entered here:
 *  Sign in hands off to the Cognito hosted UI (PKCE). The hero is the product
 *  demonstrating its own mechanism — a lineage graph drawing itself in, with
 *  one undeclared edge lighting up amber. */
export function Landing({ mode, onEnter }: Props) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onEnter(); } finally { setBusy(false); }
  };

  return (
    <div className="landing">
      <header className="landing-top">
        <LogoLockup size={24} />
        <nav className="landing-nav" aria-label="Site">
          <a className="landing-navlink" href="#/docs">Docs</a>
          <a className="landing-navlink" href={REPO_URL} target="_blank" rel="noreferrer">GitHub ↗</a>
          <ThemeToggle />
          <button className="landing-signin landing-signin-quiet" onClick={go} disabled={busy}>
            Login
          </button>
        </nav>
      </header>

      <main className="landing-hero">
        <div className="landing-copy">
          <h1 className="landing-title">
            The map of your agents.
          </h1>
          <p className="landing-lead">
            Agent Lineage renders your Amazon Bedrock AgentCore platform as a living
            access graph and compares what each agent is <em>allowed</em> to do with what
            it <em>actually does</em>. The difference is where unused privilege and access
            drift live.
          </p>
          <div className="landing-actions">
            <button className="landing-signin" onClick={go} disabled={busy} autoFocus>
              <Icon name="key" size={15} />
              {mode === "signin" ? "Login to your console" : "Login to the console"}
            </button>
            <span className="landing-auth-note">
              {mode === "signin"
                ? "Single sign-on via Amazon Cognito. Read-only against your account."
                : "Local mode — authentication disabled."}
            </span>
          </div>
        </div>

        <div className="landing-stage">
          <div className="landing-tilt" aria-hidden>
            <HeroGraph />
          </div>
          <p className="landing-caption">
            <span className="landing-caption-tag">Example estate</span>
            A customer-service triage agent hands refunds to a specialist, which
            reaches tools through a gateway — the amber edge is the gateway
            touching the finance ledger with no declaration behind it.
          </p>
        </div>
      </main>

      <Showcase />

      <section className="landing-beats" aria-label="What Agent Lineage does">
        <Beat
          icon="agent"
          title="See"
          text="Every user group, agent, sub-agent, gateway, tool, model and resource in one connected graph — synced read-only from your account."
        />
        <Beat
          icon="gateway"
          title="Govern"
          text="Every Cedar decision, guardrail intervention and evaluation result, attached to the edge where it happened. The audit trail is a filter, not a search."
          signal
        />
        <Beat
          icon="cost"
          title="Attribute"
          text="Token spend turned into dollars — per model, per agent, per run, and per calling team. Chargeback for agentic AI in one query."
        />
      </section>

      <footer className="landing-foot">
        <span>
          Declared vs observed · OpenLineage for agents ·{" "}
          <a className="landing-footlink" href="#/docs">Documentation</a>
        </span>
        <span className="landing-foot-right">
          <span className="landing-legend"><i className="lg-dash" /> declared</span>
          <span className="landing-legend"><i className="lg-ok" /> observed</span>
          <span className="landing-legend"><i className="lg-signal" /> undeclared</span>
        </span>
      </footer>
    </div>
  );
}

function Beat({ icon, title, text, signal }: { icon: "agent" | "gateway" | "cost"; title: string; text: string; signal?: boolean }) {
  return (
    <div className={`beat${signal ? " beat-signal" : ""}`}>
      <div className="beat-head">
        <Icon name={icon} size={16} />
        <h2>{title}</h2>
      </div>
      <p>{text}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------
   Hero graph. Hand-placed nodes on a 720x420 stage. Edges draw in with
   staggered delays; the two "observed" edges carry a travelling packet;
   the undeclared edge fires amber last. Pure SVG + CSS, no runtime deps.
   --------------------------------------------------------------------- */
type N = { id: string; x: number; y: number; label: string; kind: "group" | "agent" | "gateway" | "tool" | "llm" | "resource" };
/* A realistic estate: a customer-service desk whose triage agent hands
   refunds to a specialist, which reaches tools through a gateway. The story
   beat is the last edge — the gateway touching the ledger with no
   declaration behind it. */
const NODES: N[] = [
  { id: "g", x: 60, y: 210, label: "customer-service", kind: "group" },
  { id: "a", x: 220, y: 210, label: "case-triage-agent", kind: "agent" },
  { id: "b", x: 400, y: 110, label: "refunds-agent", kind: "agent" },
  { id: "gw", x: 400, y: 310, label: "commerce-gateway", kind: "gateway" },
  { id: "llm", x: 590, y: 60, label: "claude-sonnet", kind: "llm" },
  { id: "t1", x: 590, y: 200, label: "issue-refund", kind: "tool" },
  { id: "t2", x: 590, y: 300, label: "order-lookup", kind: "tool" },
  { id: "r", x: 590, y: 390, label: "ledger-postgres", kind: "resource" },
];
const COLOR: Record<N["kind"], string> = {
  group: "#8b5cf6", agent: "#2563eb", gateway: "#0891b2", tool: "#059669", llm: "#d97706", resource: "#dc2626",
};
const KIND_LABEL: Record<N["kind"], string> = {
  group: "USER GROUP", agent: "AGENT", gateway: "GATEWAY", tool: "TOOL", llm: "LLM", resource: "RESOURCE",
};
type E = { from: string; to: string; origin: "declared" | "both" | "observed"; delay: number };
const EDGES: E[] = [
  { from: "g", to: "a", origin: "both", delay: 0.2 },
  { from: "a", to: "b", origin: "both", delay: 0.5 },
  { from: "a", to: "gw", origin: "both", delay: 0.6 },
  { from: "b", to: "llm", origin: "both", delay: 0.9 },
  { from: "gw", to: "t1", origin: "declared", delay: 1.1 },
  { from: "gw", to: "t2", origin: "both", delay: 1.2 },
  { from: "gw", to: "r", origin: "observed", delay: 2.2 }, // the alarm
];
const NW = 132, NH = 40;
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));

function path(e: E): string {
  const a = byId[e.from], b = byId[e.to];
  const x1 = a.x + NW / 2, y1 = a.y, x2 = b.x - NW / 2, y2 = b.y;
  const c = (x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
}

function HeroGraph() {
  return (
    <svg className="hero-graph" viewBox="0 0 720 420" role="img" aria-label="Animated lineage graph">
      <defs>
        <filter id="glow" x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {EDGES.map((e, i) => {
        const d = path(e);
        return (
          <g key={i} className={`he he-${e.origin}`} style={{ ["--d" as string]: `${e.delay}s` }}>
            <path className="he-line" d={d} />
            {e.origin !== "declared" && (
              <circle className="he-packet" r="3.2">
                <animateMotion dur="2.6s" begin={`${e.delay + 0.9}s`} repeatCount="indefinite" path={d} />
              </circle>
            )}
            {e.origin === "observed" && (
              <text className="he-tag" x={byId[e.to].x - NW / 2} y={byId[e.to].y - NH / 2 - 7}>
                undeclared
              </text>
            )}
          </g>
        );
      })}
      {NODES.map((n, i) => (
        <g key={n.id} className="hn" style={{ ["--d" as string]: `${0.05 + i * 0.08}s` }}>
          <rect x={n.x - NW / 2} y={n.y - NH / 2} width={NW} height={NH} rx="7" className="hn-box" style={{ stroke: COLOR[n.kind] }} />
          <rect x={n.x - NW / 2} y={n.y - NH / 2} width={NW} height={12} rx="7" className="hn-cap" style={{ fill: COLOR[n.kind] }} />
          <rect x={n.x - NW / 2} y={n.y - NH / 2 + 6} width={NW} height={6} className="hn-cap" style={{ fill: COLOR[n.kind] }} />
          {/* node TYPE on the cap (the generic vocabulary), instance name below (the story) */}
          <text x={n.x - NW / 2 + 7} y={n.y - NH / 2 + 9} className="hn-kind">{KIND_LABEL[n.kind]}</text>
          <text x={n.x} y={n.y + 11} className="hn-label" textAnchor="middle">{n.label}</text>
        </g>
      ))}
    </svg>
  );
}
