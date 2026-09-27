import { useEffect, useMemo, useState } from "react";
import { fetchGuardrailInterventions } from "../api";
import type { GuardrailIntervention } from "../types";
import { Icon } from "./Icon";
import { m } from "motion/react";
import { ModalFrame, rowIn, TabPill } from "./Motion";

const FILTERS = ["ALL", "BLOCKED", "MASKED", "PASSED"] as const;
type Filter = (typeof FILTERS)[number];
const PAGE_SIZE = 25;

const ACTION_CHIP: Record<string, string> = {
  BLOCKED: "deny-chip",
  MASKED: "mask-chip",
  PASSED: "allow-chip",
};

interface Props {
  guardrailId: string;
  guardrailName: string;
  since?: string;
  until?: string;
  onClose: () => void;
}

/** Full intervention log for one guardrail, presented like the Cedar decisions
 *  explorer: filterable by action and category, paginated, audit-ready. Every
 *  check the guardrail performed is traceable to its run, agent and model. */
export function GuardrailInterventionsExplorer({ guardrailId, guardrailName, since, until, onClose }: Props) {
  const [interventions, setInterventions] = useState<GuardrailIntervention[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [category, setCategory] = useState<string>("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchGuardrailInterventions(guardrailId, 500, { since, until })
      .then(setInterventions)
      .catch(() => setInterventions([]));
  }, [guardrailId, since, until]);

  const categories = useMemo(
    () => [...new Set(interventions.map((i) => i.category).filter(Boolean))].sort(),
    [interventions],
  );

  const visible = interventions.filter(
    (i) =>
      (filter === "ALL" || i.action === filter) &&
      (!category || i.category === category),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const countOf = (action: string) => interventions.filter((i) => i.action === action).length;

  return (
    <ModalFrame label={`Guardrail interventions for ${guardrailName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <h2><Icon name="guardrail" size={18} /> Guardrail interventions · {guardrailName}</h2>
          <p className="hint">
            Every check this guardrail performed on model traffic: which agent's
            call was blocked, masked or passed, in which category, and during
            which run — full traceability for audit.
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
            {filter === f && <TabPill layoutId="guardrail-filter-pill" />}
            <span className="tab-label">{f.toLowerCase()}</span>
          </button>
        ))}
        {categories.length > 0 && (
          <select
            className="category-select"
            aria-label="Filter by category"
            value={category}
            onChange={(e) => { setCategory(e.target.value); setPage(0); }}
          >
            <option value="">all categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <span className="runs-total">
          <span className="deny-chip">{countOf("BLOCKED")} blocked</span>{" "}
          <span className="mask-chip">{countOf("MASKED")} masked</span>{" "}
          <span className="allow-chip">{countOf("PASSED")} passed</span>
        </span>
      </div>

      <div className="runs-table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Category</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Run</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan={6} className="runs-empty">no interventions</td></tr>
            )}
            {pageRows.map((i, idx) => (
              <m.tr key={i.id} className="row-in" {...rowIn(idx)}>
                <td>
                  <span className={ACTION_CHIP[i.action] ?? "deny-chip"}>{i.action}</span>
                </td>
                <td>{i.category ? <span className="tag">{i.category}</span> : "—"}</td>
                <td><b>{i.agent_name}</b></td>
                <td>{i.llm_name || "—"}</td>
                <td><code>{i.run_id.slice(0, 8)}</code></td>
                <td>{i.occurred_at ? new Date(i.occurred_at).toLocaleString() : "—"}</td>
              </m.tr>
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
