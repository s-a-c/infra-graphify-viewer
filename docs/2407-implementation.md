---
type: reference
title: Graphify Viewer implementation
description: File layout, endpoints, and artifact resolution in the graphify viewer
tags: \[graphify, viewer, implementation, bun\]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer implementation

<!-- generated-toc -->
<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. 📁 Repository layout](#1--repository-layout)
- [2. 🛣 Endpoints](#2--endpoints)
  - [2.1. 📄 Read surface (open, sanitized)](#21--read-surface-open-sanitized)
  - [2.2. 📄 Mutation surface (bearer token)](#22--mutation-surface-bearer-token)
- [3. 1 🧱 Job engine](#3-1--job-engine)
- [4. 🎨 Picker rendering](#4--picker-rendering)
- [5. 🔗 Artifact resolution](#5--artifact-resolution)
- [6. 🧩 Registration surface](#6--registration-surface)

</details>

---
## 1. 📁 Repository layout

```text
infra/graphify-viewer/
├── AGENTS.md                   # scope contract (reads store, never writes)
├── README.md                   # repo pointer
├── server.js                   # Bun HTTP service (entrypoint)
├── public.css                  # picker styles (catppuccin latte/mocha, 3D cards)
├── public.js                   # picker behavior (sort/filter/calendar/theme)
├── prototype/
│   └── picker-prototype.html   # accepted prototype (primary source)
└── docs/                       # this documentation tree
```

## 2. 🛣 Endpoints

### 2.1. 📄 Read surface (open, sanitized)

| Route                | Method   | Response                                                    |
| -------------------- | -------- | ------------------------------------------------------------ |
| `/`                  | GET/HEAD | Picker page (server-rendered, `no-store`)                    |
| `/healthz`           | GET      | `{"ok":true,"graphs":N}`                                     |
| `/api/status`        | GET      | Status collection: typed items, snapshot digest, scope       |
| `/api/status?id=TAG` | GET      | Single-item envelope (404 unknown tag)                       |
| `/api/snapshot`      | GET      | Bound snapshot digest + TTL + observed items/capabilities    |
| `/api/jobs`          | GET      | Bounded job history (latest 50)                              |
| `/api/jobs/:id`      | GET      | Job detail: state, per-item outcomes, progress, capped output|
| `/g/<tag>/graph`     | GET      | That repo's `graphify-out/graph.html`                        |
| `/g/<tag>/tree`      | GET      | That repo's `graphify-out/GRAPH_TREE.html`                   |
| `/g/<tag>/report`    | GET      | `GRAPH_REPORT.md` wrapped in a minimal dark HTML pre         |
| anything else        | any      | 404                                                          |

Environment: `GRAPHIFY_VIEWER_PORT` (default `4322`); binds `127.0.0.1` only.

### 2.2. 📄 Mutation surface (bearer token)

| Route                   | Method | Body                                                                 | Response |
| ----------------------- | ------ | -------------------------------------------------------------------- | -------- |
| `/api/jobs`             | POST   | `{operation:"refresh",scope:"selected"|"all",items,snapshot,confirmed}` | 202 job envelope |
| `/api/jobs/:id/cancel`  | POST   | —                                                                    | 200 ack; idempotent |

Guards run in order before any producer work: Host-header allowlist (generic
403), Origin/Referer defense-in-depth, bearer token (`WWW-Authenticate` on
401), 64 KiB body cap (413), strict schema (400), snapshot digest binding
(409 with fresh collection when stale), `confirmed:true` (422 otherwise).
One active job: a second POST returns 409 naming the running id.

Token sources (first match wins): `GRAPHIFY_VIEWER_TOKEN` env, else
`~/.config/graphify-viewer/token`. The token never appears in responses,
logs, or URLs. Test seam: `createApp(options)` builds the app in-process;
fixture suites drive it without sockets.

## 3. 1 🧱 Job engine

Jobs spawn the producer-owned `graphify-refresh.sh` (selected tags become
`--tag` pairs; `--timeout` is fixed server-side; clients can never pass
`--force`). Per-tag outcomes come from the producer's versioned
`graphify-refresh-result/v1` JSONL (tailed by byte offset):

- `updated` → updated · `skipped` / `tolerated_empty` → skipped
- `cancelled` → cancelled · `timed_out` → timed_out
- `busy` (producer lock) → pollable whole-job `busy`
- everything else → failed

Aggregate states: `running` → one of `completed`, `partial`, `failed`,
`cancelled`, `timed_out`, `busy`. Watchdog escalates SIGTERM→SIGKILL (5 s
grace) against the process group at the 15-minute deadline; cancel is the
same escalation, authenticated and idempotent. Output is captured to 1 MiB
(head+tail preserved); history is process-local and capped at 50 jobs.
Last-known generations are never touched by viewer mutations.

## 4. 🎨 Picker rendering

`renderIndex()` in `server.js` reads the manifest, checks which artifacts
exist per tag (chips render only for present files), and emits the page with
`public.css`/`public.js` inlined. Card data is embedded as a JSON array
(`REPOS`) of `{tag, nodes, edges, added, ARTLINKS}`; `public.js` re-renders
the grid client-side for sorting, filtering, and the calendar, using the same
markup the server emitted.

The 3D treatment uses CSS custom properties registered with `@property`
(`--float`, `--boost`, `--sc`, all `<length>`/`<number>`) so depth animates
smoothly; engines without `@property` support degrade to static depth.
`prefers-reduced-motion` disables float and shake.

## 5. 🔗 Artifact resolution

Tags map to directories via the manifest's `source_path`
(`…/graphify-out/graph.json` → the containing `graphify-out/`). The server
reads the artifact from disk per request — no caching layer, so regenerated
artifacts serve immediately. Markdown is HTML-escaped and wrapped; binary-safe
reads serve the HTML artifacts as-is with their MIME types.

## 6. 🧩 Registration surface

- LaunchAgent: `com.s-a-c.graphify-viewer`
  (`~/.local/bin/launch-graphify-viewer.sh`, execs
  `$HOME/.local/share/bun/bin/bun`).
- Caddy: `graphify.stands-macbook-pro.local` → `host.docker.internal:4322`.
- Hosts: `graphify` / `graphify.stands-macbook-pro.local` on `127.0.0.1` and
  `::1`.
- Inventory: `~/docs/02-infra-repositories.md` (repo row, LaunchAgent rows,
  local-URL row).
- Docs-site integration: see [98-index.md](2498-index.md) and the home
  workspace's docs-to-docs-site flow.

[←](2408-operation.md) | [↑](#graphify-viewer-implementation) | [→](2498-index.md)
