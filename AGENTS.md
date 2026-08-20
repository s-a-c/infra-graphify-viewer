---
trigger: always_on
title: "infra-graphify-viewer Agent Instructions"
description: "Agent contract for the graphify viewer stack: a Bun HTTP service exposing the global graphify store via central Caddy."
type: spec
tags: \[ai, agents, contract, infra\]
created: 2026-08-19
updated: 2026-08-19
---

# infra-graphify-viewer Agent Instructions

This repo holds the centralized graphify viewer: a single-file Bun HTTP service
that reads the global graphify store (`~/.graphify/global-manifest.json` and
the per-repo `graphify-out/` artifacts) and serves a picker where each graph
is individually selectable for viewing, behind central Caddy at
`graphify.stands-macbook-pro.local`.

## 1. Scope

- Service code lives in this repo. The store it reads is owned by the graphify
  CLI; this repo never writes to `~/.graphify`.
- Documentation lives in `docs/` (spec, design, implementation, operation) and
  integrates into the docs-site app at `~/infra/docs-site`.

## 2. Conventions

- Zero-dependency ESM JavaScript for the service (Bun runtime), following the
  `s-a-c-javascript-cli-style` skill.
- Issue tracker: GitHub Issues on `s-a-c/infra-graphify-viewer` per the global
  default for infra repos.
- jj-colocated git repo. Known gotcha: the remote existed before
  `jj git init --colocate`, so `main@origin` is not tracked — run
  `jj bookmark track main --remote=origin` before the first push.
- Port assignment, LaunchAgent, and Caddy route follow the home workspace
  infra inventory in `~/docs/02-infra-repositories.md`.

## 3. Reference

- Wayfinder map: "Rebuild global graphify store, ship centralized viewer"
  (home workspace Beads, `s-a-c/stands-macbook-pro-home`).
- Global behavior and rule triggers: `~/.config/agents/AGENTS.md`.
