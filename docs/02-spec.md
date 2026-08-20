---
type: spec
title: Graphify Viewer spec
description: Purpose, scope, and user-visible behavior of the centralized graphify graph viewer
tags: [graphify, viewer, spec]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer spec

<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. Problem](#1--problem)
- [2. Users](#2--users)
- [3. Scope](#3--scope)
- [4. User-visible behavior](#4--user-visible-behavior)
- [5. Non-goals](#5--non-goals)

</details>

---

## 1. ❓ Problem

Each repo's graphify index lives in its own `graphify-out/` directory. There
has been no way to see the whole corpus at once, compare graphs by size or
freshness, or open a graph's views without knowing which directory holds it.
The store also went two months stale before anyone noticed.

## 2. 👤 Users

The workspace's developer and their coding agents. Humans browse; agents may
link colleagues or future sessions directly to artifact URLs.

## 3. 🔭 Scope

Twelve graphs: home (`~`), `~/Herd/samples-20260717`, the eight `~/infra`
stacks (caddy, control-plane, docs-site, hermes-agent, infisical, odysseus,
siyuan, shared), `~/Projects/agent-skills`, and `~/Projects/the-hub--spoke`.
The viewer reads the global store; it never writes it.

## 4. 👁 User-visible behavior

- One page lists every graph as a card: tag, node count, edge count, path,
  added date, relative-size bar, and artifact links (graph, tree, report).
- Sort by node count, alphabetical order, or recency; first click ascends,
  repeated clicks toggle direction.
- Filter by live text search over tag and path, and by an added-date range
  chosen from a calendar whose span covers the visible cards.
- Light/dark themes (catppuccin latte/mocha), persisted, following system
  preference by default; palette meets WCAG AA.
- Cards carry animated 3D depth: idle float, hover raise with border glow and
  pointer spotlight, pointer-tracked tilt. Clicking a card shakes and magnifies
  it for review; only the artifact chips navigate. Reduced-motion preferences
  disable the effects.
- Each artifact link serves the graphify CLI-generated view for that graph:
  the force-directed `graph.html`, the collapsible `GRAPH_TREE.html`, or the
  `GRAPH_REPORT.md` community report.
- The picker reflects the global manifest on every request; a refreshed store
  appears on reload without a service restart.

## 5. 🚫 Non-goals

- No cross-repo merged-graph visualization (ruled out for this effort).
- No graph editing, no query interface, no authentication. The viewer is a
  read-only loopback service behind central Caddy's TLS.

[←](01-contents.md) | [↑](#graphify-viewer-spec) | [→](04-design.md)
