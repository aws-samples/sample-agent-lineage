import { useEffect, useState } from "react";
import { fetchEvaluations } from "../api";
import type { Evaluation } from "../types";
import { Icon } from "./Icon";

const FILTERS = ["ALL", "ONLINE", "ON-DEMAND"] as const;
type Filter = (typeof FILTERS)[number];

interface Props {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

interface ResultRow {
  time: string;
  evaluator: string;
  score: number;
}

/** All evaluation activity for one agent: online monitors with their
 *  per-invocation result series, and on-demand (batch) executions. */
export function EvaluationsExplorer({ agentId, agentName, onClose }: Props) {
  const [evals, setEvals] = useState<Evaluation[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    fetchEvaluations(agentId).then(setEvals).catch(() => setEvals([]));
  }, [agentId]);

  const visible = evals.filter((e) =>
    filter === "ALL"
      ? true
      : filter === "ONLINE"
        ? e.eval_type === "online"
        : e.eval_type !== "online",
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={`Evaluations for ${agentName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Evaluations · {agentName}</h2>
            <p className="hint">
              Online monitors evaluate live invocations continuously; on-demand
              evaluations are batch executions with a final result.
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="runs-toolbar">
          {FILTERS.map((f) => (
            <button
              key={f}
              className={`tab ${filter === f ? "tab-active" : ""}`}
              onClick={() => { setFilter(f); setExpanded(null); }}
            >
              {f.toLowerCase()}
            </button>
          ))}
          <span className="runs-total">{visible.length} evaluations</span>
        </div>

        <div className="runs-table-wrap">
          <table className="runs-table">
            <thead>
              <tr>
                <th></th>
                <th>Evaluation</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Score</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={6} className="runs-empty">no evaluations</td></tr>
              )}
              {visible.map((ev) => {
                const isOnline = ev.eval_type === "online";
                const results = (ev.facets.recent_results as ResultRow[] | undefined) ?? [];
                const avg = ev.facets.avg_score as number | undefined;
                const isOpen = expanded === ev.id;
                return (
                  <>
                    <tr
                      key={ev.id}
                      className={`runs-row ${isOpen ? "runs-row-open" : ""}`}
                      onClick={() => setExpanded(isOpen ? null : ev.id)}
                    >
                      <td className="expand-caret">{isOpen ? "▾" : "▸"}</td>
                      <td><b>{ev.name}</b></td>
                      <td>
                        <span className="tag"><Icon name={isOnline ? "signal" : "flask"} size={11} />{isOnline ? "online" : ev.eval_type}</span>
                      </td>
                      <td>
                        <span className={`eval-status eval-${ev.status.toLowerCase()}`}>
                          {ev.status}
                        </span>
                      </td>
                      <td>
                        {isOnline
                          ? avg !== undefined
                            ? `avg ${avg.toFixed(2)} (${results.length})`
                            : "—"
                          : ev.score != null
                            ? `${(ev.score * 100).toFixed(0)}%`
                            : "—"}
                      </td>
                      <td>
                        {ev.executed_at ? new Date(ev.executed_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${ev.id}-detail`}>
                        <td colSpan={6} className="runs-detail-cell">
                          {isOnline && results.length > 0 ? (
                            <table className="runs-table eval-results-table">
                              <thead>
                                <tr><th>Time</th><th>Evaluator</th><th>Score</th></tr>
                              </thead>
                              <tbody>
                                {[...results].reverse().map((r, i) => (
                                  <tr key={i}>
                                    <td>{new Date(r.time).toLocaleString()}</td>
                                    <td>{r.evaluator || "—"}</td>
                                    <td>
                                      <b>{r.score}</b>
                                      <span className="score-bar-wrap">
                                        <span
                                          className="score-bar"
                                          style={{
                                            width: `${Math.min(100, Math.max(0, r.score <= 1 ? r.score * 100 : r.score))}%`,
                                          }}
                                        />
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <dl className="nested-facets">
                              {Object.entries(ev.facets)
                                .filter(([k]) => !["recent_results", "last_result"].includes(k))
                                .map(([k, v]) => (
                                  <div key={k} className="nested-row">
                                    <dt>{k.replace(/_/g, " ")}</dt>
                                    <dd>
                                      {typeof v === "object"
                                        ? JSON.stringify(v)
                                        : String(v)}
                                    </dd>
                                  </div>
                                ))}
                            </dl>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
