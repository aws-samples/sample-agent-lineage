// Shared Motion primitives. Everything renders `m.*` components (LazyMotion
// is strict) and relies on the root MotionConfig for reduced-motion handling.
import { m } from "motion/react";

/** Snappy, near-critically-damped spring for indicators that travel. */
export const SPRING_SNAPPY = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/**
 * The active-tab highlight. Render it inside the ACTIVE tab only, with the
 * same `layoutId` for every tab in one group: Motion then slides a single
 * pill from the old tab to the new one instead of the highlight jumping.
 * Styling lives in CSS (`.tab-pill` + the group's modifier); the tab's label
 * must sit above it (`.tab-label`).
 */
export function TabPill({ layoutId }: { layoutId: string }) {
  return (
    <m.span
      layoutId={layoutId}
      className="tab-pill"
      aria-hidden
      transition={SPRING_SNAPPY}
    />
  );
}
