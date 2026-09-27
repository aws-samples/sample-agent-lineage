import { useEffect, useState } from "react";
import { cloudWatchTraceUrl, fetchRuns, fetchRunTimeline } from "../api";
import type { Run, RunTimeline } from "../types";
import { RunTimelineView } from "./RunTimelineView";
import { AnimatedNumber, ModalFrame, TabPill } from "./Motion";

const PAGE_SIZE = 25;
const STATES = ["ALL", "COMPLETE", "FAIL", "RUNNING"] as const;

interface Props {
  agentId: string;
  agentName: string;
  since?: string;
  until?: string;
  onClose: () => void;
}

function duration(r: Run): string {
  if (!r.started_at || !r.ended_at) return "—";
  const s = (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000;
  if (s < 1) return "<1s";
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

/** Paginated, filterable run history for one agent. A run is a single
 *  end-to-end invocation (session); all sub-agent activity shares its runId. */
export function RunsExplorer({ agentId, agentName, since, until, onClose }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<(typeof STATES)[number]>("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<RunTimeline | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchRuns(agentId, {
      state: state === "ALL" ? undefined : state,
      since,
      until,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((p) => {
        setRuns(p.runs);
        setTotal(p.total);
      })
      .catch(() => {
        setRuns([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [agentId, state, page, since, until]);

  const toggle = (runId: string) => {
    if (expanded === runId) {
      setExpanded(null);
      setTimeline(null);
      return;
    }
    setExpanded(runId);
    setTimeline(null);
    fetchRunTimeline(runId).then(setTimeline).catch(() => setTimeline(null));
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <ModalFrame label={`Runs for ${agentName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <h2>Runs · {agentName}</h2>
          <p className="hint">
            A run is one end-to-end agent invocation (session / task execution).
            All sub-agent, tool, LLM and gateway activity under the same run ID
            belongs to that invocation.
          </p>
        </div>
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <div className="runs-toolbar">
        {STATES.map((s) => (
          <button
            key={s}
            className={`tab ${state === s ? "tab-active" : ""}`}
            onClick={() => { setState(s); setPage(0); setExpanded(null); }}
          >
            {state === s && <TabPill layoutId="runs-filter-pill" />}
            <span className="tab-label">{s.toLowerCase()}</span>
          </button>
        ))}
        <span className="runs-total"><AnimatedNumber value={total} /> runs</span>
      </div>

      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th></th>
              <th>State</th>
              <th>Run</th>
              <th>Version</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Tokens (in/out)</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="runs-empty">loading…</td></tr>
            )}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={8} className="runs-empty">no runs</td></tr>
            )}
            {!loading &&
              runs.map((r) => (
                <>
                  <tr
                    key={r.run_id}
                    className={`runs-row ${expanded === r.run_id ? "runs-row-open" : ""}`}
                    onClick={() => toggle(r.run_id)}
                  >
                    <td className="expand-caret">{expanded === r.run_id ? "▾" : "▸"}</td>
                    <td>
                      <span className={`run-state run-${r.state.toLowerCase()}`}>
                        {r.state}
                      </span>
                    </td>
                    <td><code>{r.run_id.slice(0, 8)}</code></td>
                    <td>
                      {typeof r.facets.agent_version === "string"
                        ? `v${r.facets.agent_version}`
                        : "—"}
                    </td>
                    <td>{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</td>
                    <td>{duration(r)}</td>
                    <td>
                      {r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}
                    </td>
                    <td className="runs-cost">${r.cost_usd.toFixed(4)}</td>
                  </tr>
                  {expanded === r.run_id && (
                    <tr key={`${r.run_id}-detail`}>
                      <td colSpan={8} className="runs-detail-cell">
                        {timeline ? (
                          <RunTimelineView
                            timeline={timeline}
                            traceUrl={cloudWatchTraceUrl(agentId, r.run_id)}
                          />
                        ) : (
                          <span className="hint">loading trajectory…</span>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
          </tbody>
        </table>
      </div>

      <div className="runs-pagination">
        <button
          className="focus-btn"
          disabled={page === 0}
          onClick={() => { setPage((p) => p - 1); setExpanded(null); }}
        >
          ← Prev
        </button>
        <span>page {page + 1} of {pages}</span>
        <button
          className="focus-btn"
          disabled={page + 1 >= pages}
          onClick={() => { setPage((p) => p + 1); setExpanded(null); }}
        >
          Next →
        </button>
      </div>
    </ModalFrame>
  );
}
