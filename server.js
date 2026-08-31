#!/usr/bin/env bun
// Graphify Viewer — Bun HTTP service migrated to the viewer kernel.
// Composes createViewerServer() from infra/shared/scripts/viewer-kit.mjs
// for auth, snapshot, job engine, and mutation guards. Retains product
// semantics: freshness computation, graphify updater command, HTML picker,
// and per-repo artifact serving. Loopback only; central Caddy terminates
// TLS at graphify.stands-macbook-pro.local.

import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createViewerServer } from '/Users/s-a-c/infra/shared/scripts/viewer-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function homePath(...suffix) {
  return join(process.env.HOME ?? homedir(), ...suffix);
}

function resolveOptions(options = {}) {
  const storeDir =
    options.storeDir ??
    process.env.GRAPHIFY_STORE_DIR ??
    homePath('.graphify');
  return {
    storeDir,
    storeManifest: options.storeManifest ?? process.env.GRAPHIFY_VIEWER_STORE_MANIFEST ?? join(storeDir, 'global-manifest.json'),
    generationsDir: options.generationsDir ?? join(storeDir, 'generations'),
    resultsFile: options.resultsFile ?? process.env.GRAPHIFY_VIEWER_RESULTS_FILE ?? join(storeDir, 'results', 'graphify-refresh-results.jsonl'),
    refreshScript:
      options.refreshScript ??
      process.env.GRAPHIFY_REFRESH_SCRIPT ??
      '/Users/s-a-c/infra/shared/scripts/graphify-refresh.sh',
    token: options.token ?? process.env.GRAPHIFY_VIEWER_TOKEN ?? null,
    tokenPath: options.tokenPath ?? homePath('.config', 'graphify-viewer', 'token'),
    timeoutMs: options.timeoutMs ?? Number(process.env.GRAPHIFY_VIEWER_JOB_TIMEOUT_MS ?? 900_000),
    killGraceMs: options.killGraceMs ?? Number(process.env.GRAPHIFY_VIEWER_KILL_GRACE_MS ?? 5_000),
    producerTagTimeoutSec: options.producerTagTimeoutSec ?? Number(process.env.GRAPHIFY_VIEWER_TAG_TIMEOUT_S ?? 600),
    outputCap: options.outputCap ?? 1_048_576,
    historyCap: options.historyCap ?? 50,
    snapshotTtlMs: options.snapshotTtlMs ?? 300_000,
    allowedHosts: options.allowedHosts ?? [
      '127.0.0.1',
      'localhost',
      'graphify.stands-macbook-pro.local',
    ],
    allowedOrigins: options.allowedOrigins ?? null,
  };
}

// ---------------------------------------------------------------------------
// Store reading (product-owned)
// ---------------------------------------------------------------------------

function isoNow() {
  return new Date().toISOString();
}

function readStore(options) {
  const manifest = options.storeManifest;
  if (!existsSync(manifest)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return {};
  }
  const out = {};
  for (const [tag, rec] of Object.entries(parsed.repos ?? {})) {
    const dir = rec.source_path ? dirname(rec.source_path) : '';
    if (!dir || !existsSync(dir)) continue;
    out[tag] = {
      dir,
      nodes: rec.node_count ?? 0,
      edges: rec.edge_count ?? 0,
      added: (rec.added_at ?? '').slice(0, 10),
      repoRoot: typeof rec.repo_root === 'string' && rec.repo_root ? rec.repo_root : null,
    };
  }
  return out;
}

function repoRootFor(entry) {
  if (entry.repoRoot && existsSync(entry.repoRoot)) return entry.repoRoot;
  const candidate = dirname(entry.dir);
  return existsSync(candidate) ? candidate : entry.dir;
}

function readGeneration(options, tag) {
  for (const rel of [join(tag, 'current', 'generation.json'), join(tag, 'generation.json')]) {
    const genFile = join(options.generationsDir, rel);
    if (!existsSync(genFile)) continue;
    try {
      const gen = JSON.parse(readFileSync(genFile, 'utf8'));
      if (gen && typeof gen === 'object') return gen;
    } catch { /* fall through */ }
  }
  return null;
}

function gitHead(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function gitWorkingTreeDirty(repoRoot) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

const REQUIRED_ARTIFACTS = ['graph.json', 'graph.html', 'GRAPH_TREE.html', 'GRAPH_REPORT.md'];

// ---------------------------------------------------------------------------
// Status computation (product-owned freshness semantics)
// ---------------------------------------------------------------------------

function computeStatus(options) {
  const now = isoNow();
  const store = readStore(options);
  return Object.entries(store)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, entry]) => {
      const base = {
        item: { id: tag, label: tag, kind: 'graphify_tag' },
        can_update: true,
        update_scope: ['selected', 'all'],
        details: {},
        job: null,
      };

      const missingArtifacts = REQUIRED_ARTIFACTS.filter((name) => {
        const file = join(entry.dir, name);
        try {
          return !existsSync(file) || statSync(file).size === 0;
        } catch {
          return true;
        }
      });
      if (missingArtifacts.length > 0) {
        return {
          ...base,
          status: 'missing',
          reason: {
            code: 'graphify/artifacts_missing',
            message: `required artifacts absent: ${missingArtifacts.join(', ')}`,
          },
          generated: null,
          current: null,
          details: { missing_artifacts: missingArtifacts },
        };
      }

      const gen = readGeneration(options, tag);
      if (!gen) {
        return {
          ...base,
          status: 'unknown',
          reason: {
            code: 'graphify/no_generation_record',
            message: 'artifacts present but no usable generation record',
          },
          generated: null,
          current: null,
          details: {},
        };
      }

      const genHead = typeof gen.head === 'string' && /^[0-9a-f]{7,64}$/i.test(gen.head) ? gen.head : null;
      if (!genHead) {
        return {
          ...base,
          status: 'unknown',
          reason: {
            code: 'graphify/generation_metadata_unusable',
            message: 'generation record does not carry a usable commit',
          },
          generated: null,
          current: null,
          details: {},
        };
      }

      const repoRoot = repoRootFor(entry);
      const head = gitHead(repoRoot);
      if (!head) {
        return {
          ...base,
          status: 'unknown',
          reason: { code: 'graphify/head_unavailable', message: 'repository HEAD could not be determined' },
          generated: { kind: 'commit', value: genHead, observed_at: gen.observed_at ?? now },
          current: null,
          details: {},
        };
      }

      // observed_at for current/generated refs must be deterministic across
      // requests (they enter the snapshot digest); the kernel's last_checked
      // carries the live timestamp and is excluded from the digest.
      const currentRef = { kind: 'commit', value: head, observed_at: gen.observed_at ?? now };
      const generatedRef = { kind: 'commit', value: genHead, observed_at: gen.observed_at ?? now };

      if (head !== genHead) {
        return {
          ...base,
          status: 'stale',
          reason: {
            code: 'graphify/head_mismatch',
            message: 'published generation commit differs from repository HEAD',
          },
          generated: generatedRef,
          current: currentRef,
          details: {},
        };
      }

      const details = {};
      const warnings = [];
      const dirty = gitWorkingTreeDirty(repoRoot);
      if (dirty || gen.working_tree_dirty === true) {
        details.working_tree_dirty = true;
        warnings.push({
          code: 'graphify/working_tree_dirty',
          message: 'HEAD matches but working tree has uncommitted changes',
        });
      }
      details.warnings = warnings;
      if (typeof gen.generation_id === 'string') details.generation_id = gen.generation_id;

      return {
        ...base,
        status: 'current',
        generated: generatedRef,
        current: currentRef,
        ...(warnings.length > 0 ? { reason: warnings[0] } : {}),
        details,
      };
    });
}

// ---------------------------------------------------------------------------
// Redaction helpers (product-owned)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Updater (product-owned — spawns graphify-refresh.sh, polls JSONL results)
// ---------------------------------------------------------------------------

function buildUpdater(options) {
  const resultsFile = options.resultsFile;

  function byteLengthOfFile(path) {
    try {
      const fd = openSync(path, 'r');
      try { return fstatSync(fd).size; } finally { closeSync(fd); }
    } catch {
      return -1;
    }
  }

  function readResultsTail(path, offset) {
    let fd;
    try {
      fd = openSync(path, 'r');
    } catch {
      return { text: '', newOffset: offset };
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: '', newOffset: offset };
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      return { text: buf.subarray(0, read).toString('utf8'), newOffset: offset + read };
    } catch {
      return { text: '', newOffset: offset };
    } finally {
      closeSync(fd);
    }
  }

  function mapOutcome(outcome) {
    switch (outcome) {
      case 'updated': return 'succeeded';
      case 'skipped':
      case 'tolerated_empty': return 'succeeded';
      case 'cancelled': return 'cancelled';
      case 'timed_out': return 'failed';
      default: return 'failed';
    }
  }

  return async function updater(payload, ctx) {
    const script = options.refreshScript;
    if (!script || !existsSync(script)) {
      throw Object.assign(
        new Error('refresh script not found'),
        { code: 'graphify/producer_unavailable' },
      );
    }

    const args = payload.scope === 'all'
      ? []
      : (() => {
          const a = [];
          for (const t of payload.items) a.push('--tag', t);
          return a;
        })();
    args.push('--timeout', String(Math.floor(options.producerTagTimeoutSec)));

    const resultsOffsetAtStart = Math.max(byteLengthOfFile(resultsFile), 0);

    const env = { ...process.env };
    if (!env.GRAPHIFY_STORE_DIR) env.GRAPHIFY_STORE_DIR = options.storeDir;

    const child = ctx.spawn([script, ...args], {
      env,
      cwd: options.storeDir,
    });

    let scriptExitCode = 0;
    child.on('exit', (code) => { scriptExitCode = code ?? 0; });

    let scriptDone = false;
    const scriptPromise = new Promise((resolve) => {
      child.on('exit', () => { scriptDone = true; resolve(); });
      child.on('error', () => { scriptDone = true; resolve(); });
    });

    let resultsOffset = resultsOffsetAtStart;
    let sawBusy = false;
    let anyItemFailed = false;
    const drain = (text) => {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (event?.schema !== 'graphify-refresh-result/v1') continue;

        if (event.outcome === 'busy') {
          // Global producer lock: the marker carries no real tag ("-"). Signal
          // a job-level busy failure so all pending items surface
          // graphify/producer_busy (consistent with the OLD pollable "busy").
          sawBusy = true;
          continue;
        }

        const outcome = mapOutcome(event.outcome);
        if (outcome === 'failed' || outcome === 'cancelled') anyItemFailed = true;
        ctx.progress({
          type: 'item',
          id: event.tag,
          outcome,
          reason: event.message
            ? { code: `graphify/${event.outcome}`, message: event.message }
            : undefined,
        });
      }
    };

    const pollInterval = setInterval(() => {
      if (scriptDone) return;
      const { text, newOffset } = readResultsTail(resultsFile, resultsOffset);
      resultsOffset = newOffset;
      if (text) drain(text);
    }, 250);

    await scriptPromise;
    clearInterval(pollInterval);

    // Final drain of any results written between last poll and exit.
    const { text: finalText, newOffset: finalOffset } = readResultsTail(resultsFile, resultsOffset);
    resultsOffset = finalOffset;
    if (finalText) drain(finalText);

    if (scriptExitCode !== 0) {
      if (sawBusy) {
        throw Object.assign(
          new Error('producer reported a lock held elsewhere; refresh not executed'),
          { code: 'graphify/producer_busy' },
        );
      }
      throw Object.assign(
        new Error(`producer exited with code ${scriptExitCode}`),
        { code: 'graphify/producer_error' },
      );
    }

    // The producer exited cleanly but reported item-level failures: preserve
    // the OLD partial/failed aggregation so the job never surfaces as
    // "succeeded" while an item failed.
    if (anyItemFailed) {
      throw Object.assign(
        new Error('producer reported one or more item failures'),
        { code: 'graphify/partial_failure' },
      );
    }
  };
}

// ---------------------------------------------------------------------------
// HTML picker (product-owned — unchanged visual behavior)
// ---------------------------------------------------------------------------

const ARTIFACTS = [
  { name: 'graph.html', label: 'graph', desc: 'force-directed graph view' },
  { name: 'GRAPH_TREE.html', label: 'tree', desc: 'collapsible file/symbol tree' },
  { name: 'GRAPH_REPORT.md', label: 'report', desc: 'community + god-node report' },
];

function statusBadge(status) {
  const cls = { current: 'ok', stale: 'warn', missing: 'bad', failed: 'bad', unknown: 'muted' }[status] ?? 'muted';
  return `<span class="status-badge ${cls}" data-status="${esc(status)}">${esc(status)}</span>`;
}

function pickerControlsMarkup() {
  return `
  <div class="update-controls" id="updateControls">
    <button class="upd-btn" id="updSelected" disabled>Update selected</button>
    <button class="upd-btn" id="updAll">Update all</button>
    <button class="upd-btn subtle" id="updCancel" hidden>Cancel job</button>
    <span class="upd-status" id="updStatus" role="status" aria-live="polite"></span>
  </div>
  <dialog id="confirmDialog" aria-label="Confirm update">
    <form method="dialog">
      <h2>Confirm update</h2>
      <p id="confirmSummary"></p>
      <ul id="confirmItems"></ul>
      <label class="tok">access token <input type="password" id="updToken" autocomplete="off" placeholder="paste once — memory only"></label>
      <div class="dlg-actions">
        <button value="cancel" formnovalidate>Cancel</button>
        <button value="confirm" id="confirmGo" class="primary">Confirm update</button>
      </div>
    </form>
  </dialog>`;
}

function renderIndex(store) {
  const repos = Object.entries(store).map(([tag, r]) => ({ tag, ...r }));
  const total = repos.reduce((s, r) => s + r.nodes, 0);
  const cards = repos.map((r) => `
      <div class="card" tabindex="0" data-tag="${esc(r.tag)}">
        <div class="card-head">
          <input type="checkbox" class="pick" data-tag="${esc(r.tag)}" aria-label="select ${esc(r.tag)} for update">
          <div class="tag">${esc(r.tag)}</div>
          ${statusBadge('pending-check')}
        </div>
        <div class="count${r.nodes < 1000 ? ' small' : ''}">${r.nodes.toLocaleString('en')}
          <small>nodes · <span class="edges">${r.edges.toLocaleString('en')} edges</span></small></div>
        <div class="meta"><span class="added">${esc(r.added)}</span></div>
        <div class="bar ${r.nodes > 1000 ? 'warm' : r.nodes > 100 ? '' : 'cool'}"><i></i></div>
        <div class="art-links">${ARTIFACTS.filter(a => existsSync(join(r.dir, a.name)))
          .map(a => `<a href="/g/${encodeURIComponent(r.tag)}/${a.label}">${a.label}</a>`).join('')}</div>
      </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="mocha">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Graphify Viewer</title>
<style>${readFileSync(join(HERE, 'public.css'), 'utf8')}</style>
<style>${readFileSync(join(HERE, 'public-updates.css'), 'utf8')}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Graphify Viewer</h1>
    <button class="theme-toggle" id="theme">◑ theme</button>
  </header>
  <div class="sub"><b>${repos.length}</b> graphs · <b>${total.toLocaleString('en')}</b> nodes · nightly refresh 02:30</div>
  ${pickerControlsMarkup()}
  <div class="controls">
    <input type="search" id="q" placeholder="filter by tag…" aria-label="filter graphs">
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
const REPOS = ${JSON.stringify(repos.map(({ dir, repoRoot, ...r }) => r))};
const MAX = Math.max(...REPOS.map(r => r.nodes), 1);
const BAR = ${JSON.stringify(repos.map(r => r.tag))};
${readFileSync(join(HERE, 'public.js'), 'utf8')}
${readFileSync(join(HERE, 'public-updates.js'), 'utf8')}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// MIME map
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ---------------------------------------------------------------------------
// App assembly — exported for fixture tests; module import serves.
// ---------------------------------------------------------------------------

export function createApp(userOptions = {}) {
  const options = resolveOptions(userOptions);

  const kernel = createViewerServer({
    computeStatus: () => computeStatus(options),
    runJob: buildUpdater(options),
    options: {
      snapshotTtlMs: options.snapshotTtlMs,
      historyCap: options.historyCap,
      jobTimeoutMs: options.timeoutMs,
      killGraceMs: options.killGraceMs,
      outputCap: options.outputCap,
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      bearerToken: options.token,
      redactions: [process.env.HOME].filter(Boolean),
    },
  });

  async function app(request) {
    const url = new URL(request.url);

    // Product routes (outside kernel scope)
    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method !== 'HEAD') {
      try {
        return new Response(renderIndex(readStore(options)), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (err) {
        return new Response(`picker render failed: ${esc(err.message)}`, { status: 500 });
      }
    }
    if (url.pathname === '/' && request.method === 'HEAD') {
      return new Response(null, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // /g/<tag>/<artifact> — serve a per-repo artifact from its graphify-out dir
    const artifactMatch = url.pathname.match(/^\/g\/([^/]+)\/(graph|tree|report)$/);
    if (artifactMatch) {
      const store = readStore(options);
      const tag = decodeURIComponent(artifactMatch[1]);
      const rec = store[tag];
      if (!rec) return new Response('unknown graph tag', { status: 404 });
      const art = ARTIFACTS.find(a => a.label === artifactMatch[2]);
      const file = join(rec.dir, art.name);
      if (!existsSync(file)) return new Response('artifact not generated for this graph', { status: 404 });
      const body = readFileSync(file);
      const type = MIME[/(\.[a-z]+)$/i.exec(file)?.[1] ?? ''] ?? 'application/octet-stream';
      if (type.startsWith('text/markdown')) {
        return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(tag)} — report</title><style>body{font:13px/1.55 -apple-system,system-ui,sans-serif;
margin:2rem auto;max-width:60rem;padding:0 1rem;color:#cdd6f4;background:#1e1e2e}
pre{white-space:pre-wrap;font:12px/1.5 "SF Mono",ui-monospace,Menlo,monospace}</style>
</head><body><pre>${esc(body.toString('utf8'))}</pre></body></html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(body, { headers: { 'content-type': type } });
    }

    // Delegate all other routes to the kernel (status, snapshot, update, jobs, healthz)
    return kernel(request);
  }

  app.options = options;
  app.kernel = kernel;
  return app;
}

// ---------------------------------------------------------------------------
// Standalone serve
// ---------------------------------------------------------------------------

const PORT = Number(process.env.GRAPHIFY_VIEWER_PORT ?? 4322);
const HOST = '127.0.0.1';

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: HOST, fetch: createApp() });
  console.log(`graphify-viewer listening on http://${HOST}:${PORT}`);
}
