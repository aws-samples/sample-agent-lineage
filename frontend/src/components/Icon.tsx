import type { CSSProperties } from "react";

/** In-repo icon set: one stroke weight, one grid, inherits `currentColor`.
 *  Replaces emoji, which rendered differently per OS and could not be
 *  recolored to match a node type. Keep every glyph on the 24-unit grid. */
export type IconName =
  // node types
  | "user-group" | "agent" | "skill" | "prompt" | "identity" | "credential"
  | "gateway" | "guardrail" | "tool" | "llm" | "resource"
  // ui
  | "cloud" | "key" | "sun" | "moon" | "link" | "lock" | "cost" | "signal"
  | "flask" | "card" | "scroll" | "tag" | "users" | "check" | "x" | "alert"
  | "stop" | "square" | "arrow-left";

const PATHS: Record<IconName, string> = {
  // --- node types ---
  "user-group": "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm-9 10a5 5 0 0 1 10 0M19 8a3 3 0 0 1 0 6m2 7a4 4 0 0 0-3-3.9M5 8a3 3 0 0 0 0 6m-2 7a4 4 0 0 1 3-3.9",
  agent: "M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm7-5v5M9 14h.01M15 14h.01M2 13h1m18 0h1",
  skill: "M12 3v3m0 12v3M3 12h3m12 0h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  prompt: "M5 4h11l3 3v13H5V4Zm11 0v3h3M9 12h6M9 16h4",
  identity: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 3a3 3 0 0 1 6 0m2-5h5m-5 3h4",
  credential: "M14.5 9.5a4 4 0 1 0-4 4c.4 0 .8 0 1.2-.2L13 14.5V17l2 2h2v-2l-1.5-1.5 1-1V13l-2-2c.1-.5.2-1 .2-1.5Zm-4-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  gateway: "M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Zm0 5v8m-4-4h8",
  guardrail: "M4 6h16v4H4V6Zm0 8h16v4H4v-4Zm4-8v4m8-4v4M8 14v4m8-4v4M3 20h18",
  tool: "M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5L15 12l-3-3 2.7-2.7Z",
  llm: "M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 1 5h10a3 3 0 0 0 1-5 3 3 0 0 0-2-5V8a4 4 0 0 0-4-4Zm0 0v15M9 12h6",
  resource: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm-8 3v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  // --- ui ---
  cloud: "M7 18a4 4 0 0 1-.7-7.9A6 6 0 0 1 17.8 9 4 4 0 0 1 17 18H7Z",
  key: "M15 8a4 4 0 1 1-3.5 5.9L9 16.5V19l-2 2H5v-2l6-6a4 4 0 0 1 4-5Zm0 3h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  link: "M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1",
  lock: "M6 11h12v9H6v-9Zm3 0V7a3 3 0 0 1 6 0v4m-3 4v2",
  cost: "M12 3v18M16 7.5A3.5 3.5 0 0 0 12.5 5h-1a3.5 3.5 0 0 0 0 7h1a3.5 3.5 0 0 1 0 7h-1A3.5 3.5 0 0 1 8 15.5",
  signal: "M12 20v-8m-4.2 1.8a6 6 0 0 1 8.4 0M5 10.9a10 10 0 0 1 14 0M12 4.5v.01",
  flask: "M9 3h6M10 3v6L4.5 19a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L14 9V3M7.5 15h9",
  card: "M4 5h16v14H4V5Zm0 4h16M8 13h4",
  scroll: "M7 3h11a2 2 0 0 1 2 2v12H7a2 2 0 0 0-2 2V5a2 2 0 0 1 2-2Zm-2 16a2 2 0 0 0 2 2h10M10 8h6m-6 4h6",
  tag: "M3 12V4h8l9 9-8 8-9-9Zm4-5h.01",
  users: "M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9a6 6 0 0 1 12 0M16 4a4 4 0 0 1 0 8m5 9a6 6 0 0 0-4-5.7",
  check: "M5 12.5 9.5 17 19 7",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 3 2 20h20L12 3Zm0 7v4m0 3v.01",
  stop: "M6 6h12v12H6V6Z",
  square: "M5 5h14v14H5V5Z",
  "arrow-left": "M19 12H5m6-6-6 6 6 6",
};

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Decorative by default. Pass a title to make the icon informative. */
  title?: string;
}

export function Icon({ name, size = 16, className, style, title }: Props) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={style}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
