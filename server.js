#!/usr/bin/env bun
// Graphify Viewer — zero-dependency Bun HTTP service.
// Serves a picker over the global graphify store (~/.graphify/global-manifest.json,
// read per request so refreshed graphs appear without restart) and the per-repo
// artifacts the graphify CLI generates (graph.html, GRAPH_TREE.html, GRAPH_REPORT.md).
// Loopback only; central Caddy terminates TLS at graphify.stands-macbook-pro.local.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MANIFEST = resolve(process.env.HOME ?? "", ".graphify/global-manifest.json");
const PORT = Number(process.env.GRAPHIFY_VIEWER_PORT ?? 4322);
const HOST = "127.0.0.1";

// tag -> absolute dir containing graphify-out artifacts, derived from the
// manifest's source_path (…/graphify-out/graph.json -> …/graphify-out).
function readStore() {
  if (!existsSync(STORE_MANIFEST)) return {};
  const m = JSON.parse(readFileSync(STORE_MANIFEST, "utf8"));
  const out = {};
  for (const [tag, rec] of Object.entries(m.repos ?? {})) {
    const dir = dirname(rec.source_path ?? "");
    if (!dir || !existsSync(dir)) continue;
    out[tag] = {
      dir,
      nodes: rec.node_count ?? 0,
      edges: rec.edge_count ?? 0,
      added: (rec.added_at ?? "").slice(0, 10),
    };
  }
  return out;
}

const ARTIFACTS = [
  { name: "graph.html", label: "graph", desc: "force-directed graph view" },
  { name: "GRAPH_TREE.html", label: "tree", desc: "collapsible file/symbol tree" },
  { name: "GRAPH_REPORT.md", label: "report", desc: "community + god-node report" },
];

function esc(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderIndex(store) {
  const repos = Object.entries(store).map(([tag, r]) => ({ tag, ...r }));
  const total = repos.reduce((s, r) => s + r.nodes, 0);
  const cards = repos.map((r) => `
      <div class="card" tabindex="0" data-tag="${esc(r.tag)}">
        <div class="tag">${esc(r.tag)}</div>
        <div class="count${r.nodes < 1000 ? " small" : ""}">${r.nodes.toLocaleString("en")}
          <small>nodes · <span class="edges">${r.edges.toLocaleString("en")} edges</span></small></div>
        <div class="meta"><span class="path">~${esc(r.dir.replace(process.env.HOME ?? "~", ""))}</span> · <span class="added">${esc(r.added)}</span></div>
        <div class="bar ${r.nodes > 1000 ? "warm" : r.nodes > 100 ? "" : "cool"}"><i></i></div>
        <div class="art-links">${ARTIFACTS.filter(a => existsSync(join(r.dir, a.name)))
          .map(a => `<a href="/g/${encodeURIComponent(r.tag)}/${a.label}">${a.label}</a>`).join("")}</div>
      </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en" data-theme="mocha">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Graphify Viewer</title>
<style>${readFileSync(join(HERE, "public.css"), "utf8")}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Graphify Viewer</h1>
    <button class="theme-toggle" id="theme">◑ theme</button>
  </header>
  <div class="sub"><b>${repos.length}</b> graphs · <b>${total.toLocaleString("en")}</b> nodes · nightly refresh 02:30</div>
  <div class="controls">
    <input type="search" id="q" placeholder="filter by tag or path…" aria-label="filter graphs">
    <div class="seg" role="group" aria-label="sort">
      <button data-sort="nodes" class="on">nodes</button>
      <button data-sort="alpha">a–z</button>
      <button data-sort="recency">recent</button>
    </div>
    <div class="cal-wrap">
      <button class="cal-btn" id="calBtn" aria-haspopup="dialog" aria-expanded="false">added-date range</button>
      <div class="cal-pop" id="calPop" role="dialog" aria-label="filter by added date" hidden>
        <div class="cal-title">
          <button class="nav" id="calPrev" aria-label="previous month">‹</button>
          <span id="calMonth"></span>
          <button class="nav" id="calNext" aria-label="next month">›</button>
        </div>
        <div class="cal-grid" id="calGrid"></div>
        <div class="cal-foot">
          <span class="lbl" id="calLbl">no range — all dates</span>
          <div><button id="calToday">today</button><button id="calClear">clear</button></div>
        </div>
      </div>
    </div>
  </div>
  <div class="grid" id="grid">${cards}
  </div>
</div>
<script>
const REPOS = ${JSON.stringify(repos.map(({ dir, ...r }) => r))};
const MAX = Math.max(...REPOS.map(r => r.nodes), 1);
const BAR = ${JSON.stringify(repos.map(r => r.tag))};
${readFileSync(join(HERE, "public.js"), "utf8")}
</script>
</body>
</html>`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      const store = readStore();
      return Response.json({ ok: true, graphs: Object.keys(store).length });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        return new Response(renderIndex(readStore()), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      } catch (err) {
        return new Response(`picker render failed: ${esc(err.message)}`, { status: 500 });
      }
    }

    // /g/<tag>/<artifact> — serve a per-repo artifact from its graphify-out dir
    const m = url.pathname.match(/^\/g\/([^/]+)\/(graph|tree|report)$/);
    if (m) {
      const store = readStore();
      const tag = decodeURIComponent(m[1]);
      const rec = store[tag];
      if (!rec) return new Response("unknown graph tag", { status: 404 });
      const art = ARTIFACTS.find(a => a.label === m[2]);
      const file = join(rec.dir, art.name);
      if (!existsSync(file)) return new Response("artifact not generated for this graph", { status: 404 });
      const body = readFileSync(file);
      const type = MIME[/(\.[a-z]+)$/i.exec(file)?.[1] ?? ""] ?? "application/octet-stream";
      // markdown renders as a simple <pre> — the CLI emits GitHub-flavored md
      if (type.startsWith("text/markdown")) {
        return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(tag)} — report</title><style>body{font:13px/1.55 -apple-system,system-ui,sans-serif;
margin:2rem auto;max-width:60rem;padding:0 1rem;color:#cdd6f4;background:#1e1e2e}
pre{white-space:pre-wrap;font:12px/1.5 "SF Mono",ui-monospace,Menlo,monospace}</style>
</head><body><pre>${esc(body.toString("utf8"))}</pre></body></html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(body, { headers: { "content-type": type } });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`graphify-viewer listening on http://${HOST}:${PORT}`);
