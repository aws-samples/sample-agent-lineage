/** Agent Lineage brand mark.
 *
 *  A lineage graph in miniature: a source fans into two paths that converge
 *  on a target. The upper path is a dashed trace — declared, never exercised.
 *  The lower path is the solid signal — observed at runtime. The product's one
 *  idea (declared vs observed) is the logo.
 *
 *  Single source of truth for every rendering: topbar, landing page,
 *  favicon (public/favicon.svg mirrors this geometry). Keep them in sync. */

interface MarkProps {
  size?: number;
  /** "signal" colours the observed path amber; "mono" keeps everything in
   *  currentColor for single-ink contexts. */
  variant?: "signal" | "mono";
  className?: string;
}

export const LOGO_SIGNAL = "#f5a524";

export function LogoMark({ size = 24, variant = "signal", className }: MarkProps) {
  const signal = variant === "signal" ? LOGO_SIGNAL : "currentColor";
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
    >
      {/* declared trace: dashed */}
      <path
        d="M8 16 C 12 16, 12 8, 17 8 L 24 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2.6 2.6"
        opacity="0.55"
      />
      {/* observed signal: solid */}
      <path
        d="M8 16 C 12 16, 12 24, 17 24 L 24 24"
        stroke={signal}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* nodes */}
      <circle cx="8" cy="16" r="3.2" fill="currentColor" />
      <circle cx="24" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" opacity="0.7" />
      <circle cx="24" cy="24" r="3" fill={signal} />
    </svg>
  );
}

interface LockupProps {
  /** Mark height in px; the wordmark scales with it. */
  size?: number;
  variant?: "signal" | "mono";
  className?: string;
}

/** Mark + wordmark, for the topbar and page headers. */
export function LogoLockup({ size = 22, variant = "signal", className }: LockupProps) {
  return (
    <span className={`logo-lockup${className ? ` ${className}` : ""}`} style={{ ["--logo-size" as string]: `${size}px` }}>
      <LogoMark size={size} variant={variant} />
      <span className="logo-wordmark">
        Agent<span className="logo-wordmark-accent">Lineage</span>
      </span>
    </span>
  );
}
