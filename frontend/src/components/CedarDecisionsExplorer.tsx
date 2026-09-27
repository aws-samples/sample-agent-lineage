import { useEffect, useState } from "react";
import { fetchCedarDecisions } from "../api";
import type { CedarDecision } from "../types";
import { Icon } from "./Icon";
import { ModalFrame, TabPill } from "./Motion";

const FILTERS = ["ALL", "ALLOW", "DENY"] as const;
type Filter = (typeof FILTERS)[number];
const PAGE_SIZE = 25;

interface Props {
  gatewayId: string;
  gatewayName: string;
  since?: string;
  until?: string;
  onClose: () => void;
}

/** Full Cedar authorization decision log for one gateway, presented like the
 *  runs explorer: filterable, paginated, audit-ready. */
export function CedarDecisionsExplorer({ gatewayId, gatewayName, since, until, onClose }: Props) {
  const [decisions, setDecisions] = useState<CedarDecision[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchCedarDecisions(gatewayId, undefined, { since, until })
      .then(setDecisions)
      .catch(() => setDecisions([]));
  }, [gatewayId, since, until]);

  const visible = decisions.filter((d) => filter === "ALL" || d.decision === filter);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const allowCount = decisions.filter((d) => d.decision === "ALLOW").length;
  const denyCount = decisions.length - allowCount;

  return (
    <ModalFrame label={`Cedar decisions for ${gatewayName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <h2><Icon name="gateway" size={18} /> Cedar decisions · {gatewayName}</h2>
          <p className="hint">
            Every authorization decision this gateway made: which agent asked for
            which tool, and which policy allowed or denied it.
          </p>
        </div>
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>

      <div className="runs-toolbar">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`tab ${filter === f ? "tab-active" : ""}`}
            onClick={() => { setFilter(f); setPage(0); }}
          >
            {filter === f && <TabPill layoutId="cedar-filter-pill" />}
            <span className="tab-label">{f.toLowerCase()}</span>
          </button>
        ))}
        <span className="runs-total">
          <span className="allow-chip">{allowCount} allowed</span>{" "}
          <span className="deny-chip">{denyCount} denied</span>
        </span>
      </div>

      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Agent</th>
              <th>Tool</th>
              <th>Policy</th>
              <th>Run</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan={6} className="runs-empty">no decisions</td></tr>
            )}
            {pageRows.map((d) => (
              <tr key={d.id}>
                <td>
                  <span className={d.decision === "DENY" ? "deny-chip" : "allow-chip"}>
                    {d.decision}
                  </span>
                </td>
                <td><b>{d.agent_name}</b></td>
                <td>{d.tool_name}</td>
                <td><code>{d.policy_id || "—"}</code></td>
                <td><code>{d.run_id.slice(0, 8)}</code></td>
                <td>{d.decided_at ? new Date(d.decided_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="runs-pagination">
        <button
          className="focus-btn"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          ← Prev
        </button>
        <span>page {page + 1} of {pages}</span>
        <button
          className="focus-btn"
          disabled={page + 1 >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </button>
      </div>
    </ModalFrame>
  );
}
