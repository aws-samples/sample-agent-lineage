import { useState } from "react";
import { Icon } from "./Icon";

type Theme = "light" | "dark";

function current(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Light/dark switch shared by the app, landing and docs. The choice is
 *  written to <html data-theme> and persisted under `al_theme`, which
 *  index.html applies before first paint, so all three surfaces agree. */
export function ThemeToggle({ className = "theme-toggle" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(current);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("al_theme", next);
  };
  return (
    <button
      className={className}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle color theme"
      onClick={toggle}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
    </button>
  );
}
