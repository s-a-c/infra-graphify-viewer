#!/usr/bin/env bun
// Graphify Viewer — zero-dependency Bun HTTP service.
// Serves a picker over the global graphify store (~/.graphify/global-manifest.json,
// read per request so refreshed graphs appear without restart) and the per-repo
// artifacts the graphify CLI generates (graph.html, GRAPH_TREE.html, GRAPH_REPORT.md).
// Read routes are open and sanitized; mutations (refresh jobs) sit behind a
// service-local bearer token with host/origin checks. Loopback only; central
// Caddy terminates TLS at graphify.stands-macbook-pro.local.

import { readFileSync, existsSync, statSync } from "node:fs";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

function homePath(...suffix) {
  return join(process.env.HOME ?? homedir(), ...suffix);
}

function resolveOptions(options = {}) {
  const storeDir =
    options.storeDir ??
    process.env.GRAPHIFY_STORE_DIR ??
    homePath(".graphify");
  return {
    storeDir,
    storeManifest: options.storeManifest ?? process.env.GRAPHIFY_VIEWER_STORE_MANIFEST ?? join(storeDir, "global-manifest.json"),
    generationsDir: options.generationsDir ?? join(storeDir, "generations"),
    resultsFile: options.resultsFile ?? process.env.GRAPHIFY_VIEWER_RESULTS_FILE ?? join(storeDir, "results", "graphify-refresh-results.jsonl"),
    refreshScript:
      options.refreshScript ??
      process.env.GRAPHIFY_REFRESH_SCRIPT ??
      "/Users/s-a-c/infra/shared/scripts/graphify-refresh.sh",
    token: options.token ?? process.env.GRAPHIFY_VIEWER_TOKEN ?? null,
    tokenPath: options.tokenPath ?? homePath(".config", "graphify-viewer", "token"),
    timeoutMs: options.timeoutMs ?? Number(process.env.GRAPHIFY_VIEWER_JOB_TIMEOUT_MS ?? 900_000),
    killGraceMs: options.killGraceMs ?? Number(process.env.GRAPHIFY_VIEWER_KILL_GRACE_MS ?? 5_000),
    producerTagTimeoutSec: options.producerTagTimeoutSec ?? Number(process.env.GRAPHIFY_VIEWER_TAG_TIMEOUT_S ?? 600),
    outputCap: options.outputCap ?? 1_048_576,
    historyCap: options.historyCap ?? 50,
    snapshotTtlMs: options.snapshotTtlMs ?? 300_000,
    allowedHosts: options.allowedHosts ?? [
      "127.0.0.1",
      "localhost",
      "graphify.stands-macbook-pro.local",
    ],
    originPrefixes: options.originPrefixes ?? [
      "http://127.0.0.1",
      "http://localhost",
      "https://graphify.stands-macbook-pro.local",
    ],
  };
}

const PORT = Number(process.env.GRAPHIFY_VIEWER_PORT ?? 4322);
const HOST = "127.0.0.1";
const SNAPSHOT_TTL_MS = 300_000; // 5 minutes
const BODY_LIMIT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Store reading and status computation
// ---------------------------------------------------------------------------

// tag -> absolute dir containing graphify-out artifacts, derived from the
// manifest's source_path (…/graphify-out/graph.json -> …/graphify-out).
function readStore(options) {
  const manifest = options.storeManifest;
  if (!existsSync(manifest)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return {};
  }
  const out = {};
  for (const [tag, rec] of Object.entries(parsed.repos ?? {})) {
    const dir = rec.source_path ? dirname(rec.source_path) : "";
    if (!dir || !existsSync(dir)) continue;
    out[tag] = {
      dir,
      nodes: rec.node_count ?? 0,
      edges: rec.edge_count ?? 0,
      added: (rec.added_at ?? "").slice(0, 10),
      repoRoot: typeof rec.repo_root === "string" && rec.repo_root ? rec.repo_root : null,
    };
  }
  return out;
}

// Repo root for a tag: explicit repo_root from the manifest when present,
// otherwise graphify-out's parent directory.
function repoRootFor(entry) {
  if (entry.repoRoot && existsSync(entry.repoRoot)) return entry.repoRoot;
  const candidate = dirname(entry.dir);
  return existsSync(candidate) ? candidate : entry.dir;
}

// The current generation record for a tag; null when absent/unreadable.
// Prefers generations/<tag>/current/generation.json, then generations/<tag>/generation.json.
function readGeneration(options, tag) {
  for (const rel of [join(tag, "current", "generation.json"), join(tag, "generation.json")]) {
    const genFile = join(options.generationsDir, rel);
    if (!existsSync(genFile)) continue;
    try {
      const gen = JSON.parse(readFileSync(genFile, "utf8"));
      if (gen && typeof gen === "object") return gen;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function gitHead(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitWorkingTreeDirty(repoRoot) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

const REQUIRED_ARTIFACTS = ["graph.json", "graph.html", "GRAPH_TREE.html", "GRAPH_REPORT.md"];

// Typed managed-item envelope per shared contract §4.
function computeItemStatus(options, tag, entry, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const item = { id: tag, label: tag, kind: "graphify_tag" };
  const base = {
    item,
    can_update: true,
    update_scope: ["selected", "all"],
    last_checked: now,
    details: {},
    job: null,
  };

  // Usable artifact set required before any freshness claim.
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
      status: "missing",
      reason: {
        code: "graphify/artifacts_missing",
        message: `required artifacts absent: ${missingArtifacts.join(", ")}`,
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
      status: "unknown",
      reason: {
        code: "graphify/no_generation_record",
        message: "artifacts present but no usable generation record",
      },
      generated: null,
      current: null,
      details: {},
    };
  }

  const genHead = typeof gen.head === "string" && /^[0-9a-f]{7,64}$/i.test(gen.head) ? gen.head : null;

  if (!genHead) {
    return {
      ...base,
      status: "unknown",
      reason: {
        code: "graphify/generation_metadata_unusable",
        message: "generation record does not carry a usable commit",
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
      status: "unknown",
      reason: { code: "graphify/head_unavailable", message: "repository HEAD could not be determined" },
      generated: { kind: "commit", value: genHead, observed_at: gen.observed_at ?? now },
      current: null,
      details: {},
    };
  }

  const currentRef = { kind: "commit", value: head, observed_at: now };
  const generatedRef = { kind: "commit", value: genHead, observed_at: gen.observed_at ?? now };

  if (head !== genHead) {
    return {
      ...base,
      status: "stale",
      reason: {
        code: "graphify/head_mismatch",
        message: "published generation commit differs from repository HEAD",
      },
      generated: generatedRef,
      current: currentRef,
      details: {},
    };
  }

  // HEAD matches — dirty content stays current with an explicit warning.
  const details = {};
  const warnings = [];
  const dirty = gitWorkingTreeDirty(repoRoot);
  if (dirty || gen.working_tree_dirty === true) {
    details.working_tree_dirty = true;
    warnings.push({
      code: "graphify/working_tree_dirty",
      message: "HEAD matches but working tree has uncommitted changes",
    });
  }
  details.warnings = warnings;
  if (typeof gen.generation_id === "string") details.generation_id = gen.generation_id;

  return {
    ...base,
    status: "current",
    generated: generatedRef,
    current: currentRef,
    ...(warnings.length > 0 ? { reason: warnings[0] } : {}),
    details,
  };
}

function computeStatusCollection(options, nowMs = Date.now()) {
  const store = readStore(options);
  const items = Object.entries(store)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, entry]) => computeItemStatus(options, tag, entry, nowMs));

  const sortedItems = items.map((i) => ({ id: i.item.id, status: i.status }));
  const digestInput = JSON.stringify({ items: sortedItems, product: "graphify-viewer", operation: "refresh" });
  const digest = createHash("sha256").update(digestInput).digest("hex");
  const issuedAt = Date.now();

  return {
    items,
    update_scope: ["selected", "all"],
    snapshot: digest,
    last_checked: new Date(nowMs).toISOString(),
    _snapshot_meta: { issuedAt, expiresAt: issuedAt + options.snapshotTtlMs },
  };
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Strip anything path-like or home-anchored from free text before it leaves. */
function redactText(text, options) {
  let out = String(text ?? "");
  out = out.replaceAll(options.storeDir, "<store>");
  const home = process.env.HOME ?? "";
  if (home) out = out.replaceAll(home.startsWith("/") ? home : `/${home}`, "~");
  return out;
}

// ---------------------------------------------------------------------------
// Job engine — process-local single-flight over the producer-owned script.
// ---------------------------------------------------------------------------

function createJobRegistry() {
  return { history: [], byId: new Map(), activeJobId: null };
}

function randomJobId() {
  return Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function appendOutput(job, text, cap) {
  if (!text) return;
  job.output += text;
  const buffer = Buffer.from(job.output, "utf8");
  if (buffer.length <= cap) return;
  const half = Math.floor(cap / 2);
  const dropped = buffer.length - half * 2;
  job.output = buffer.subarray(0, half).toString("utf8")
    + `\n…[truncated ${dropped} bytes]…\n`
    + buffer.subarray(buffer.length - half).toString("utf8");
  job.truncated = true;
}

function viewJob(job) {
  const lines = job.output.split("\n");
  const head = lines.slice(0, 20).join("\n");
  const tail = lines.slice(-20).join("\n");
  return {
    id: job.id,
    operation: job.operation,
    scope: job.scope,
    state: job.state,
    items: job.items.map(({ proc, ...rest }) => rest),
    progress: job.progress,
    created_at: job.created_at,
    started_at: job.started_at,
    ended_at: job.ended_at,
    reason: job.reason ?? null,
    output: { head, tail, truncated: job.truncated },
  };
}

// graphify-refresh-result/v1 outcome → common per-item outcome.
function mapResultOutcome(outcome) {
  switch (outcome) {
    case "updated": return "updated";
    case "skipped":
    case "tolerated_empty": return "skipped";
    case "cancelled": return "cancelled";
    case "timed_out": return "timed_out";
    default: return "failed";
  }
}

/** Apply one versioned producer result event to pending job items. */
function applyEventToJob(registry, options, job, event) {
  if (event.outcome === "busy") {
    job.busy = true;
    job.reason = {
      code: "graphify/producer_busy",
      message: redactText(event.message ?? "producer lock held", options),
    };
    return;
  }
  const item = job.items.find((i) => i.id === event.tag);
  if (!item || item.outcome !== "pending") return;
  const mapped = mapResultOutcome(event.outcome);
  item.outcome = mapped;
  item.ended_at = event.observed_at ?? new Date().toISOString();
  item.reason = event.message
    ? { code: `graphify/${event.outcome}`, message: redactText(event.message, options) }
    : null;
  if (event.generation_id) item.generation_id = event.generation_id;
  if (mapped === "updated" || mapped === "skipped") job.progress.completed++;
  else job.progress.failed++;
}

function computeAggregateState(job) {
  const outcomes = job.items.map((i) => i.outcome);
  if (outcomes.length === 0) return "failed";
  if (job.cancelled) return "cancelled";
  if (job.timedOut) return "timed_out";
  if (job.busy) return "busy";
  const updated = outcomes.filter((o) => o === "updated").length;
  const failed = outcomes.filter((o) => o === "failed" || o === "timed_out" || o === "cancelled").length;
  if (failed === outcomes.length) return "failed";
  if (updated === outcomes.length) return "completed";
  return "partial";
}

function byteLengthOfFile(path) {
  try {
    const fd = openSync(path, "r");
    try { return fstatSync(fd).size; } finally { closeSync(fd); }
  } catch {
    return -1;
  }
}

/** Read the results JSONL starting at byte offset; returns {text,newOffset}. */
function readResultsTail(path, offset) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", newOffset: offset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: "", newOffset: offset };
    const buf = Buffer.alloc(size - offset);
    const read = readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.subarray(0, read).toString("utf8"), newOffset: offset + read };
  } catch {
    return { text: "", newOffset: offset };
  } finally {
    closeSync(fd);
  }
}

function startJob(registry, options, operation, scope, itemTags, snapshot, store) {
  const job = {
    id: randomJobId(),
    operation,
    scope,
    state: "queued",
    items: itemTags.map((tag) => ({
      id: tag,
      label: store[tag]?.tag ?? tag,
      outcome: "pending",
      started_at: null,
      ended_at: null,
      reason: null,
    })),
    progress: { total: itemTags.length, completed: 0, failed: 0 },
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    output: "",
    truncated: false,
    cancelled: false,
    timedOut: false,
    busy: false,
    proc: null,
    graceTimer: null,
    watchdog: null,
  };
  registry.byId.set(job.id, job);
  registry.activeJobId = job.id;
  registry.history.push(job.id);
  if (registry.history.length > options.historyCap) {
    const old = registry.history.shift();
    registry.byId.delete(old);
  }

  const finishFail = (code, message) => {
    job.state = "failed";
    job.reason = { code, message };
    job.ended_at = new Date().toISOString();
    for (const item of job.items) {
      if (item.outcome === "pending") {
        item.outcome = "failed";
        item.ended_at = job.ended_at;
        item.reason = { code, message };
        job.progress.failed++;
      }
    }
    registry.activeJobId = null;
    return job;
  };

  const script = options.refreshScript;
  if (!script || !existsSync(script)) {
    return finishFail("graphify/producer_unavailable", "refresh script not found");
  }

  const args = scope === "all"
    ? []
    : (() => {
        const a = [];
        for (const t of itemTags) a.push("--tag", t);
        return a;
      })();
  args.push("--timeout", String(Math.floor(options.producerTagTimeoutSec)));

  // Bound results tailing to this run: remember where the producer JSONL ends now.
  const resultsOffsetAtStart = Math.max(byteLengthOfFile(options.resultsFile), 0);

  const env = { ...process.env };
  if (!env.GRAPHIFY_STORE_DIR) env.GRAPHIFY_STORE_DIR = options.storeDir;

  const proc = spawn(script, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.storeDir,
  });
  job.proc = proc;
  job.state = "running";
  job.started_at = new Date().toISOString();
  for (const item of job.items) item.started_at = job.started_at;

  // Watchdog: SIGTERM at deadline, SIGKILL after grace (process-group scoped).
  job.watchdog = setTimeout(() => {
    job.timedOut = true;
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch {} }
    job.graceTimer = setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
    }, options.killGraceMs);
  }, options.timeoutMs);

  // Cancel handler mirrors the watchdog escalation; idempotent via state check.
  job.cancelFn = () => {
    if (job.cancelled || !["queued", "running"].includes(job.state)) return;
    job.cancelled = true;
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch {} }
    job.graceTimer = setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
    }, options.killGraceMs);
  };

  proc.stdout.on("data", (chunk) => appendOutput(job, chunk.toString(), options.outputCap));
  proc.stderr.on("data", (chunk) => appendOutput(job, chunk.toString(), options.outputCap));

  // Poll the producer-owned versioned results JSONL for per-tag outcomes.
  const pollInterval = setInterval(() => {
    const { text, newOffset } = readResultsTail(options.resultsFile, job._resultsOffset ?? resultsOffsetAtStart);
    job._resultsOffset = newOffset;
    if (!text) return;
    appendOutput(job, "", options.outputCap); // noop keeps cap logic centralized
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event?.schema !== "graphify-refresh-result/v1") continue;


      const item = job.items.find((i) => i.id === event.tag);
      applyEventToJob(registry, options, job, event);
    }
  }, 250);

  proc.on("close", () => {
    clearInterval(pollInterval);
    clearTimeout(job.watchdog);
    clearTimeout(job.graceTimer);
    // Final drain of any results written between last poll and exit.
    const { text, newOffset } = readResultsTail(options.resultsFile, job._resultsOffset ?? resultsOffsetAtStart);
    job._resultsOffset = newOffset;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event?.schema === "graphify-refresh-result/v1") {
        const ev = structuredClone(event);
        applyEventToJob(registry, options, job, ev);
      }
    }
    void registry;
    job.ended_at = new Date().toISOString();
    job.state = computeAggregateState(job);
    job.items.forEach((item) => {
      if (item.outcome === "pending") {
        item.outcome = job.cancelled ? "cancelled" : "failed";
        item.ended_at = job.ended_at;
        item.reason = job.cancelled
          ? { code: "graphify/cancelled_before_start", message: "cancelled before the producer reached this item" }
          : { code: "graphify/no_result", message: "producer produced no terminal event for this tag" };
        job.progress.failed++;
      }
    });
    registry.activeJobId = null;
  });

  proc.on("error", () => {
    clearInterval(pollInterval);
    clearTimeout(job.watchdog);
    clearTimeout(job.graceTimer);
    finishFail("graphify/producer_error", "producer subprocess failed to start");
    void registry;
  });

  return job;
}

// ---------------------------------------------------------------------------
// Auth gate (mutations only) — host allowlist, Origin/Referer defense-in-depth,
// bearer token from env or restrictive local file. Generic failures only.
// ---------------------------------------------------------------------------

function readToken(options) {
  if (options.token) return options.token;
  try {
    if (existsSync(options.tokenPath)) {
      const token = readFileSync(options.tokenPath, "utf8").trim();
      return token.length > 0 ? token : null;
    }
  } catch {
    /* unreadable → no token */
  }
  return null;
}

function parseUrlSafe(value) {
  try { return new URL(value); } catch { return null; }
}

function authGate(request, url, options, expectedToken) {
  const rawHost = request.headers.get("host") ?? url.host ?? "";
  const host = rawHost.toLowerCase();
  if (!options.allowedHosts.includes(host.split(":")[0])) {
    return errorResponse("forbidden", 403);
  }
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (origin !== null) {
    const parsed = parseUrlSafe(origin);
    const okHost = parsed && options.allowedHosts.includes(parsed.hostname.toLowerCase());
    if (!okHost) return errorResponse("origin not allowed", 403);
  } else if (referer !== null) {
    const parsed = parseUrlSafe(referer);
    const okHost = parsed && options.allowedHosts.includes(parsed.hostname.toLowerCase());
    if (!okHost) return errorResponse("referer origin not allowed", 403);
  }
  if (!expectedToken) {
    return unauthorized("mutations are disabled: no token configured");
  }
  if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return unauthorized("mutations require a valid bearer token");
  }
  return null;
}

function unauthorized(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="graphify-viewer"',
    },
  });
}

function errorResponse(message, status) {
  return Response.json({ error: message }, { status });
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

// ---------------------------------------------------------------------------
// Strict mutation body handling (spec §5.1): cap, schema, closed vocabulary.
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    return { tooLarge: true };
  }
  const reader = request.body?.getReader();
  if (!reader) return { body: null };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { invalid: true };
  }
}

async function handleJobPost(registry, request, options, expectedToken) {
  const deniedEarly = authGate(request, new URL(request.url), options, expectedToken);
  if (deniedEarly) return deniedEarly;

  const parsedBody = await readJsonBody(request);
  if (parsedBody.tooLarge) return errorResponse("request body exceeds limit", 413);
  if (parsedBody.invalid || parsedBody.body === null || typeof parsedBody.body !== "object" || Array.isArray(parsedBody.body)) {
    return errorResponse("request body must be a JSON object", 400);
  }
  const body = parsedBody.body;

  if (body.operation !== "refresh") {
    return errorResponse(`unknown operation ${JSON.stringify(body.operation ?? null)} (expected: refresh)`, 400);
  }
  if (body.scope !== "selected" && body.scope !== "all") {
    return errorResponse(`unknown scope ${JSON.stringify(body.scope ?? null)} (expected: selected or all)`, 400);
  }
  if (!Array.isArray(body.items)) {
    return errorResponse("items must be an array of tags", 400);
  }
  if (body.scope === "selected" && body.items.length === 0) {
    return errorResponse("items must be a non-empty array of tags for selected scope", 400);
  }
  if (body.items.some((t) => typeof t !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(t))) {
    return errorResponse("items must be valid canonical tags", 400);
  }

  // Snapshot-bound confirmation (spec §5.2): must echo the collection digest.
  const collection = computeStatusCollection(options);
  if (!body.snapshot || typeof body.snapshot !== "string") {
    return errorResponse("snapshot is required", 400);
  }
  if (body.snapshot !== collection.snapshot) {
    return jsonResponse({
      error: "snapshot expired or state changed",
      snapshot: collection.snapshot,
      last_checked: collection.last_checked,
    }, 409);
  }
  if (body.confirmed !== true) {
    return errorResponse("confirmed=true is required after reviewing the scope", 422);
  }
  if (registry.activeJobId) {
    return jsonResponse({ error: "job already running", running: registry.activeJobId }, 409);
  }

  const store = readStore(options);
  let itemTags;
  if (scopeAll(body.scope)) {
    itemTags = Object.keys(store).sort();
    if (itemTags.length === 0) return errorResponse("no managed graphs in store", 400);
  } else {
    itemTags = body.items.filter((t) => Object.hasOwn(store, t));
    if (itemTags.length === 0) {
      return errorResponse("none of the requested tags are managed by the viewer", 400);
    }
  }

  const job = startJob(registry, options, body.operation, body.scope, itemTags, body.snapshot, store);
  return jsonResponse(viewJob(job), 202);
}

function scopeAll(scope) { return scope === "all"; }

// ---------------------------------------------------------------------------
// Picker page — unchanged visual behavior minus private-path display, plus
// selection checkboxes and Update selected / Update all controls.
// ---------------------------------------------------------------------------

const ARTIFACTS = [
  { name: "graph.html", label: "graph", desc: "force-directed graph view" },
  { name: "GRAPH_TREE.html", label: "tree", desc: "collapsible file/symbol tree" },
  { name: "GRAPH_REPORT.md", label: "report", desc: "community + god-node report" },
];

function statusBadge(status) {
  const cls = { current: "ok", stale: "warn", missing: "bad", failed: "bad", unknown: "muted" }[status] ?? "muted";
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
          ${statusBadge("pending-check")}
        </div>
        <div class="count${r.nodes < 1000 ? " small" : ""}">${r.nodes.toLocaleString("en")}
          <small>nodes · <span class="edges">${r.edges.toLocaleString("en")} edges</span></small></div>
        <div class="meta"><span class="added">${esc(r.added)}</span></div>
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
<style>${readFileSync(join(HERE, "public-updates.css"), "utf8")}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Graphify Viewer</h1>
    <button class="theme-toggle" id="theme">◑ theme</button>
  </header>
  <div class="sub"><b>${repos.length}</b> graphs · <b>${total.toLocaleString("en")}</b> nodes · nightly refresh 02:30</div>
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
${readFileSync(join(HERE, "public.js"), "utf8")}
${readFileSync(join(HERE, "public-updates.js"), "utf8")}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// App assembly — exported for fixture tests; module import serves.
// ---------------------------------------------------------------------------

export function createApp(userOptions = {}) {
  const options = resolveOptions(userOptions);
  const registry = createJobRegistry();

  function publicCollection() {
    const col = computeStatusCollection(options);
    return {
      items: col.items,
      update_scope: col.update_scope,
      snapshot: col.snapshot,
      last_checked: col.last_checked,
    };
  }

  async function app(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      const store = readStore(options);
      return Response.json({ ok: true, graphs: Object.keys(store).length });
    }

    // /api/status — status collection (open sanitized reads).
    if (url.pathname === "/api/status") {
      const col = publicCollection();
      if (url.searchParams.has("id")) {
        const id = url.searchParams.get("id");
        const item = col.items.find((i) => i.item.id === id);
        if (!item) return errorResponse("unknown tag", 404);
        return jsonResponse(item);
      }
      return jsonResponse(col);
    }

    // /api/snapshot — opaque bound snapshot with finite TTL.
    if (url.pathname === "/api/snapshot") {
      const col = computeStatusCollection(options);
      return jsonResponse({
        snapshot: col.snapshot,
        observed_at: col.last_checked,
        expires_at: new Date(col._snapshot_meta.expiresAt).toISOString(),
        ttl_ms: options.snapshotTtlMs,
        items: col.items.map((i) => ({
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

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method !== "HEAD") {
      try {
        return new Response(renderIndex(readStore(options)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      } catch (err) {
        return new Response(`picker render failed: ${esc(err.message)}`, { status: 500 });
      }
    }
    if (url.pathname === "/" && request.method === "HEAD") {
      return new Response(null, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Job reads: list + single detail with per-item outcomes.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/jobs") {
      const jobs = [...registry.byId.values()]
        .slice(-options.historyCap)
        .map((j) => viewJob(j));
      return jsonResponse({ jobs });
    }
    const jobDetail = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && jobDetail) {
      const job = registry.byId.get(decodeURIComponent(jobDetail[1]));
      if (!job) return errorResponse("job not found", 404);
      return jsonResponse(viewJob(job));
    }

    // Mutations (spec §5).
    if (request.method === "POST") {
      const expectedToken = readToken(options);
      if (url.pathname === "/api/jobs") {
        return handleJobPost(registry, request, options, expectedToken);
      }
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch) {
        const denied = authGate(request, url, options, expectedToken);
        if (denied) return denied;
        const jobId = decodeURIComponent(cancelMatch[1]);
        const job = registry.byId.get(jobId);
        if (!job) return errorResponse("job not found", 404);
        if (job.state !== "queued" && job.state !== "running") {
          return jsonResponse({ id: job.id, state: job.state, message: "job already terminal" });
        }
        job.cancelFn();
        return jsonResponse({ id: job.id, state: "cancelled", message: "cancel signal sent" });
      }
      const allow = url.pathname === "/api/jobs" ? "GET, HEAD, POST" : "GET, HEAD";
      const response = errorResponse("method not allowed", 405);
      response.headers.set("allow", allow);
      return response;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const allow = url.pathname === "/api/jobs" ? "GET, HEAD, POST" : "GET, HEAD";
      const response = errorResponse("method not allowed", 405);
      response.headers.set("allow", allow);
      return response;
    }

    // /g/<tag>/<artifact> — serve a per-repo artifact from its graphify-out dir
    const m = url.pathname.match(/^\/g\/([^/]+)\/(graph|tree|report)$/);
    if (m) {
      const store = readStore(options);
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
  }

  app.options = options;
  return app;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: HOST, fetch: createApp() });
  console.log(`graphify-viewer listening on http://${HOST}:${PORT}`);
}
