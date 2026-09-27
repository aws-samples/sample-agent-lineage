// Shared Motion primitives. Everything renders `m.*` components (LazyMotion
// is strict) and relies on the root MotionConfig for reduced-motion handling.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { m, useReducedMotion } from "motion/react";

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

/* ---- list entry ----------------------------------------------------- */

/**
 * Props for a list/table row that eases in when it mounts, staggered by its
 * index (capped, so long pages still settle in ~0.25 s). Rows keep their
 * key across re-renders, so only genuinely new rows (a new page, filter or
 * window) animate. Pair with className "row-in".
 */
export function rowIn(i: number, stagger = 0.018) {
  return {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.2, delay: Math.min(i, 12) * stagger },
  } as const;
}

/* ---- modal shell ---------------------------------------------------- */

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * Backdrop + dialog with enter AND exit motion. Render it under an
 * <AnimatePresence> in the parent so closing plays the exit before unmount.
 * Closes on backdrop click, the header's × (caller-owned) and Escape.
 */
export function ModalFrame({
  className = "modal",
  label,
  onClose,
  children,
}: {
  className?: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <m.div
      className="modal-backdrop"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <m.div
        className={className}
        role="dialog"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.99, transition: { duration: 0.12 } }}
        transition={{ duration: 0.22, ease: EASE_OUT }}
      >
        {children}
      </m.div>
    </m.div>
  );
}

/* ---- animated figures ---------------------------------------------- */

// Stable (module-level) formatters: AnimatedNumber maps every frame through one.
export const usd2 = (n: number) => `$${n.toFixed(2)}`;
export const usd4 = (n: number) => `$${n.toFixed(4)}`;
export const int = (n: number) => Math.round(n).toLocaleString();

/**
 * A figure that counts from its previous value to the new one, so a changed
 * time window or filter reads as a change rather than a silent swap. First
 * render shows the value directly; reduced-motion users get an instant set.
 * Pass a module-level `format` (not an inline arrow).
 */
export function AnimatedNumber({ value, format = int }: { value: number; format?: (n: number) => string }) {
  // A plain rAF tween: Motion's `animate()` would pull its whole animation
  // engine into the initial bundle just to count. React never renders the
  // span's children, so writing textContent can't fight reconciliation.
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value); // what's on screen now (mid-tween included)
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = format(shown.current);
  }, [format]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    if (reduce || from === value) {
      shown.current = value;
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 500);
      const eased = 1 - Math.pow(1 - p, 4); // ease-out quart
      shown.current = from + (value - from) * eased;
      el.textContent = format(shown.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduce, format]);

  return <span ref={ref} />;
}
