---
type: playbook
title: Graphify Viewer operation
description: Running, refreshing, and troubleshooting the graphify viewer service
tags: \[graphify, viewer, operations, launchagent, caddy\]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer operation

<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. 🌐 Access](#1--access)
- [2. 🔌 Service lifecycle](#2--service-lifecycle)
- [3. 🔄 Refresh loop](#3--refresh-loop)
- [4. ➕ Adding a graph](#4--adding-a-graph)
- [5. 🔧 Troubleshooting](#5--troubleshooting)
- [6. 📋 Logs and state](#6--logs-and-state)

</details>

---

## 1. 🌐 Access

`https://graphify.stands-macbook-pro.local/` (central Caddy, `tls internal`).
Requires the `/etc/hosts` entry and, once per browser, trust of the Caddy root
CA in the macOS Keychain. Direct loopback: `http://127.0.0.1:4322/`.

## 2. 🔌 Service lifecycle

The LaunchAgent `com.s-a-c.graphify-viewer` (chezmoi template `private_Library/LaunchAgents/com.s-a-c.graphify-viewer.plist.tmpl`) runs `~/.local/bin/launch-graphify-viewer.sh` with `RunAtLoad` and `KeepAlive`.

```bash
launchctl print gui/$(id -u)/com.s-a-c.graphify-viewer          # state
launchctl kickstart -k gui/$(id -u)/com.s-a-c.graphify-viewer   # restart
curl -s http://127.0.0.1:4322/healthz                           # {"ok":true,"graphs":12}
```

Code changes: edit `~/infra/graphify-viewer/server.js` (or `public.*`),
commit in jj, then kickstart the agent.

## 3. 🔄 Refresh loop

### Scheduled and manual (unchanged)

The store refreshes nightly at 02:30 via `com.s-a-c.graphify-refresh`
(`~/infra/shared/scripts/graphify-refresh.sh`;
- incremental, per-repo isolation).
The viewer needs no restart after a refresh
— it reads the manifest per request. On-demand full rebuild:

```bash
~/infra/shared/scripts/graphify-refresh.sh --force
```

### Browser-triggered guarded refresh

The picker adds per-card checkboxes plus **Update selected** / **Update all**
controls. Both go through snapshot-bound confirmation:

1. Paste the service token once in the confirm dialog (memory only — never
   stored, never logged). Provision it server-side with:
   ```bash
   umask 177; mkdir -p ~/.config/graphify-viewer
   printf '%s' "$(openssl rand -hex 32)" > ~/.config/graphify-viewer/token
   ```
2. Review the dialog's resolved labels, statuses, and reasons, then confirm.
   The dialog fetches `GET /api/snapshot` and echoes its digest.
3. Progress polls `GET /api/jobs/<id>` until a terminal state
   (`completed` / `partial` / `failed` / `cancelled` / `timed_out` / `busy`).

CLI equivalent for one tag:

```bash
TOKEN=$(cat ~/.config/graphify-viewer/token)
SNAP=$(curl -s http://127.0.0.1:4322/api/snapshot | jq -r .snapshot)
JOB=$(curl -s -X POST http://127.0.0.1:4322/api/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"operation":"refresh","scope":"selected","items":["shared"],"snapshot":"'"$SNAP"'","confirmed":true}' \
  | jq -r .id)
curl -s "http://127.0.0.1:4322/api/jobs/$JOB" | jq '{state, progress}'
# cancel if needed:
curl -s -X POST "http://127.0.0.1:4322/api/jobs/$JOB/cancel" -H "authorization: Bearer $TOKEN"
```

Rejection map: 403 disallowed Host/Origin · 401 missing/wrong token ·
413 body over 64 KiB · 400 schema/scope/tag errors · 409 stale snapshot or
active job · 422 unconfirmed. A `busy` job means the producer lock was held
(nightly or manual run); wait and re-run with a fresh snapshot. Failed,
cancelled, and timed-out jobs always preserve last-known generations — the
picker keeps serving prior graphs.

## 4. ➕ Adding a graph

1. `graphify extract <repo>` (add `--code-only` for config stacks).
2. `graphify global add <repo>/graphify-out/graph.json --as <tag>`.
3. Generate artifacts if missing:
  - `graphify cluster-only <repo>` and `graphify tree <repo>`
    - (graphs over 5,000 nodes need `GRAPHIFY_VIZ_NODE_LIMIT=20000` for `graph.html`).
4. Reload the picker; the new card appears.

## 5. 🔧 Troubleshooting

- **Picker card missing a tag** — the manifest's `source_path` directory no
  longer exists (repo moved or renamed). Re-run
  `graphify global add … --as <tag>` from the new path.
- **Artifact 404** — that repo's `graphify-out/` lacks the file (common after
  `--no-viz` runs). Regenerate per [4. Adding a graph](#4--adding-a-graph).
- **502 from Caddy** — the Bun service is down; `launchctl print` the agent
  and check `graphify-viewer.err.log` (the usual cause is an edited
  `server.js` with a syntax error).
- **Bun not found in agent logs** — the launch script execs
  `$HOME/.local/share/bun/bin/bun` (nub-managed path); if Bun moves, update
  the script.
- **Caddy config change** — edit `~/infra/caddy/Caddyfile`, then
  `docker restart caddy-caddy-1` (the admin API's origin allowlist blocks
  in-container `caddy reload` by design).

## 6. 📋 Logs and state

- Service logs: `~/.local/logs/graphify-viewer.{out,err}.log`.
- Refresh log: `~/.local/logs/graphify-refresh.log` (per-repo OK/WARN/FAIL
  lines, one `=== done` line per run).
- Store: `~/.graphify/global-graph.json` + `global-manifest.json` (the
  manifest is the viewer's source of truth for tags and counts).

[←](2404-design.md) | [↑](#graphify-viewer-operation) | [→](2407-implementation.md)
