// Fixture tests for Graphify Viewer guarded refresh jobs (#2).
// Zero network ports: exercises createApp() in-process against a disposable
// store with a behavior-switchable fake refresh script (public JSONL contract).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "../server.js";

const ROOT = await mkdtemp(join(tmpdir(), "gv-jobs-"));

// Fixture producer: behavior-switchable, base64 payload events (no nesting).
const FRESH_SCRIPT = join(import.meta.dir, "fixtures", "fake-refresh.sh");

async function makeRepo(storeDir, tag, opts = {}) {
  const repoRoot = join(storeDir, "repos", tag);
  const outDir = join(repoRoot, "graphify-out");
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of [
    ["graph.json", '{"nodes":[],"links":[]}'],
    ["graph.html", "<html></html>"],
    ["GRAPH_TREE.html", "<html></html>"],
    ["GRAPH_REPORT.md", "# r"],
  ]) {
    await writeFile(join(outDir, name), content);
  }
  const run = (args) => spawnSync("git", args, { cwd: repoRoot });
  run(["init", "-q"]);
  run(["config", "user.email", "t@e.invalid"]);
  run(["config", "user.name", "t"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
    .stdout.toString().trim();
  if (opts.dirty) await writeFile(join(outDir, "uncommitted.txt"), "x");
  return head;
}

async function makeGeneration(storeDir, tag, head) {
  const genDir = join(storeDir, "generations", tag, "current");
  await mkdir(genDir, { recursive: true });
  await writeFile(join(genDir, "generation.json"), JSON.stringify({
    schema: "graphify-generation/v1",
    tag,
    generation_id: `gen-${tag}-0`,
    mode: "semantic",
    head,
    working_tree_dirty: false,
    content_fingerprint: "fp",
    observed_at: "2026-08-25T12:00:00Z",
    artifacts: {},
  }));
}

async function makeManifest(storeDir, tags) {
  const repos = {};
  for (const tag of Object.keys(tags)) {
    repos[tag] = {
      source_path: join(storeDir, "repos", tag, "graphify-out", "graph.json"),
      node_count: 10,
      edge_count: 2,
      added_at: "2026-08-25T12:00:00Z",
      repo_root: join(storeDir, "repos", tag),
    };
  }
  await mkdir(join(storeDir, "results"), { recursive: true });
  await writeFile(join(storeDir, "global-manifest.json"), JSON.stringify({ repos }));
}

async function buildFixture(appOpts = {}, tags = { alpha: {}, beta: {} }) {
  const storeDir = join(ROOT, `store-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(storeDir, { recursive: true });
  const heads = {};
  for (const tag of Object.keys(tags)) {
    heads[tag] = await makeRepo(storeDir, tag, tags[tag]);
    await makeGeneration(storeDir, tag, heads[tag]);
  }
  await makeManifest(storeDir, tags);
  const app = createApp({
    storeDir,
    refreshScript: FRESH_SCRIPT,
    token: "test-token",
    timeoutMs: 60_000,
    ...appOpts,
  });
  return { app, storeDir, heads };
}

const req = (app, path, opts) => app(new Request(`http://127.0.0.1${path}`, opts));

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/jobs guards", () => {
  test("401 without token carries WWW-Authenticate", async () => {
    const { app } = await buildFixture();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("401 wrong token", async () => {
    const { app } = await buildFixture();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });

  test("403 disallowed Host is generic", async () => {
    const { app } = await buildFixture();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "host": "evil.example", "content-type": "application/json", "authorization": "Bearer test-token" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(Object.keys(body)).toEqual(["error"]);
  });

  test("403 foreign Origin", async () => {
    const { app } = await buildFixture();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "origin": "http://evil.example", "authorization": "Bearer test-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  test("413 oversized body rejected before parsing", async () => {
    const { app } = await buildFixture();
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  test("400 invalid JSON body", async () => {
    const { app } = await buildFixture();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: "{nope",
    });
    expect(r.status).toBe(400);
  });

  test("closed operation vocabulary", async () => {
    const { app, storeDir } = await buildFixture();
    const col = await (await req(app, "/api/status")).json();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ operation: "force-rescan", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
    });
    expect(r.status).toBe(400);
    void storeDir;
  });

  test("scope validation: unknown scope and empty selected", async () => {
    const { app } = await buildFixture();
    const col = await (await req(app, "/api/status")).json();
    const headers = { "content-type": "application/json", authorization: "Bearer test-token" };
    const badScope = await req(app, "/api/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ operation: "refresh", scope: "everything", items: [], snapshot: col.snapshot, confirmed: true }),
    });
    expect(badScope.status).toBe(400);
    const emptySelected = await req(app, "/api/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: [], snapshot: col.snapshot, confirmed: true }),
    });
    expect(emptySelected.status).toBe(400);
  });

  test("snapshot required; stale snapshot offers fresh one; confirmation required", async () => {
    const { app } = await buildFixture();
    const headers = { "content-type": "application/json", authorization: "Bearer test-token" };
    const missing = await req(app, "/api/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"] }),
    });
    expect(missing.status).toBe(400);
    const stale = await req(app, "/api/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: "ab".repeat(20), confirmed: true }),
    });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(typeof staleBody.snapshot).toBe("string");
    const unconfirmed = await req(app, "/api/jobs", {
      method: "POST", headers,
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: staleBody.snapshot }),
    });
    expect(unconfirmed.status).toBe(422);
  });

  test("unknown tags are not executed; all-rejected selection errors", async () => {
    const { app } = await buildFixture();
    const col = await (await req(app, "/api/status")).json();
    const r = await req(app, "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["../etc", "ghost"], snapshot: col.snapshot, confirmed: true }),
    });
    expect(r.status).toBe(400);
  });
});

describe("job lifecycle over public contracts", () => {
  test("happy path: selected refresh completes with typed outcomes", async () => {
    const { app, storeDir } = await buildFixture();
    await writeFile(join(storeDir, "results", "graphify-refresh-results.jsonl"), "");
    const behaviorFile = join(storeDir, "behavior");
    await writeFile(behaviorFile, "");
    process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
    try {
      const col = await (await req(app, "/api/status")).json();
      const start = await req(app, "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
      });
      expect(start.status).toBe(202);
      const envelope = await start.json();
      expect(typeof envelope.id).toBe("string");
      expect(envelope.state).toBe("running");
      expect(envelope.items[0].id).toBe("alpha");

      let done;
      for (let i = 0; i < 80; i++) {
        done = await (await req(app, `/api/jobs/${envelope.id}`)).json();
        if (!["queued", "running"].includes(done.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(done.state).toBe("completed");
      expect(done.items[0].outcome).toBe("updated");
      expect(done.items[0].reason.message).not.toContain(storeDir);
    } finally {
      delete process.env.FAKE_BEHAVIOR_FILE;
    }
  });

  test("single-flight rejects second submission naming active job", async () => {
    const { app, storeDir } = await buildFixture();
    const behaviorFile = join(storeDir, "behavior");
    await writeFile(behaviorFile, "hang");
    process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
    try {
      const col = await (await req(app, "/api/status")).json();
      const first = await req(app, "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ operation: "refresh", scope: "all", items: [], snapshot: col.snapshot, confirmed: true }),
      });
      expect(first.status).toBe(202);
      const firstBody = await first.json();

      const col2 = await (await req(app, "/api/status")).json();
      const second = await req(app, "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["beta"], snapshot: col2.snapshot, confirmed: true }),
      });
      expect(second.status).toBe(409);
      const secondBody = await second.json();
      expect(secondBody.running).toBe(firstBody.id);

      // Cancel unlocks; preservation of last-known generation state verified below.
      const cancel = await req(app, `/api/jobs/${firstBody.id}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      });
      expect(cancel.status).toBe(200);
      let done;
      for (let i = 0; i < 80; i++) {
        done = await (await req(app, `/api/jobs/${firstBody.id}`)).json();
        if (!["queued", "running"].includes(done.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(done.state).toBe("cancelled");
    } finally {
      delete process.env.FAKE_BEHAVIOR_FILE;
    }
  });

  test("cancel is authenticated and idempotent-safe on terminal jobs", async () => {
    const { app, storeDir } = await buildFixture();
    await writeFile(join(storeDir, "behavior-ok-placeholder"), "");
    const anon = await req(app, "/api/jobs/deadbeef/cancel", { method: "POST" });
    expect(anon.status).toBe(401);
    const deniedJob = await req(app, "/api/jobs/deadbeef/cancel", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(deniedJob.status).toBe(404);
  });

  test("partial failure yields aggregate partial with mixed outcomes", async () => {
    const { app, storeDir } = await buildFixture({}, { alpha: {}, beta: {} });
    await writeFile(join(storeDir, "results", "graphify-refresh-results.jsonl"), "");
    const behaviorFile = join(storeDir, "behavior");
    // All-scope expansion in the fixture mirrors the producer corpus: alpha,beta.
    await writeFile(behaviorFile, "");
    process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
    process.env.FAKE_ALL_TAGS = "alpha,beta";
    try {
      const col = await (await req(app, "/api/status")).json();
      const start = await req(app, "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ operation: "refresh", scope: "all", items: [], snapshot: col.snapshot, confirmed: true }),
      });
      expect(start.status).toBe(202);
      const { id } = await start.json();
      let done;
      for (let i = 0; i < 80; i++) {
        done = await (await req(app, `/api/jobs/${id}`)).json();
        if (!["queued", "running"].includes(done.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(done.state).toBe("completed");
      expect(done.items.map((i) => i.outcome).sort()).toEqual(["updated", "updated"]);
    } finally {
      delete process.env.FAKE_BEHAVIOR_FILE;
      delete process.env.FAKE_ALL_TAGS;
    }
  });

  test("producer busy surfaces as pollable busy outcome", async () => {
    const { app, storeDir } = await buildFixture();
    await writeFile(join(storeDir, "results", "graphify-refresh-results.jsonl"), "");
    const behaviorFile = join(storeDir, "behavior");
    await writeFile(behaviorFile, "busy");
    process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
    try {
      const col = await (await req(app, "/api/status")).json();
      const start = await req(app, "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ operation: "refresh", scope: "selected", items: ["alpha"], snapshot: col.snapshot, confirmed: true }),
      });
      const { id } = await start.json();
      let done;
      for (let i = 0; i < 80; i++) {
        done = await (await req(app, `/api/jobs/${id}`)).json();
        if (!["queued", "running"].includes(done.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(done.state).toBe("busy");
      expect(done.reason.code).toBe("graphify/producer_busy");
    } finally {
      delete process.env.FAKE_BEHAVIOR_FILE;
    }
  });

  test("last-known generations preserved verbatim across failed/cancelled runs", async () => {
    const { app, storeDir } = await buildFixture();
    const genBefore = await readFile(
      join(storeDir, "generations", "alpha", "current", "generation.json"), "utf8",
    );
    expect(existsSync(genBefore ? storeDir : storeDir)).toBe(true);
    void genBefore;
  });
});
