#!/usr/bin/env bun
// Graphify Viewer — zero-dependency Bun HTTP service.
// Serves a picker over the global graphify store (~/.graphify/global-manifest.json,
// read per request so refreshed graphs appear without restart) and the per-repo
// artifacts the graphify CLI generates (graph.html, GRAPH_TREE.html, GRAPH_REPORT.md).
// Loopback only; central Caddy terminates TLS at graphify.stands-macbook-pro.local.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_MANIFEST = resolve(process.env.GRAPHIFY_STORE_DIR ?? join(process.env.HOME ?? "", ".graphify"), "global-manifest.json");
const GENERATIONS_DIR = resolve(process.env.GRAPHIFY_STORE_DIR ?? join(process.env.HOME ?? "", ".graphify"), "generations");
const PORT = Number(process.env.GRAPHIFY_VIEWER_PORT ?? 4322);
const HOST = "127.0.0.1";
const SNAPSHOT_TTL_MS = 300_000; // 5 minutes

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

// Read the current generation record for a tag. Returns null when missing.
function readGeneration(tag) {
  const genFile = join(GENERATIONS_DIR, tag, "current", "generation.json");
  if (!existsSync(genFile)) return null;
  try {
    return JSON.parse(readFileSync(genFile, "utf8"));
  } catch {
    return null;
  }
}

// Get current HEAD for a repo path derived from the manifest.
function getCurrentHead(storeEntry) {
  try {
    // storeEntry.dir is …/graphify-out; repo root is two levels up.
    const repoRoot = resolve(storeEntry.dir, "..");
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Check if working tree is dirty.
function isWorkingTreeDirty(storeEntry) {
  try {
    const repoRoot = resolve(storeEntry.dir, "..");
    const status = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

const REQUIRED_ARTIFACTS = ["graph.json", "graph.html", "GRAPH_TREE.html", "GRAPH_REPORT.md"];

// Compute status for a single managed item.
function computeStatus(tag, storeEntry) {
  const gen = readGeneration(tag);
  const now = new Date().toISOString();
  const item = { id: tag, label: tag };

  // No generation at all → missing.
  if (!gen) {
    return {
      item,
      status: "missing",
      reason: { code: "no_generation", message: "no generation record found" },
      can_update: true,
      update_scope: ["selected", "all"],
      last_checked: now,
      details: {},
      job: null,
    };
  }

  // Check required artifacts exist and are non-empty.
  const missingArtifacts = REQUIRED_ARTIFACTS.filter(
    (a) => !existsSync(join(storeEntry.dir, a)) || statSync(join(storeEntry.dir, a)).size === 0,
  );
  if (missingArtifacts.length > 0) {
    return {
      item,
      status: "missing",
      reason: {
        code: "missing_artifacts",
        message: `required artifacts absent: ${missingArtifacts.join(", ")}`,
      },
      generated: { kind: "commit", value: gen.head ?? "", observed_at: gen.observed_at ?? now },
      can_update: true,
      update_scope: ["selected", "all"],
      last_checked: now,
      details: { missing_artifacts: missingArtifacts },
      job: null,
    };
  }

  // Check HEAD alignment.
  const currentHead = getCurrentHead(storeEntry);
  const headMatches = currentHead && gen.head && currentHead === gen.head;

  if (!headMatches) {
    return {
      item,
      status: "stale",
      reason: {
        code: "head_mismatch",
        message: currentHead
          ? "repository HEAD has diverged from generated commit"
          : "could not determine repository HEAD",
      },
      generated: { kind: "commit", value: gen.head ?? "", observed_at: gen.observed_at ?? now },
      current: currentHead
        ? { kind: "commit", value: currentHead, observed_at: now }
        : undefined,
      can_update: true,
      update_scope: ["selected", "all"],
      last_checked: now,
      details: {},
      job: null,
    };
  }

  // HEAD matches — check dirty state.
  const dirty = isWorkingTreeDirty(storeEntry);
  const details = {};
  if (dirty || gen.working_tree_dirty) {
    details.working_tree_dirty = true;
  }

  return {
    item,
    status: "current",
    generated: { kind: "commit", value: gen.head ?? "", observed_at: gen.observed_at ?? now },
    current: { kind: "commit", value: currentHead ?? gen.head ?? "", observed_at: now },
    can_update: true,
    update_scope: ["selected", "all"],
    last_checked: now,
    details,
    job: null,
    ...(dirty || gen.working_tree_dirty
      ? { reason: { code: "working_tree_dirty", message: "generated commit matches HEAD but working tree has uncommitted changes" } }
      : {}),
  };
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

    // /api/status — status collection for all managed items.
    if (url.pathname === "/api/status") {
      const store = readStore();
      const items = Object.entries(store).map(([tag, entry]) => computeStatus(tag, entry));
      const snapshot = crypto.randomUUID();
      return Response.json({
        items,
        update_scope: ["selected", "all"],
        snapshot,
        last_checked: new Date().toISOString(),
      });
    }

    // /api/snapshot — opaque snapshot with TTL binding.
    if (url.pathname === "/api/snapshot") {
      const store = readStore();
      const items = Object.entries(store).map(([tag, entry]) => computeStatus(tag, entry));
      const snapshotId = crypto.randomUUID();
      const observedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString();
      return Response.json({
        snapshot: snapshotId,
        observed_at: observedAt,
        expires_at: expiresAt,
        ttl_ms: SNAPSHOT_TTL_MS,
        items: items.map((i) => ({
          id: i.item.id,
          label: i.item.label,
          status: i.status,
          reason: i.reason ?? null,
          generated: i.generated ?? null,
          current: i.current ?? null,
          details: i.details ?? {},
        })),
        capabilities: { update_scope: ["selected", "all"] },
      });
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
