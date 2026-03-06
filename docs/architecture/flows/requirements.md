# Flow Library Requirements

These rules capture the repo-local tracing conventions learned while mapping the Antigravity plan implementation.

## Output Rules

### 1. Use The Blueprint

**Problem**: Flow docs drift if each one invents its own structure.

**Rule**: Use `docs/architecture/flows/antigravity-content-generation-happy-path/` as the local blueprint for later Antigravity flow docs.

**Example from antigravity-content-generation-happy-path**: The README and Mermaid diagram will define the baseline granularity for request-path documentation.

**File locations**: `docs/architecture/flows/antigravity-content-generation-happy-path/README.md`, `docs/architecture/flows/antigravity-content-generation-happy-path/diagram.mermaid`

### 2. Keep The System Boundary Repo-Local

**Problem**: The broader `kiro` directory contains related repos, but this flow library is only meant to persist the implemented Antigravity surfaces in `AIClient-2-API`.

**Rule**: When documenting these flows, you MUST treat `AIClient-2-API` as the system boundary and only mention adjacent repos as excluded context, not as traced participants.

**Example from this audit**: The flow set includes launcher and telemetry loops implemented locally, but excludes BitBrowser or account-manager repos.

**File locations**: `docs/architecture/flows/index.md`, `docs/architecture/flows/SHARED-INFRASTRUCTURE.md`

## Discovery Rules

### 3. Anchor Flow Steps To Stable Runtime Entry Points

**Problem**: Function-level line references move often, but route handlers, pipeline entry points, and supervisor IPC handlers are stable anchors for investigation.

**Rule**: When tracing a flow, you MUST start from stable ingress points such as `request-handler.js`, `api-manager.js`, `common.js`, `service-manager.js`, `provider-pool-manager.js`, `antigravity-core.js`, `master.js`, and `launcher-supervisor.js`.

**Example from antigravity-content-generation-happy-path**: The flow starts at `src/handlers/request-handler.js` and `src/services/api-manager.js`, then crosses into `src/utils/common.js`.

**File locations**: `src/handlers/request-handler.js`, `src/services/api-manager.js`, `src/utils/common.js`

### 4. Document Loop Seams Explicitly

**Problem**: The Antigravity bugs found during audit lived at seams between subsystems, not inside isolated functions.

**Rule**: Every flow README MUST call out the seam where control passes between at least two subsystems, especially:
1. pre-hooks to service selection
2. bootstrap to quota store to quota selection
3. generation outcome to post-hook telemetry
4. provider lifecycle to TLS cleanup
5. worker readiness to heartbeat and restart behavior

**Example from the audit**: Request correlation, quota reconciliation, refresh re-admission, and readiness-aware restart handling all failed at these seams before being fixed.

**File locations**: `src/utils/common.js`, `src/providers/provider-pool-manager.js`, `src/core/launcher-supervisor.js`

## Accuracy Rules

### 5. Separate Fixed Disconnections From Remaining Constraints

**Problem**: Debugging docs are less useful when current behavior, historical breakage, and ongoing deployment constraints are blended together.

**Rule**: Each flow README MUST distinguish:
1. the current happy-path behavior
2. the breakages that were fixed in this branch
3. the remaining operational constraints that are intentional

**Example from master-worker-launcher-supervision**: readiness-aware restart semantics are fixed, while Docker PID 1 still depends on `tini` or real `waitpid` support by design.

**File locations**: `src/core/master.js`, `src/core/launcher-supervisor.js`, `src/core/launchers/docker-aware-launcher.js`

### 6. Treat SQLite As Shared State, Not Hidden Implementation Detail

**Problem**: Quota, fingerprint, and telemetry behavior are not understandable from request code alone.

**Rule**: Whenever a flow touches quota, fingerprint, or telemetry persistence, you MUST show the SQLite table involvement explicitly in the README quick reference and database sections.

**Example from antigravity-telemetry-metrics-and-trajectory**: telemetry payload emission is incomplete without `telemetry_log` persistence.

**File locations**: `src/db/sqlite.js`, `src/db/quota-store.js`, `src/db/fingerprint-store.js`, `src/db/telemetry-log-store.js`

## Domain Rules

### 7. Use Runtime Event Names Exactly

**Problem**: The launcher flow depends on exact IPC message names and readiness state.

**Rule**: When documenting supervision, you MUST use the literal event names `ready`, `heartbeat_ping`, `heartbeat_pong`, and `restart_request` instead of paraphrases.

**Example from master-worker-launcher-supervision**: the worker does not become healthy for operational purposes until `ready` is observed.

**File locations**: `src/core/launcher-supervisor.js`, `src/services/worker-ipc.js`, `src/ui-modules/system-api.js`

### 8. Treat Telemetry Templates As Contract Artifacts

**Problem**: The Antigravity telemetry path is defined partly by restored Appendix templates, not only by code.

**Rule**: When documenting telemetry flows, you MUST mention both the runtime hooks and the template payload files that constrain the emitted shape.

**Example from antigravity-telemetry-metrics-and-trajectory**: `recordCodeAssistMetrics` and `recordTrajectoryAnalytics` are both shaped from template JSON files in `tools/security-poc/payloads/`.

**File locations**: `src/middleware/antigravity/metrics-post.js`, `src/middleware/antigravity/trajectory-post.js`, `tools/security-poc/payloads/recordCodeAssistMetrics.json`, `tools/security-poc/payloads/recordTrajectoryAnalytics.json`
