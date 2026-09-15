import { useEffect, useMemo } from "react";
import readme from "../../../README.md?raw";
import { Icon } from "./Icon";
import { LogoLockup } from "./Logo";
import { REPO_URL, renderMarkdown } from "./Markdown";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  onBack: () => void;
}

/** Documentation page: renders the repository README at build time so there
 *  is exactly one source of truth. Read-mode surface — structure for
 *  comprehension, sticky table of contents, comfortable measure. */
export function Docs({ onBack }: Props) {
  const { nodes, headings } = useMemo(() => renderMarkdown(readme), []);
  const toc = headings.filter((h) => h.level === 2);

  // Deep links (#/docs#section) and top-of-page on open.
  useEffect(() => {
    const target = window.location.hash.split("#")[2];
    if (target) document.getElementById(target)?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, []);

  return (
    <div className="docs">
      <header className="docs-top">
        <button className="docs-back" onClick={onBack}>
          <Icon name="arrow-left" size={14} /> Back
        </button>
        <LogoLockup size={22} />
        <a className="docs-repo" href={REPO_URL} target="_blank" rel="noreferrer">
          View source on GitHub ↗
        </a>
        <ThemeToggle />
      </header>

      <div className="docs-body">
        <nav className="docs-toc" aria-label="Contents">
          <div className="docs-toc-title">Contents</div>
          <ul>
            {toc.map((h) => (
              <li key={h.id}><a href={`#/docs#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth" }); }}>{h.text}</a></li>
            ))}
          </ul>
        </nav>
        <article className="docs-article md">
          {nodes}
        </article>
      </div>
    </div>
  );
}
