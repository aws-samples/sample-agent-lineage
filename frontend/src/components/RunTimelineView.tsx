import { useState } from "react";
import type { RunTimeline } from "../types";
import { RunTrajectoryGraph } from "./RunTrajectoryGraph";
import { Icon } from "./Icon";

interface Props {
  timeline: RunTimeline;
  /** CloudWatch trace deep link, when the run maps to a real trace. */
  traceUrl?: string | null;
}

/** Trajectory of a single run: LangGraph-style flow graph (default) or the
 *  raw step list, with the run's own cost rollup and failure details. */
export function RunTimelineView({ timeline, traceUrl }: Props) {
  const [view, setView] = useState<"graph" | "steps">("graph");
  const firstError = timeline.steps.find((s) => s.error)?.error;

  return (
    <div className="timeline-wrap">
      <div className="timeline-toolbar">
        <div className="timeline-cost">
          run cost <b>${timeline.cost_usd.toFixed(4)}</b> ·{" "}
          {timeline.input_tokens.toLocaleString()} in /{" "}
          {timeline.output_tokens.toLocaleString()} out tokens
        </div>
        {traceUrl && (
          <a className="trace-link" href={traceUrl} target="_blank" rel="noreferrer">
            Open trace in CloudWatch ↗
          </a>
        )}
        <div className="tab-bar timeline-tabs">
          <button
            className={`tab ${view === "graph" ? "tab-active" : ""}`}
            onClick={() => setView("graph")}
          >
            Graph
          </button>
          <button
            className={`tab ${view === "steps" ? "tab-active" : ""}`}
            onClick={() => setView("steps")}
          >
            Steps
          </button>
        </div>
      </div>

      {firstError && (
        <div className="run-error-banner">
          <b>Failed at {firstError.where ?? "agent"}</b>
          {firstError.type && <> · {firstError.type}</>}
          {firstError.message && <div className="run-error-msg">{firstError.message}</div>}
        </div>
      )}

      {view === "graph" ? (
        <RunTrajectoryGraph timeline={timeline} />
      ) : (
        <ol className="timeline">
          {timeline.steps.map((s, i) => (
            <li key={i} className="timeline-step">
              <div className="timeline-head">
                <span className={`step-type step-${s.event_type.toLowerCase()}`}>
                  {s.event_type}
                </span>
                <b>{s.agent}</b>
                {(s.repeat ?? 1) > 1 && <span className="tag">×{s.repeat}</span>}
                <small>{new Date(s.time).toLocaleTimeString()}</small>
              </div>
              <div className="timeline-detail">
                {s.on_behalf_of && <span className="tag"><Icon name="user-group" size={11} />{s.on_behalf_of}</span>}
                {s.sub_agents.map((a) => (
                  <span key={a} className="tag"><Icon name="agent" size={11} />→ {a}</span>
                ))}
                {s.tools.map((t) => (
                  <span key={t} className="tag"><Icon name="tool" size={11} />{t}</span>
                ))}
                {s.gateway_calls.map((c, j) => (
                  <span key={j} className={c.decision === "DENY" ? "deny-chip" : "tag"}>
                    <Icon name="gateway" size={11} />{c.gateway} → {c.tool} {c.decision === "DENY" ? "DENIED" : ""}
                  </span>
                ))}
                {s.guardrails
                  .filter((g) => g.action !== "PASSED")
                  .map((g, j) => (
                    <span key={j} className="deny-chip">
                      <Icon name="guardrail" size={11} />{g.guardrail} {g.action} ({g.category})
                    </span>
                  ))}
                {s.llms.map((l) => (
                  <span key={l.name} className="tag">
                    <Icon name="llm" size={11} />{l.name} {l.input_tokens.toLocaleString()}/
                    {l.output_tokens.toLocaleString()} tok
                  </span>
                ))}
                {s.resources.map((res) => (
                  <span key={res} className="tag"><Icon name="resource" size={11} />{res}</span>
                ))}
              </div>
              {s.error && (
                <div className="step-error">
                  ⚠ failed{s.error.where && <> at <b>{s.error.where}</b></>}
                  {s.error.type && <> · {s.error.type}</>}
                  {s.error.message && <div className="run-error-msg">{s.error.message}</div>}
                  {s.error.stacktrace && (
                    <details>
                      <summary>stack trace</summary>
                      <pre className="facet-code">{s.error.stacktrace}</pre>
                    </details>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
