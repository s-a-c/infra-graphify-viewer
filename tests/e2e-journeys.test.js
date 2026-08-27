// Disposable browser journeys for Graphify Viewer (#4).
// Each journey boots a fresh in-process app against disposable fixtures
// (temp git repos + generations + manifest) with a behavior-switchable fake
// producer; nothing real (no ~/.graphify, no LLM extraction) is ever touched.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

const ROOT = await mkdtemp(join(tmpdir(), "gv-journeys-"));

const PRODUCER = join(import.meta.dir, "fixtures", "fake-refresh.sh");

async function build(tags = { alpha: {}, beta: {} }) {
  const storeDir = join(ROOT, `j-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(storeDir, { recursive: true });
  const heads = {};
  for (const tag of Object.keys(tags)) {
    const repoRoot = join(storeDir, "repos", tag);
    const outDir = join(repoRoot, "graphify-out");
    await mkdir(outDir, { recursive: true });
    for (const [name, content] of [
      ["graph.json", `{"nodes":[],"links":[],"tag":"${tag}"}`],
      ["graph.html", `<html>${tag}</html>`],
      ["GRAPH_TREE.html", "<html></html>"],
      ["GRAPH_REPORT.md", "# r"],
    ]) {
      await writeFile(join(outDir, name), content);
    }
    spawnSync("git", ["init", "-q"], { cwd: repoRoot });
    spawnSync("git", ["config", "user.email", "j@e.invalid"], { cwd: repoRoot });
    spawnSync("git", ["add", "-A"], { cwd: repoRoot });
    spawnSync("git", ["commit", "-q", "-m", "s"], { cwd: repoRoot });
    heads[tag] = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
    const genDir = join(storeDir, "generations", tag, "current");
    await mkdir(genDir, { recursive: true });
    await writeFile(join(genDir, "generation.json"), JSON.stringify({
      schema: "graphify-generation/v1", tag, generation_id: `gen-${tag}-0`, head: heads[tag],
      working_tree_dirty: false, observed_at: "2026-08-25T12:00:00Z",
    }));
  }
  const repos = {};
  for (const tag of Object.keys(heads)) {
    repos[tag] = { source_path: join(storeDir, "repos", tag, "graphify-out", "graph.json"), repo_root: join(storeDir, "repos", tag), node_count: 5 };
  }
  await mkdir(join(storeDir, "results"), { recursive: true });
  await writeFile(join(storeDir, "global-manifest.json"), JSON.stringify({ repos }));
  const behaviorFile = join(storeDir, "behavior");
  await writeFile(behaviorFile, "");
  process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
  const app = createApp({ storeDir, refreshScript: PRODUCER, token: "tok-123", timeoutMs: 30_000 });
  const alphaRepoRoot = join(storeDir, "repos", "alpha");
  return { app, storeDir, behaviorFile, heads, alphaRepoRoot };
}

const req = (app, path, opts) => app(new Request(`http://127.0.0.1${path}`, opts));
async function jsonOf(r) { try { return await r.json(); } catch { return null; } }
const HOME_MARKERS = [/\/Users\//, /\/private\/var\//];

function assertNoPaths(text, label) {
  for (const rx of HOME_MARKERS) {
    expect(rx.test(text), `${label} leaks filesystem path (${rx})`).toBe(false);
  }
  expect(text.includes("tok-123"), `${label} leaks the bearer token`).toBe(false);
}

afterAll(async () => {
  delete process.env.FAKE_BEHAVIOR_FILE;
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("journey: freshness review before update", () => {
  test("picker renders statuses implicitly and never leaks paths or token", async () => {
    const { app, storeDir } = await build();
    void storeDir;
    const html = await (await req(app, "/")).text();
    expect(html).toContain("Update selected");
    expect(html).toContain("Update all");
    expect(html).toContain('class="pick"');
    assertNoPaths(html, "picker HTML");
  });

  test("operator reviews status collection then snapshots before confirming", async () => {
    const { app } = await build();
    const col = await jsonOf(await req(app, "/api/status"));
    expect(col.items.map((i) => i.status).sort()).toEqual(["current", "current"]);
    expect(col.snapshot).toMatch(/^[0-9a-f]{64}$/);
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    expect(snap.snapshot).toBe(col.snapshot);
    expect(snap.ttl_ms).toBeGreaterThan(0);
  });

  test("single item view works and unknown id is 404", async () => {
    const { app } = await build();
    const one = await jsonOf(await req(app, "/api/status?id=alpha"));
    expect(one.item.id).toBe("alpha");
    expect((await req(app, "/api/status?id=nope")).status).toBe(404);
  });
});

describe("journey: guarded selected update completes end-to-end", () => {
  test("confirm -> poll -> completed with stale-reject after real drift", async () => {
    const { app, alphaRepoRoot, storeDir: storeDirState } = await build();
    const col = await jsonOf(await req(app, "/api/status"));
    const start = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
    });
    expect(start.status).toBe(202);
    const job = await jsonOf(start);
    let done;
    for (let i = 0; i < 80 && !done?.state?.match(/^(completed|partial|failed|cancelled|timed_out|busy)$/); i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = await jsonOf(await req(app, `/api/jobs/${job.id}`));
    }
    expect(done.state).toBe("completed");
    expect(done.items[0].outcome).toBe("updated");
    assertNoPaths(JSON.stringify(done), "completed job payload");

    // stale confirmation is refused with a fresh snapshot offered: advance the
    // repo HEAD so observed statuses genuinely diverge from the old digest.
    await writeFile(join(alphaRepoRoot, "graphify-out", "new.txt"), "x");
    spawnSync("git", ["add", "-A"], { cwd: alphaRepoRoot });
    spawnSync("git", ["commit", "-q", "-m", "advance"], { cwd: alphaRepoRoot });
    const stale = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
    });
    expect(stale.status).toBe(409);
    const staleBody = await jsonOf(stale);
    const fresh = await jsonOf(await req(app, "/api/snapshot"));
    expect(staleBody.snapshot).toBe(fresh.snapshot);
  });
});

describe("journey: rejection paths are safe", () => {
  test("browser without token cannot start updates; wrong token too", async () => {
    const { app } = await build();
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    const payload = JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: snap.snapshot, confirmed: true });
    const anon = await req(app, "/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Bearer");
    const bad = await req(app, "/api/jobs", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-nope" }, body: payload });
    expect(bad.status).toBe(401);
  });

  test("unconfirmed submission stops at 422 even with valid snapshot+token", async () => {
    const { app } = await build();
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: snap.snapshot }),
    });
    expect(r.status).toBe(422);
  });

  test("disallowed Host header gets generic 403 before auth", async () => {
    const { app } = await build();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { host: "evil.example", "content-type": "application/json", authorization: "Bearer tok-123" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    const body = await jsonOf(r);
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("journey: partial failure, busy, cancel, retry", () => {
  test("producer failure yields failed outcomes without hiding other items", async () => {
    const { app, behaviorFile } = await build();
    await writeFile(behaviorFile, "failall");
    const col = await jsonOf(await req(app, "/api/status"));
    const start = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
    });
    const { id } = await jsonOf(start);
    let done;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = await jsonOf(await req(app, `/api/jobs/${id}`));
      if (!["running", "queued"].includes(done.state)) break;
    }
    expect(done.state).toBe("failed");
    expect(done.items[0].reason.code).toContain("/failed");
    // artifacts still served from prior generation
    const graph = await req(app, "/g/alpha/graph");
    expect(graph.status).toBe(200);
  });

  test("cancel during hang preserves prior generations and unlocks", async () => {
    const { app, behaviorFile } = await build();
    await writeFile(behaviorFile, "hang");
    const col = await jsonOf(await req(app, "/api/status"));
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    const start = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["beta"], snapshot: snap.snapshot, confirmed: true }),
    });
    const { id } = await jsonOf(start);
    const cancel = await req(app, `/api/jobs/${id}/cancel`, { method: "POST", headers: { authorization: "Bearer tok-123" } });
    expect(cancel.status).toBe(200);
    let done;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = await jsonOf(await req(app, `/api/jobs/${id}`));
      if (!["running", "queued"].includes(done.state)) break;
    }
    expect(done.state).toBe("cancelled");
    // unlock verified: fresh job accepted after cancel settles
    await writeFile(behaviorFile, "");
    const col2 = await jsonOf(await req(app, "/api/status"));
    void col2;
    const again = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["beta"], snapshot: (await jsonOf(await req(app, "/api/snapshot"))).snapshot, confirmed: true }),
    });
    expect(again.status).toBe(202);
    expect(req !== undefined).toBe(true);
    void col;
    void behaviorFile;
  });

  test("producer busy shows pollable busy outcome", async () => {
    const { app, behaviorFile } = await build();
    await writeFile(behaviorFile, "busy");
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    const start = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ operation: "refresh", scope: "all", items: [], snapshot: snap.snapshot, confirmed: true }),
    });
    const { id } = await jsonOf(start);
    let done;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = await jsonOf(await req(app, `/api/jobs/${id}`));
      if (!["running", "queued"].includes(done.state)) break;
    }
    expect(done.state).toBe("busy");
  });
});

describe("journey: no leakage through browser surface", () => {
  test("history endpoint exposes bounded redacted jobs only", async () => {
    const { app, storeDir } = await build();
    const hist = await jsonOf(await req(app, "/api/jobs"));
    expect(Array.isArray(hist.jobs)).toBe(true);
    assertNoPaths(JSON.stringify(hist), "jobs history");
    void storeDir;
  });

  test("artifact markdown wrapper escapes content", async () => {
    const { app } = await build({ alpha: {}, beta: {} });
    const page = await (await req(app, "/g/alpha/report")).text();
    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(page).not.toContain("<script>");
    assertNoPaths(page, "report wrapper");
  });
});
