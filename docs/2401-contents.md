---
type: contents
title: Graphify Viewer docs contents
description: Structural contents of the graphify-viewer documentation tree
tags: \[graphify, viewer, documentation\]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer docs contents

<!-- generated-toc -->
<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. 🎯 Purpose](#1--purpose)
- [2. 📚 Reading order](#2--reading-order)
- [3. 📁 Children](#3--children)

</details>

---
Documentation for the Graphify Viewer, the centralized browser for the global
graphify store. Read the spec first; operation matters day to day.


## 1. 🎯 Purpose

The Graphify Viewer exposes the per-repo graphify graphs of the global store
(`~/.graphify`) as one selectable, sortable, filterable surface behind central
Caddy.

## 2. 📚 Reading order

1. [Spec](2402-spec.md) — what the viewer is and why.
2. [Design](2404-design.md) — the shape of the solution and its boundaries.
3. [Implementation](2407-implementation.md) — files, endpoints, job engine, and how data flows.
4. [Operation](2408-operation.md) — running, refreshing, and troubleshooting.

## 3. 📁 Children

- [02-spec.md](2402-spec.md) — the viewer's purpose, scope, and user-visible behavior.
- [04-design.md](2404-design.md) — architecture and the decisions behind it.
- [08-operation.md](2408-operation.md) — LaunchAgent, Caddy route, refresh loop, runbooks.
- [07-implementation.md](2407-implementation.md) — concrete file layout, endpoints, artifact resolution.
- [98-index.md](2498-index.md) — semantic index and glossary.

[↑](#graphify-viewer-docs-contents) | [→](2402-spec.md)
