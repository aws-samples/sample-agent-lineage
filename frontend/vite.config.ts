import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Repo-local images referenced from the README (rendered on the /docs
 *  page). Served from the repo in dev and copied into dist/ on build, so the
 *  docs page never depends on an external host and works in any fork. */
const REPO_ROOT = resolve(__dirname, "..");
const DOC_ASSETS = ["docs/img/demo.gif", "deploy/architecture.svg"];
const MIME: Record<string, string> = { ".gif": "image/gif", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

function repoDocAssets(): Plugin {
  return {
    name: "repo-doc-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!DOC_ASSETS.includes(url)) return next();
        const file = join(REPO_ROOT, url);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(statSync(file).size));
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      for (const rel of DOC_ASSETS) {
        const src = join(REPO_ROOT, rel);
        if (!existsSync(src)) continue;
        const dest = join(__dirname, "dist", rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), repoDocAssets()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
