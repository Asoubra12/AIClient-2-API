# Antigravity Flow Library Materialization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Materialize the validated repo-local Antigravity flow traces into `docs/architecture/flows/` using the `flow-tracer` README and Mermaid formats.

**Architecture:** Build a small flow-library scaffold first, then document each traced flow as a standalone folder with a code-backed README and a swimlane-style Mermaid diagram. Keep the scope limited to the implemented Antigravity surfaces inside `AIClient-2-API`, and persist the loop seams and fixed disconnections already validated in tests.

**Tech Stack:** Markdown, Mermaid, Node.js repo source references, Jest-backed traced behavior

---

### Task 1: Create The Flow Library Scaffold

**Files:**
- Create: `docs/architecture/flows/index.md`
- Create: `docs/architecture/flows/SHARED-INFRASTRUCTURE.md`
- Create: `docs/architecture/flows/requirements.md`

**Step 1: Write the scaffold files**

Create the top-level flow library files with:
- an index covering all documented flows and categories
- a shared-infrastructure doc that explains what is omitted versus explicitly modeled
- a local requirements doc capturing the repo-local tracing rules learned in this session

**Step 2: Verify the scaffold exists**

Run: `Get-ChildItem docs/architecture/flows`
Expected: `index.md`, `SHARED-INFRASTRUCTURE.md`, and `requirements.md` are present.

### Task 2: Document The Request Processing And Retry Flows

**Files:**
- Create: `docs/architecture/flows/antigravity-content-generation-happy-path/README.md`
- Create: `docs/architecture/flows/antigravity-content-generation-happy-path/diagram.mermaid`
- Create: `docs/architecture/flows/antigravity-prehook-selection-and-chain-setup/README.md`
- Create: `docs/architecture/flows/antigravity-prehook-selection-and-chain-setup/diagram.mermaid`
- Create: `docs/architecture/flows/antigravity-stream-unary-retry-and-fallback/README.md`
- Create: `docs/architecture/flows/antigravity-stream-unary-retry-and-fallback/diagram.mermaid`

**Step 1: Draft the request-path READMEs**

Write the flow boundaries, quick references, key steps, failure scenarios, and related flows from the traced request path.

**Step 2: Draft the request-path diagrams**

Create Mermaid flowcharts that match the README step ordering and distinguish sync calls from async hops.

**Step 3: Spot-check the files**

Run: `Get-ChildItem docs/architecture/flows/antigravity-*`
Expected: Each request-path flow folder contains both `README.md` and `diagram.mermaid`.

### Task 3: Document Bootstrap, Scheduling, Telemetry, And Lifecycle Flows

**Files:**
- Create: `docs/architecture/flows/antigravity-init-bootstrap-and-model-discovery/README.md`
- Create: `docs/architecture/flows/antigravity-init-bootstrap-and-model-discovery/diagram.mermaid`
- Create: `docs/architecture/flows/antigravity-quota-refresh-and-startup-prewarm/README.md`
- Create: `docs/architecture/flows/antigravity-quota-refresh-and-startup-prewarm/diagram.mermaid`
- Create: `docs/architecture/flows/antigravity-telemetry-metrics-and-trajectory/README.md`
- Create: `docs/architecture/flows/antigravity-telemetry-metrics-and-trajectory/diagram.mermaid`
- Create: `docs/architecture/flows/antigravity-provider-lifecycle-and-tls-isolation/README.md`
- Create: `docs/architecture/flows/antigravity-provider-lifecycle-and-tls-isolation/diagram.mermaid`

**Step 1: Draft the operational READMEs**

Document the init chain, scheduled refresh/prewarm behavior, telemetry emission/logging path, and lifecycle/TLS isolation behavior.

**Step 2: Draft the operational diagrams**

Create Mermaid diagrams that emphasize bootstrap order, scheduler loops, post-hook emission, and TLS cleanup/quarantine paths.

**Step 3: Spot-check the files**

Run: `Get-ChildItem docs/architecture/flows/antigravity-init-bootstrap-and-model-discovery,docs/architecture/flows/antigravity-quota-refresh-and-startup-prewarm,docs/architecture/flows/antigravity-telemetry-metrics-and-trajectory,docs/architecture/flows/antigravity-provider-lifecycle-and-tls-isolation`
Expected: Each operational flow folder contains both `README.md` and `diagram.mermaid`.

### Task 4: Document The Read And Supervision Flows

**Files:**
- Create: `docs/architecture/flows/master-worker-launcher-supervision/README.md`
- Create: `docs/architecture/flows/master-worker-launcher-supervision/diagram.mermaid`
- Create: `docs/architecture/flows/model-catalog-and-provider-health-read-path/README.md`
- Create: `docs/architecture/flows/model-catalog-and-provider-health-read-path/diagram.mermaid`

**Step 1: Draft the admin/read READMEs**

Document the master-worker launcher control loop plus the model catalog and provider-health read path.

**Step 2: Draft the admin/read diagrams**

Create Mermaid diagrams showing the readiness/heartbeat restart path and the read-only aggregation path.

**Step 3: Spot-check the files**

Run: `Get-ChildItem docs/architecture/flows/master-worker-launcher-supervision,docs/architecture/flows/model-catalog-and-provider-health-read-path`
Expected: Each folder contains both `README.md` and `diagram.mermaid`.

### Task 5: Verify The Persisted Flow Library

**Files:**
- Verify: `docs/architecture/flows/index.md`
- Verify: `docs/architecture/flows/SHARED-INFRASTRUCTURE.md`
- Verify: `docs/architecture/flows/requirements.md`
- Verify: `docs/architecture/flows/*/README.md`
- Verify: `docs/architecture/flows/*/diagram.mermaid`

**Step 1: Verify folder completeness**

Run: `Get-ChildItem docs/architecture/flows -Recurse`
Expected: The scaffold files plus nine flow folders with paired README and Mermaid files exist.

**Step 2: Verify code references still resolve**

Run: `rg -n "src/|tests/" docs/architecture/flows`
Expected: The flow docs reference concrete repo paths used in the traced analysis.

**Step 3: Verify the final tree in git status**

Run: `git status --short docs/architecture/flows docs/plans/2026-03-06-antigravity-flow-library-design.md docs/plans/2026-03-06-antigravity-flow-library-materialization.md`
Expected: Only the intended flow-library docs appear as new or modified files.
