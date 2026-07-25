import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCatalog } from "../api";
import { NODE_TYPE_META, type CatalogEntry, type NodeType } from "../types";

// Dropdown group order.
const GROUP_ORDER: NodeType[] = [
  "agent", "tool", "skill", "gateway", "llm",
  "guardrail", "identity", "credential", "resource", "prompt", "user_group",
];

interface Props {
  selected: CatalogEntry[];
  onChange: (entries: CatalogEntry[]) => void;
  /** Bump to force a refetch (e.g. after an AWS sync completes). */
  refreshSignal?: number;
}

/** Search the whole catalog — agents, tools, skills, gateways, LLMs and more —
 *  grouped by category. Pick one or more entries to focus the lineage graph. */
export function CatalogSearch({ selected, onChange, refreshSignal = 0 }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchCatalog(query || undefined).then(setResults).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [query, refreshSignal]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const [activeType, setActiveType] = useState<NodeType | null>(null);

  const groups = useMemo(() => {
    const byType = new Map<NodeType, CatalogEntry[]>();
    for (const r of results) {
      const list = byType.get(r.node_type) ?? [];
      list.push(r);
      byType.set(r.node_type, list);
    }
    return GROUP_ORDER.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      entries: byType.get(t)!,
    }));
  }, [results]);

  // Keep a valid active category as results change.
  useEffect(() => {
    if (groups.length === 0) return;
    if (!activeType || !groups.some((g) => g.type === activeType)) {
      setActiveType(groups[0].type);
    }
  }, [groups, activeType]);

  const activeEntries = groups.find((g) => g.type === activeType)?.entries ?? [];

  const toggle = (entry: CatalogEntry) => {
    const exists = selected.some((a) => a.id === entry.id);
    onChange(exists ? selected.filter((a) => a.id !== entry.id) : [...selected, entry]);
    // Close after picking; reopen the input to add more.
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="catalog-search" ref={boxRef}>
      <div className="catalog-input-row">
        {selected.map((a) => (
          <span key={a.id} className="chip">
            {NODE_TYPE_META[a.node_type].icon} {a.name}
            <button aria-label={`Remove ${a.name}`} onClick={() => toggle(a)}>×</button>
          </span>
        ))}
        <input
          type="search"
          placeholder={
            selected.length
              ? "Add another…"
              : "Search agents, tools, skills, gateways, LLMs…"
          }
          aria-label="Search catalog"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        />
        {selected.length > 0 && (
          <button className="clear-all" onClick={() => onChange([])}>Clear all</button>
        )}
      </div>

      {open && groups.length > 0 && (
        <div className="catalog-dropdown">
          <div className="cat-tabs" role="tablist" aria-label="Result categories">
            {groups.map((g) => (
              <button
                key={g.type}
                role="tab"
                aria-selected={activeType === g.type}
                className={`cat-tab ${activeType === g.type ? "cat-tab-active" : ""}`}
                style={
                  activeType === g.type
                    ? { borderColor: NODE_TYPE_META[g.type].color, color: NODE_TYPE_META[g.type].color }
                    : undefined
                }
                onClick={() => setActiveType(g.type)}
              >
                {NODE_TYPE_META[g.type].icon} {NODE_TYPE_META[g.type].label}s
                <span className="cat-group-count">{g.entries.length}</span>
              </button>
            ))}
          </div>
          <ul className="cat-results" role="listbox">
            {activeEntries.map((a) => {
              const isSel = selected.some((s) => s.id === a.id);
              return (
                <li key={a.id}>
                  <button
                    role="option"
                    aria-selected={isSel}
                    className={isSel ? "selected" : ""}
                    onClick={() => toggle(a)}
                  >
                    <span className="cat-name">
                      {isSel ? "✓ " : ""}{a.name}
                    </span>
                    <span className="cat-meta">
                      {a.engine && <em>{a.engine}</em>}
                      {a.node_type === "agent" && (
                        <>
                          <span>{a.run_count} runs</span>
                          <span>{a.eval_count} evals</span>
                          <span>${a.total_cost_usd.toFixed(2)}</span>
                        </>
                      )}
                    </span>
                    {a.description && <span className="cat-desc">{a.description}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
