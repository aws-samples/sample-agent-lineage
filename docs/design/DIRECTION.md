# UI direction contract — "Control room" (v2)

Development-only design contract. Not shipped to the browser. Written before
the redesign build so later edits can be audited against it.

Revert target for the previous UI: git tag `ui-v1-classic`.

## THESIS
The product's one idea: it turns configuration-vs-runtime into a visible
delta on a live graph. The surface is an operations console monitoring that
system for deviation. It refuses the category default — navy ground, indigo
accent, bordered rounded cards, sans everywhere, topbar plus two pinned
sidebars — which is exactly what v1 was.

## OWN-WORLD
Graphite ground (near-black with a cool cast, never navy). Surfaces step by
tint, separated by 1px hairlines, not by card borders and shadows. One
committed signal colour: amber — it carries "needs attention" (undeclared
access, denials, blocks, failures) and is the loudest thing on screen.
Verification green and exception red are state, used sparingly and never as
decoration. Type: one workhorse sans for everything; monospace reserved for
identifiers, IDs and metrics; every number tabular. Instrument-style status
wells for headline metrics. Recognisable with content removed: a dark
console with hairline-partitioned panels and a single amber signal.

## STORY
The operator lands on a live map of their agent estate. Anything amber
demands attention and is one click from its evidence (edge, decision, run).
Everything green or neutral is healthy and recedes. They leave knowing what
to revoke, what to investigate, and what it cost.

## FIRST VIEWPORT
The lineage graph is the ground layer, full-bleed edge to edge. A slim
instrument strip across the top: brand mark, a command bar (search, ⌘K) as
the primary action, account/window scopes, then admin actions at the far
right. The detail panel slides in from the left *over* the graph as a
floating console; the layers legend is a compact floating palette at the
top-right of the canvas. No pinned side columns. The graph never shrinks to
make room for chrome.

## FORM
Direction A "Control room", top of the ranked list, raised by direction C
"Cartographic" with one donated discipline: the map is the whole screen and
every panel floats over it. Directions B (audit ledger) and D (terminal-
native) declined: B's light ground fights the users' dark IDE scene and a
graph canvas; D is the current dev-tool fashion and least distinctive.

## FINISH
Unreviewed and undocumented is unfinished; this build ends with a batched
light/dark inspection, a fix round, and this document updated with what was
actually built.

## As built (v2 finish review)
Verified in one batched round (dark + light, 1440px; drift case
`ac_eval_strands2`; narrow topbar at 900px), one fix batch, one confirmation.

Built as contracted:
- Graph is the full-bleed ground (`.stage` / absolute `.canvas`); the detail
  console (`.detail-panel`, 400px, left) and layers palette (`.layers-palette`,
  top-right, collapsible) float over it. No pinned side columns.
- Graphite palette (`--bg #0e1116`), hairline partitions, one signal colour.
  Edge vocabulary in `LineageGraph.tsx`: observed/undeclared = amber, 2px,
  animated; denials = red; declared & observed = quiet green; declared-only =
  grey dash. Undeclared is now the loudest thing on screen (it was the brand
  blue in v1, indistinguishable from decoration).
- Search moved into a command strip beneath a slim instrument strip; metrics
  in the strip are monospace tabular (`.metric`).
- Light theme is the same grammar on a paper-cool ground.

Fixes surfaced by the inspection round:
- Panel header + tab bar made sticky so identity and close stay visible while
  the console body scrolls.
- Brand mark hardcoded white → `currentColor` (was invisible in light mode).
- Wordmark `nowrap` + brand margin so it never wraps into or touches the
  Account control at narrow widths.
- Undeclared chips carry the drawn `alert` icon instead of the `⚠` text glyph.

Kept deliberately: `⚠` as text inside React Flow edge-label strings and the
governance tab label (string contexts where SVG cannot render).

Revert: `git revert <this commit>` or `git checkout ui-v1-classic`.
