---
type: reference
title: Graphify Viewer implementation
description: File layout, endpoints, and artifact resolution in the graphify viewer
tags: [graphify, viewer, implementation, bun]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer implementation

<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. Repository layout](#1--repository-layout)
- [2. Endpoints](#2--endpoints)
- [3. Picker rendering](#3--picker-rendering)
- [4. Artifact resolution](#4--artifact-resolution)
- [5. Registration surface](#5--registration-surface)

</details>

---

## 1. 📁 Repository layout

```text
infra/graphify-viewer/
├── AGENTS.md               # scope contract (reads store, never writes)
├── README.md               # repo pointer
├── server.js               # Bun HTTP service (entrypoint)
├── public.css              # picker styles (catppuccin latte/mocha, 3D cards)
├── public.js               # picker behavior (sort/filter/calendar/theme)
├── prototype/
│   └── picker-prototype.html   # accepted prototype (primary source)
└── docs/                   # this documentation tree
```

## 2. 🛣 Endpoints

| Route                    | Method | Response                                             |
| ------------------------ | ------ | ---------------------------------------------------- |
| `/`                      | GET    | Picker page (server-rendered, `no-store`)            |
| `/healthz`               | GET    | `{"ok":true,"graphs":N}`                             |
| `/g/<tag>/graph`         | GET    | That repo's `graphify-out/graph.html`                |
| `/g/<tag>/tree`          | GET    | That repo's `graphify-out/GRAPH_TREE.html`           |
| `/g/<tag>/report`        | GET    | `GRAPH_REPORT.md` wrapped in a minimal dark HTML pre |
| anything else            | any    | 404                                                  |

Environment: `GRAPHIFY_VIEWER_PORT` (default `4322`); binds `127.0.0.1` only.

## 3. 🎨 Picker rendering

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

## 4. 🔗 Artifact resolution

Tags map to directories via the manifest's `source_path`
(`…/graphify-out/graph.json` → the containing `graphify-out/`). The server
reads the artifact from disk per request — no caching layer, so regenerated
artifacts serve immediately. Markdown is HTML-escaped and wrapped; binary-safe
reads serve the HTML artifacts as-is with their MIME types.

## 5. 🧩 Registration surface

- LaunchAgent: `com.s-a-c.graphify-viewer`
  (`~/.local/bin/launch-graphify-viewer.sh`, execs
  `$HOME/.local/share/bun/bin/bun`).
- Caddy: `graphify.stands-macbook-pro.local` → `host.docker.internal:4322`.
- Hosts: `graphify` / `graphify.stands-macbook-pro.local` on `127.0.0.1` and
  `::1`.
- Inventory: `~/docs/02-infra-repositories.md` (repo row, LaunchAgent rows,
  local-URL row).
- Docs-site integration: see [98-index.md](98-index.md) and the home
  workspace's docs-to-docs-site flow.

[←](05-operation.md) | [↑](#graphify-viewer-implementation) | [→](98-index.md)
