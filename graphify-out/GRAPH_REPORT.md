# Graph Report - graphify-viewer  (2026-08-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 98 nodes · 164 edges · 14 communities (11 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.85)
- Token cost: 443 input · 120 output

## Graph Freshness
- Built from commit: `7cf4e92d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- App Build and Configuration
- Calendar UI Component
- Server and Git Environment
- Job Processing Logic
- Job API Handlers
- Status API Integration Tests
- Job Status UI Updates
- Authentication Middleware
- UI Rendering Utilities
- Refresh Shell Script
- Caddy Server Configuration
- Job Engine Core

## God Nodes (most connected - your core abstractions)
1. `app()` - 15 edges
2. `handleJobPost()` - 11 edges
3. `createApp()` - 9 edges
4. `startJob()` - 9 edges
5. `test-status-api.sh script` - 8 edges
6. `computeItemStatus()` - 6 edges
7. `computeStatusCollection()` - 6 edges
8. `authGate()` - 6 edges
9. `buildFixture()` - 5 edges
10. `drawCal()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `req()` --calls--> `app()`  [EXTRACTED]
  tests/e2e-journeys.test.js → server.js
- `req()` --calls--> `app()`  [EXTRACTED]
  tests/jobs-api.test.js → server.js
- `build()` --calls--> `createApp()`  [EXTRACTED]
  tests/e2e-journeys.test.js → server.js
- `buildFixture()` --calls--> `createApp()`  [EXTRACTED]
  tests/jobs-api.test.js → server.js

## Import Cycles
- None detected.

## Communities (14 total, 3 thin omitted)

### Community 0 - "App Build and Configuration"
Cohesion: 0.14
Nodes (14): createApp(), createJobRegistry(), homePath(), resolveOptions(), build(), HOME_MARKERS, PRODUCER, req() (+6 more)

### Community 1 - "Calendar UI Component"
Cohesion: 0.17
Nodes (12): ARTIFACTS, calBtn, calPop, datesOfVisible(), drawCal(), isoOf(), onCalPick(), openCal() (+4 more)

### Community 2 - "Server and Git Environment"
Cohesion: 0.25
Nodes (10): ARTIFACTS, computeItemStatus(), gitHead(), gitWorkingTreeDirty(), HERE, MIME, PORT, readGeneration() (+2 more)

### Community 3 - "Job Processing Logic"
Cohesion: 0.18
Nodes (10): appendOutput(), applyEventToJob(), byteLengthOfFile(), computeAggregateState(), mapResultOutcome(), randomJobId(), readResultsTail(), redactText() (+2 more)

### Community 4 - "Job API Handlers"
Cohesion: 0.33
Nodes (10): computeStatusCollection(), app(), publicCollection(), handleJobPost(), jsonResponse(), readJsonBody(), readStore(), readToken() (+2 more)

### Community 5 - "Status API Integration Tests"
Cohesion: 0.36
Nodes (8): create_fixture(), fail(), finish(), next_port(), ok(), test-status-api.sh script, start_server(), stop_server()

### Community 6 - "Job Status UI Updates"
Cohesion: 0.50
Nodes (6): paintStatuses(), pollJob(), refreshButtons(), selectedTags(), setBadge(), startJob()

### Community 7 - "Authentication Middleware"
Cohesion: 0.50
Nodes (4): authGate(), errorResponse(), parseUrlSafe(), unauthorized()

### Community 8 - "UI Rendering Utilities"
Cohesion: 0.67
Nodes (4): esc(), pickerControlsMarkup(), renderIndex(), statusBadge()

## Knowledge Gaps
- **16 isolated node(s):** `HOME_MARKERS`, `PRODUCER`, `FRESH_SCRIPT`, `ARTIFACTS`, `calBtn` (+11 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createApp()` connect `App Build and Configuration` to `Server and Git Environment`, `Job API Handlers`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `app()` connect `Job API Handlers` to `App Build and Configuration`, `UI Rendering Utilities`, `Job Processing Logic`, `Authentication Middleware`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `startJob()` connect `Job Processing Logic` to `Server and Git Environment`, `Job API Handlers`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `HOME_MARKERS`, `PRODUCER`, `FRESH_SCRIPT` to the rest of the system?**
  _16 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `App Build and Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.1437908496732026 - nodes in this community are weakly interconnected._