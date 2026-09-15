import { Fragment, type ReactNode } from "react";

/** Minimal GitHub-flavoured Markdown → React renderer for the project docs.
 *
 *  Purpose-built so the docs page needs no markdown/sanitizer dependency and
 *  has no HTML-injection surface at all: output is a React element tree and
 *  every text node is escaped by React itself. Nothing ever touches
 *  innerHTML. Covers the dialect the README actually uses — headings,
 *  paragraphs, bullet/numbered lists, GFM tables, fenced code, inline code,
 *  links, images, bold, italics, blockquotes and rules. Raw HTML in the
 *  source is rendered as literal text, never interpreted.
 *
 *  Links: only http(s) and in-page anchors render as anchors (same rule the
 *  lineage_url XSS fix uses). Relative repo paths are rewritten to the
 *  public GitHub repo so they resolve from inside the app. */

export const REPO_URL = "https://github.com/aws-samples/sample-agent-lineage";
const REPO_BLOB = `${REPO_URL}/blob/main/`;
const REPO_RAW = `https://raw.githubusercontent.com/aws-samples/sample-agent-lineage/main/`;

function resolveHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("#")) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // javascript:, data:, mailto: … refused
  return REPO_BLOB + h.replace(/^\.?\//, "");
}
/** Repo images the app serves itself (see vite.config.ts repoDocAssets).
 *  Anything else repo-relative falls back to the raw GitHub URL. */
const LOCAL_ASSETS = new Set(["docs/img/demo.gif", "deploy/architecture.svg"]);
function resolveSrc(src: string): string | null {
  const s = src.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  const rel = s.replace(/^\.?\//, "");
  return LOCAL_ASSETS.has(rel) ? `/${rel}` : REPO_RAW + rel;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

/* ---------------- inline ---------------- */

const INLINE = /(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^))]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      const mm = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(tok)!;
      const src = resolveSrc(mm[2]);
      out.push(src ? <img key={k} src={src} alt={mm[1]} loading="lazy" /> : <span key={k}>{mm[1]}</span>);
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      const href = resolveHref(mm[2]);
      const inner = renderInline(mm[1], k);
      out.push(
        href ? (
          <a key={k} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{inner}</a>
        ) : (
          <span key={k}>{inner}</span>
        ),
      );
    } else if (m[4]) {
      out.push(<strong key={k}>{renderInline(tok.slice(2, -2), k)}</strong>);
    } else {
      out.push(<em key={k}>{renderInline(tok.slice(1, -1), k)}</em>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------------- blocks ---------------- */

export interface Heading { level: number; text: string; id: string }

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
const isTableSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);

export function renderMarkdown(src: string): { nodes: ReactNode[]; headings: Heading[] } {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  const headings: Heading[] = [];
  let i = 0, key = 0;
  const k = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      nodes.push(<pre key={k()} data-lang={lang || undefined}><code>{buf.join("\n")}</code></pre>);
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/\s+#+\s*$/, "");
      const id = slugify(text);
      headings.push({ level, text, id });
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      nodes.push(<Tag key={k()} id={id}>{renderInline(text, id)}</Tag>);
      i++;
      continue;
    }

    // rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { nodes.push(<hr key={k()} />); i++; continue; }

    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const tk = k();
      nodes.push(
        <div key={tk} className="md-table-wrap">
          <table>
            <thead><tr>{head.map((c, ci) => <th key={ci}>{renderInline(c, `${tk}h${ci}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, ci) => <td key={ci}>{renderInline(r[ci] ?? "", `${tk}r${ri}c${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      const bk = k();
      nodes.push(<blockquote key={bk}>{renderInline(buf.join(" "), bk)}</blockquote>);
      continue;
    }

    // lists (bullet or ordered; a continuation line is indented)
    const li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      const lk = k();
      const children = items.map((t, ii) => <li key={ii}>{renderInline(t, `${lk}i${ii}`)}</li>);
      nodes.push(ordered ? <ol key={lk}>{children}</ol> : <ul key={lk}>{children}</ul>);
      continue;
    }

    // paragraph: gather until blank line or a block start
    const buf: string[] = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) && !/^```/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) buf.push(lines[i++]);
    if (buf.length) {
      const pk = k();
      const text = buf.join(" ");
      // an image alone on its line becomes a figure
      const soloImg = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(text.trim());
      if (soloImg) {
        const src = resolveSrc(soloImg[2]);
        nodes.push(src ? <figure key={pk}><img src={src} alt={soloImg[1]} loading="lazy" /></figure> : <Fragment key={pk} />);
      } else {
        nodes.push(<p key={pk}>{renderInline(text, pk)}</p>);
      }
      continue;
    }
    i++;
  }
  return { nodes, headings };
}
