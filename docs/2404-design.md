---
type: concept
title: Graphify Viewer design
description: Architecture and decisions behind the Bun-based graphify graph viewer
tags: \[graphify, viewer, design, caddy\]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer design

<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. 🏗 Architecture](#1--architecture)
- [2. 🧭 Decisions](#2--decisions)
- [3. 🌊 Data flow](#3--data-flow)
- [4. 🧱 Boundaries](#4--boundaries)

</details>

---

## 1. 🏗 Architecture

A single Bun HTTP service (`server.js`, zero npm dependencies) renders the
picker server-side and serves three kinds of routes. It runs on
`127.0.0.1:4322` under a KeepAlive LaunchAgent; central Caddy terminates TLS and proxies `graphify.stands-macbook-pro.local` to it. Styling and client behavior live in `public.css` and `public.js`, inlined into the served page.

```text
browser ── HTTPS ── central Caddy ── HTTP ── Bun server (127.0.0.1:4322)
                                            ├── /            picker (SSR)
                                            ├── /g/<tag>/<a> artifact file
                                            ├── /healthz     JSON status
                                            └── reads ~/.graphify/global-manifest.json
                                                + each repo's graphify-out/
```

## 2. 🧭 Decisions

- **Bun, zero dependencies.** The workspace already runs Bun; one file with
  `Bun.serve` avoids a package.json, a lockfile, and a build step.
- **Manifest read per request.** The nightly refresh rewrites the global
  manifest; reading it on every request means new graphs appear on reload
  with no restart, no cache invalidation, and no file watching.
- **Artifacts served from their source repos.** The CLI already writes
  `graph.html`, `GRAPH_TREE.html`, and `GRAPH_REPORT.md` into each repo's
  `graphify-out/`; the viewer resolves each tag's directory from the
  manifest's `source_path` and streams those files. No copies, no drift.
- **Server-side rendering of the picker.** The card grid is rendered on the
  server; client JavaScript only sorts, filters, animates, and re-renders
  from the embedded data. The page works before JS parses far enough to
  build interactions, and the data travels once.
- **Picker shape from the accepted prototype.** Cards, ascend-first sorting,
  calendar range filtering, latte/mocha WCAG AA palette, and the 3D depth
  treatment were validated in the `prototype/picker` artifact before this
  service folded them in.
- **Port 4322.** Sits beside the docs-site preview (4321) in the free
  432x-block; nothing else claimed it.

## 3. 🌊 Data flow

1. Nightly (`02:30`) the refresh script re-extracts changed repos and
   re-registers each graph into the global store via `graphify global add`.
2. A browser request makes the server read `~/.graphify/global-manifest.json`,
   check each tag's artifact directory for the files it may serve, and render
   the picker with that snapshot.
3. Clicking an artifact chip requests `/g/<tag>/<artifact>`; the server
   resolves the tag's `graphify-out/` directory, reads the file, and serves
   it (markdown wrapped in a minimal dark page).

## 4. 🧱 Boundaries

The viewer is read-only over the store and the repos' `graphify-out/` directories.
It does not extract, merge, or modify graphs;
 the graphify CLI and the refresh script own that side.
It listens on loopback only; Caddy is the sole TLS boundary.

Mutation boundary: refresh jobs are the one write-adjacent surface. They run
only the producer-owned script with fixed argv (selected `--tag`s plus a fixed
`--timeout`; `--force` is unreachable from the browser), sit behind a
service-local bearer token with Host/Origin checks, bind to a snapshot digest
of observed statuses, enforce single-flight, and tail the producer's versioned
JSONL for outcomes instead of parsing prose output. The producer's own lock
covers overlap with nightly/manual runs; viewer jobs ending in failure,
cancel, or timeout leave every prior generation untouched.

[←](2402-spec.md) | [↑](#graphify-viewer-design) | [→](2408-operation.md)
