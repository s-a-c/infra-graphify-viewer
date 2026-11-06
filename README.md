# infra-graphify-viewer

Centralized viewer for the global graphify store: a zero-dependency Bun HTTP
service serving a picker over the 12 tracked repo graphs plus their
CLI-generated artifacts, behind central Caddy at
`https://graphify.stands-macbook-pro.local/`.

- Docs: [docs/2401-contents.md](docs/2401-contents.md)
- Operation runbook: [docs/2408-operation.md](docs/2408-operation.md)
- Scope contract for agents: [AGENTS.md](AGENTS.md)

## Overview

Single-server component. `server.js` composes `createViewerServer()` from the
shared viewer kernel (`/Users/s-a-c/infra/shared/scripts/viewer-kit.mjs`,
absolute import, outside this package) for auth, snapshot, job engine, and
mutation guards, and retains product-owned semantics: store freshness
computation, the `graphify-refresh.sh` updater, the HTML card picker, and
per-repo artifact serving. `public.js` is the sort/filter/calendar/theme/3D
picker script; `public-updates.js` is the snapshot-bound update flow.
`prototype/picker-prototype.html` is the folded-from design artifact.

## Interface

Server (`server.js`):
- `createApp(userOptions)` — exported factory (fixture tests); returns the fetch app with `.options` and `.kernel` attached (`server.js:createApp`).
- `resolveOptions` — store paths from `GRAPHIFY_STORE_DIR` (default `~/.graphify`), `GRAPHIFY_VIEWER_STORE_MANIFEST` (`global-manifest.json`), `GRAPHIFY_VIEWER_RESULTS_FILE` (refresh results JSONL), `GRAPHIFY_REFRESH_SCRIPT`, `GRAPHIFY_VIEWER_TOKEN`, `GRAPHIFY_VIEWER_PORT` (default 4322) (`server.js:resolveOptions`).
- Routes served directly:
  - `GET/HEAD /` and `/index.html` — server-rendered card picker (`server.js:renderIndex`).
  - `GET /g/<tag>/(graph|tree|report)` — serves a per-repo artifact (`graph.html`, `GRAPH_TREE.html`, `GRAPH_REPORT.md`) from its graphify-out dir; markdown is HTML-escaped into a wrapper page (`server.js:app` artifactMatch branch, `server.js:ARTIFACTS`).
- Routes delegated to the viewer kernel: `/api/status`, `/api/snapshot`, `/api/update`, `/api/jobs*`, `/healthz` (`server.js:app` kernel delegation).
- Freshness model: `computeStatus` maps each store tag to `current|stale|missing|unknown` via `REQUIRED_ARTIFACTS` presence, the generation record commit (`readGeneration`), and live `gitHead` comparison (`server.js:computeStatus`).
- Updater: `buildUpdater` spawns the refresh script with `--tag` args (or none for `scope: all`) and polls the JSONL results file (`schema === 'graphify-refresh-result/v1'`) (`server.js:buildUpdater`).

Browser:
- `public.js` — `state`, `render`, `wire`, calendar range filter (`drawCal`, `onCalPick`), theme (`applyTheme`, `localStorage['gv-theme']`), sort segments; server-injected `REPOS`/`MAX` globals.
- `public-updates.js` — IIFE with `api` (status/snapshot/update/cancel fetches), `paintStatuses`, `openConfirm`, `startJob` (Bearer token + `snapshot` + `confirmed: true` → `/api/update`), `pollJob` (900 ms polling of `/api/jobs/{id}`).

## Invariants

- Bind is loopback-only: `HOST = '127.0.0.1'`, port from `GRAPHIFY_VIEWER_PORT` (default 4322) (`server.js:PORT`, `server.js:HOST`).
- Reads are tokenless; every update requires Bearer token + fresh snapshot + `confirmed: true` through the kernel (`server.js:createApp`, `public-updates.js:startJob`).
- The access token lives in page memory only — never storage, never URLs (`public-updates.js:sessionStorageToken` comment and module-variable backing).
- `observed_at` for current/generated refs is deterministic across requests (the generation record's value, not wall-clock) because they enter the snapshot digest; the kernel's `last_checked` is excluded (`server.js:computeStatus` comment).
- A busy producer (`outcome: 'busy'` marker) fails the whole job with `graphify/producer_busy`; item-level failures force `graphify/partial_failure` so a job never surfaces succeeded while an item failed (`server.js:buildUpdater`).
- Only artifacts present for a tag get links in the picker; unknown tags and missing artifacts return 404 (`server.js:app` artifact branch).
- `prototype/` is a design artifact, not served code (`public.js` header: "Folded from the accepted prototype/picker artifact").

## Side Effects

- Reads the graphify store: `~/.graphify/global-manifest.json`, `generations/<tag>/…/generation.json`, and tails `results/graphify-refresh-results.jsonl` (`server.js:readStore`, `readGeneration`, `buildUpdater:readResultsTail`).
- Runs `git rev-parse HEAD` and `git status --porcelain` in each tracked repo root (`server.js:gitHead`, `server.js:gitWorkingTreeDirty`).
- Update jobs spawn `/Users/s-a-c/infra/shared/scripts/graphify-refresh.sh` via the kernel job engine (cwd = store dir; injects `GRAPHIFY_STORE_DIR` if unset) — the only writer to the store (`server.js:buildUpdater`).
- Serves artifact files from repo graphify-out directories over HTTP (`server.js:app`).
- Browser writes `localStorage['gv-theme']` (`public.js:applyTheme`).

## Verification

- Run: `bun test` (Bun test suite in `tests/`: canary, e2e journeys, jobs API, and `test-status-api.sh` with fixture stores — `tests/canary.test.js` imports `bun:test`).

Non-contract assets (no contract file generated): `docs/` (markdown documentation set), `tests/` (excluded test-only tree), `prototype/` (static design artifact), `graphify-out/` (generated knowledge graph, pruned).
