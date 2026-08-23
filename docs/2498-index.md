---
type: index
title: Graphify Viewer index
description: Semantic index and glossary for the graphify-viewer documentation
tags: \[graphify, viewer, index\]
timestamp: 2026-08-20
provenance: agent
status: stable
---
# Graphify Viewer index

<details>
  <summary style="font-size: 1.25em; font-weight: bold; margin: 0.83em 0; cursor: pointer;">
    Expand for Table of Contents
  </summary>

- [1. 🧭 Topic index](#1--topic-index)
- [2. 📖 Glossary](#2--glossary)

</details>

---

## 1. 🧭 Topic index

- 3D cards — [design boundaries and degradation](2404-design.md#2--decisions), [implementation of registered properties](2407-implementation.md#3--picker-rendering)
- accessibility — [palette and contrast requirements](2402-spec.md#4--user-visible-behavior)
- adding a graph — [runbook](2408-operation.md#4--adding-a-graph)
- architecture — [service overview](2404-design.md#1--architecture)
- artifact routes — [endpoint table](2407-implementation.md#2--endpoints)
- Bun path — [troubleshooting](2408-operation.md#5--troubleshooting)
- calendar filter — [spec](2402-spec.md#4--user-visible-behavior)
- Caddy — [route and restart procedure](2408-operation.md#5--troubleshooting)
- healthz — [service lifecycle](2408-operation.md#2--service-lifecycle)
- LaunchAgent — [lifecycle commands](2408-operation.md#2--service-lifecycle)
- manifest — [data flow](2404-design.md#3--data-flow), [state locations](2408-operation.md#6--logs-and-state)
- nightly refresh — [refresh loop](2408-operation.md#3--refresh-loop)
- picker shape — [user-visible behavior](2402-spec.md#4--user-visible-behavior)
- port 4322 — [decision](2404-design.md#2--decisions)
- prototype — [primary source](2407-implementation.md#1--repository-layout)
- refresh script — [refresh loop](2408-operation.md#3--refresh-loop)
- sorting — [spec](2402-spec.md#4--user-visible-behavior)
- store — [boundaries](2404-design.md#4--boundaries)
- theme toggle — [spec](2402-spec.md#4--user-visible-behavior)
- troubleshooting — [symptom table](2408-operation.md#5--troubleshooting)
- zero dependencies — [decision](2404-design.md#2--decisions)

## 2. 📖 Glossary

- **artifact** — one of the three files the graphify CLI generates per repo (`graph.html`, `GRAPH_TREE.html`, `GRAPH_REPORT.md`); the viewer's only content beyond the picker.
- **global store** — `~/.graphify/global-graph.json` plus `global-manifest.json`; the merged cross-repo graph and the tag-to-path manifest the viewer reads.
- **graphify** — the tree-sitter-based indexing CLI (`graphify-ts`) that builds structural and semantic code graphs per repo.
- **picker** — the viewer's landing page: one card per graph tag with sort, filter, and calendar range controls.
- **tag** — a repo's identity in the global store (e.g. `odysseus`, `s-a-c`); doubles as the URL segment in `/g/<tag>/…`.
- **wayfinder map** — the planning epic ("Rebuild global graphify store, ship centralized viewer") that specified and tracked this effort.

[←](2407-implementation.md) | [↑](#graphify-viewer-index) | [→](2401-contents.md)
