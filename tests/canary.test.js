// Canary for the viewer-kernel migration (K5): prove one managed item end to
// end against a disposable fixture — status -> snapshot-bound confirmation ->
// refresh completes -> artifact still served. Nothing real (no ~/.graphify,
// no LLM extraction) is touched.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";

const ROOT = await mkdtemp(join(tmpdir(), "gv-canary-"));
const PRODUCER = join(import.meta.dir, "fixtures", "fake-refresh.sh");

async function build() {
  const storeDir = join(ROOT, `c-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(storeDir, { recursive: true });
  const tag = "ogc-rn-waterfootprints";
  const repoRoot = join(storeDir, "repos", tag);
  const outDir = join(repoRoot, "graphify-out");
  await mkdir(outDir, { recursive: true });
  const artifacts = [
    ["graph.json", `{"nodes":[],"links":[],"tag":"${tag}"}`],
    ["graph.html", `<html>${tag} graph</html>`],
    ["GRAPH_TREE.html", `<html>${tag} tree</html>`],
    ["GRAPH_REPORT.md", `# ${tag} report`],
  ];
  for (const [name, content] of artifacts) await writeFile(join(outDir, name), content);
  spawnSync("git", ["init", "-q"], { cwd: repoRoot });
  spawnSync("git", ["config", "user.email", "c@e.invalid"], { cwd: repoRoot });
  spawnSync("git", ["add", "-A"], { cwd: repoRoot });
  spawnSync("git", ["commit", "-q", "-m", "s"], { cwd: repoRoot });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
  const genDir = join(storeDir, "generations", tag, "current");
  await mkdir(genDir, { recursive: true });
  await writeFile(join(genDir, "generation.json"), JSON.stringify({
    schema: "graphify-generation/v1", tag, generation_id: `gen-${tag}-1`, head,
    working_tree_dirty: false, observed_at: "2026-08-31T10:00:00Z",
  }));
  await mkdir(join(storeDir, "results"), { recursive: true });
  await writeFile(join(storeDir, "global-manifest.json"), JSON.stringify({
    repos: { [tag]: { source_path: join(outDir, "graph.json"), repo_root: repoRoot, node_count: 42 } },
  }));
  const behaviorFile = join(storeDir, "behavior");
  await writeFile(behaviorFile, "");
  process.env.FAKE_BEHAVIOR_FILE = behaviorFile;
  const app = createApp({ storeDir, refreshScript: PRODUCER, token: "canary-token", timeoutMs: 60_000 });
  return { app, storeDir, behaviorFile, tag, outDir, head };
}

const req = (app, path, opts) => app(new Request(`http://127.0.0.1${path}`, opts));
async function jsonOf(r) { try { return await r.json(); } catch { return null; } }

afterAll(async () => {
  delete process.env.FAKE_BEHAVIOR_FILE;
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("canary: one managed item end to end over the kernel seam", () => {
  test("status -> snapshot-bound refresh -> succeeded -> artifact preserved", async () => {
    const { app, behaviorFile, tag, outDir } = await build();
    await writeFile(behaviorFile, "");

    // 1. Status returns the managed item as current.
    const col = await jsonOf(await req(app, "/api/status"));
    expect(col.items).toHaveLength(1);
    expect(col.items[0].item.id).toBe(tag);
    expect(col.items[0].status).toBe("current");

    // 2. A snapshot is bound; the picker confirms against it.
    const snap = await jsonOf(await req(app, "/api/snapshot"));
    expect(snap.snapshot).toBe(col.snapshot);

    // 3. Refresh starts and completes successfully.
    const start = await req(app, "/api/update", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer canary-token" },
      body: JSON.stringify({ operation: "update", scope: "selected", items: [tag], snapshot: snap.snapshot, confirmed: true }),
    });
    expect(start.status).toBe(202);
    const { job_id } = await jsonOf(start);
    let done;
    for (let i = 0; i < 80; i++) {
      done = await jsonOf(await req(app, `/api/jobs/${job_id}`));
      if (!["queued", "running"].includes(done.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.state).toBe("succeeded");
    expect(done.items[0].id).toBe(tag);
    expect(done.items[0].outcome).toBe("succeeded");

    // 4. Artifact preservation: graph.html still served after the refresh.
    const graph = await (await req(app, `/g/${encodeURIComponent(tag)}/graph`)).text();
    expect(graph).toContain(`${tag} graph`);
    const report = await (await req(app, `/g/${encodeURIComponent(tag)}/report`)).text();
    expect(report).toContain(`# ${tag} report`);
    void outDir;
  });
});