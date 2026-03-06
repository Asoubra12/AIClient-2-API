# Master Worker Launcher Supervision

**Status**: Active
**Type**: Write Operation
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the Phase 8 control plane that supervises the worker process. It includes master startup, launcher strategy selection, readiness gating, heartbeat monitoring, restart handling, and the UI restart entry point that now acknowledges restart requests separately from actual worker readiness.

- `ready` and heartbeat are distinct control signals.
- `/master/health` reflects worker readiness, not just the fact that a process exists.
- UI restart returns accepted state and points operators to `/master/health` for readiness confirmation.
- Launcher strategy fallback and restart behavior are part of the same supervision loop.

## Flow Boundaries

**Start**: Master boot, `POST /master/start`, `POST /master/restart`, or UI `restart_request`

**Alternative Starts**: Missed heartbeat or worker exit schedules the same restart path

**End**: Worker reports `ready`, is restarted, or is reported unhealthy/degraded by master health

**Scope**: Covers repo-local master-worker IPC, launcher supervision, and control-plane endpoints. It does not document provider request handling inside the worker.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| `/master/status` | GET | `AIClient-2-API` | Return raw supervisor status |
| `/master/health` | GET | `AIClient-2-API` | Readiness-aware health surface |
| `/master/restart` | POST | `AIClient-2-API` | Restart worker and wait for readiness |
| `/master/stop` | POST | `AIClient-2-API` | Stop worker |
| `/master/start` | POST | `AIClient-2-API` | Start worker and wait for readiness |
| `/api/restart-service` | POST | `AIClient-2-API` | UI-facing restart request path |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| `ready` | IPC | worker lifecycle | Confirm worker readiness | `LauncherSupervisor` |
| `heartbeat_ping` | IPC | worker liveness | Probe worker liveness | worker IPC handler |
| `heartbeat_pong` | IPC | worker liveness | Confirm worker liveness | `LauncherSupervisor` |
| `restart_request` | IPC | control plane | Ask master to restart worker | `LauncherSupervisor` |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| None | n/a | n/a | Supervision state is in memory |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Launcher supervisor | `startWorker()` / `restartWorker()` / `stopWorker()` | Own worker process lifecycle |
| Launcher supervisor | `awaitWorkerReady()` | Gate readiness-aware admin responses |
| Worker IPC | `setupWorkerIpc()` | Respond to heartbeat messages from master |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Readiness gate | Admin success waits on `ready`, not just spawn success |
| Heartbeat model | Supervisor sends pings and counts missed beats |
| Restart behavior | Worker exits and missed heartbeats both schedule restart |
| UI semantics | UI restart is accepted immediately but not treated as readiness confirmation |

## Flow Steps

1. Master config and supervisor are created in `src/core/master.js:48`.
2. Worker start begins in `src/core/launcher-supervisor.js:211`.
3. The supervisor keeps readiness waiters and resolves them through `src/core/launcher-supervisor.js:173` and `src/core/launcher-supervisor.js:185`.
4. The worker sends `ready` to master from `src/services/api-server.js:372`.
5. `LauncherSupervisor` marks `workerReadyReported` and settles readiness waiters in `src/core/launcher-supervisor.js:393`.
6. Heartbeat pings are sent from `src/core/launcher-supervisor.js:135`.
7. Worker IPC replies with `heartbeat_pong` in `src/services/worker-ipc.js:26`.
8. Missed heartbeats trigger restart in `src/core/launcher-supervisor.js:140` and `src/core/launcher-supervisor.js:142`.
9. Worker exit before readiness or later runtime failure can schedule restart via `src/core/launcher-supervisor.js:363` and `src/core/launcher-supervisor.js:377`.
10. Master endpoints surface readiness-aware state through `src/core/master.js:97`, `src/core/master.js:102`, and `src/core/master.js:139`.
11. The UI restart endpoint emits `restart_request` and returns accepted status in `src/ui-modules/system-api.js:157` and `src/ui-modules/system-api.js:170`.

### Failure Scenarios

**Worker exits before ready**:
- Readiness waiters are rejected.
- Supervisor schedules a restart instead of claiming healthy startup.
- End state: `/master/health` remains degraded until a later `ready`.

**Heartbeat silence**:
- Missed beats cross the configured threshold.
- Supervisor restarts the worker automatically.
- End state: control plane attempts recovery without waiting for manual intervention.

## Repositories Involved

- **AIClient-2-API**: master process, launcher supervision, worker IPC, and UI restart bridge

## Related Flows

- **[Model Catalog And Provider Health Read Path](../model-catalog-and-provider-health-read-path/README.md)**: Separate read-only operational surface

## Events Produced

| Event | Purpose |
|-------|---------|
| `ready` | Confirm worker is actually ready to serve |
| `heartbeat_ping` | Probe worker liveness |
| `heartbeat_pong` | Confirm worker liveness |
| `restart_request` | Escalate restart intent from worker/UI to supervisor |

## Event Consumers

### `ready` Consumers

#### `LauncherSupervisor`

**Handler**: IPC message switch in `src/core/launcher-supervisor.js`

**Purpose**: Transition the control plane from spawned to actually ready.

**Actions**:
- Sets `workerReadyReported`
- Resolves readiness waiters
- Starts launcher watchdog when supported

### `heartbeat_ping` Consumers

#### Worker IPC

**Handler**: `setupWorkerIpc()`

**Purpose**: Respond to liveness probes from the master.

**Actions**:
- Receives ping
- Sends `heartbeat_pong` back to master

### `restart_request` Consumers

#### `LauncherSupervisor`

**Handler**: IPC message switch in `src/core/launcher-supervisor.js`

**Purpose**: Restart the worker after an explicit restart request.

**Actions**:
- Calls `restartWorker()`
- Preserves readiness-aware semantics for admin surfaces

## Database Operations

No database writes are required for the supervision loop itself.

## External Integrations

- **Launcher strategy implementation**: fork, namespace, docker, or systemd-aware launcher
  - Endpoint: process-launch boundary, not HTTP
  - Synchronous start/stop and asynchronous watchdog behavior

## What Happens After This Flow

### State at Flow Completion

- Worker is either ready, restarting, stopped, or degraded
- Master health reflects real readiness instead of optimistic spawn success

### Next Steps

Once the worker is ready, normal API request handling resumes through the worker process.

### External System Integration

Container init and launcher strategy determine how signals and PID 1 behavior are handled underneath the supervisor.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
