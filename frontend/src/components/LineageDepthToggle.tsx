import { useState } from "react";
import { m, useReducedMotion } from "motion/react";

interface Props {
  /** true = direct links only (depth 1); false = full lineage. */
  collapsed: boolean;
  onToggle: () => void;
}

/*
 * Glyph: a tiny left-to-right lineage tree — focus node, its direct links,
 * and the next tier out. Collapsing folds the outer tier back into the
 * direct links; expanding grows it out again. Hover/focus previews the
 * state the click will produce, so the icon says what the button does.
 */
const FOCUS = { x: 3, y: 8 };
const DIRECT = [{ x: 10, y: 4.5 }, { x: 10, y: 11.5 }];
// each outer node grows out of its parent direct link
const OUTER = [
  { x: 17, y: 2, parent: 0 },
  { x: 17, y: 7, parent: 0 },
  { x: 17, y: 9, parent: 1 },
  { x: 17, y: 14, parent: 1 },
];

function DepthGlyph({ expanded, instant }: { expanded: boolean; instant: boolean }) {
  const t = instant ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 26 } as const;
  return (
    <svg className="depth-glyph" width="20" height="16" viewBox="0 0 20 16" aria-hidden>
      {DIRECT.map((d, i) => (
        <line key={`fd${i}`} x1={FOCUS.x} y1={FOCUS.y} x2={d.x} y2={d.y} className="depth-glyph-line" />
      ))}
      {OUTER.map((o, i) => {
        const p = DIRECT[o.parent];
        return (
          <g key={`o${i}`}>
            <m.line
              x1={p.x}
              y1={p.y}
              className="depth-glyph-line"
              initial={false}
              animate={expanded ? { x2: o.x, y2: o.y, opacity: 1 } : { x2: p.x, y2: p.y, opacity: 0 }}
              transition={t}
            />
            <m.circle
              r={1.5}
              className="depth-glyph-outer"
              initial={false}
              animate={expanded ? { cx: o.x, cy: o.y, opacity: 1 } : { cx: p.x, cy: p.y, opacity: 0 }}
              transition={t}
            />
          </g>
        );
      })}
      {DIRECT.map((d, i) => (
        <circle key={`d${i}`} cx={d.x} cy={d.y} r={1.9} className="depth-glyph-direct" />
      ))}
      <circle cx={FOCUS.x} cy={FOCUS.y} r={2.4} className="depth-glyph-focus" />
    </svg>
  );
}

/** Collapse a multi-agent graph to each agent's direct links, or expand it
 *  back to full lineage. */
export function LineageDepthToggle({ collapsed, onToggle }: Props) {
  const [previewing, setPreviewing] = useState(false);
  const reduce = useReducedMotion() ?? false;
  // At rest the glyph shows the current state; on hover/focus, the next one.
  const expanded = previewing ? collapsed : !collapsed;

  return (
    <button
      type="button"
      className={`focus-btn depth-toggle${collapsed ? " depth-toggle-collapsed" : ""}`}
      title={
        collapsed
          ? "Showing each agent's direct links only. Expand to trace the full lineage."
          : "Showing full lineage. Collapse to each agent's direct links to compare them side by side."
      }
      onClick={() => {
        setPreviewing(false); // settle on the new state; re-hover to preview again
        onToggle();
      }}
      onPointerEnter={() => setPreviewing(true)}
      onPointerLeave={() => setPreviewing(false)}
      onFocus={() => setPreviewing(true)}
      onBlur={() => setPreviewing(false)}
    >
      <DepthGlyph expanded={expanded} instant={reduce} />
      <span>{collapsed ? "Expand lineage" : "Collapse lineage"}</span>
    </button>
  );
}
