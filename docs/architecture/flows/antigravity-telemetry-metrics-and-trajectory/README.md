# Antigravity Telemetry Metrics And Trajectory

**Status**: Active
**Type**: Write Operation
**Complexity**: Medium
**Last Updated**: 2026-03-06

## Overview

This flow covers the post-generation telemetry pipeline. It derives stable fingerprints, builds metrics and trajectory payloads from the finalized request outcome, respects `telemetryMode`, sends telemetry fire-and-forget, and records delivery state in SQLite.

- Telemetry runs for both success and failure outcomes because the request path preserves failure metadata.
- `telemetryMode` supports `full`, `redacted`, and `off`.
- Metrics and trajectory share the same request-log record.
- Stable per-account fingerprints are persisted separately from telemetry rows.

## Flow Boundaries

**Start**: Provider post-hooks are invoked with finalized request outcome metadata

**Alternative Starts**: None

**End**: Metrics and trajectory payloads are sent or skipped, and telemetry log state is persisted

**Scope**: Covers repo-local payload shaping, fingerprint lookup, SQLite logging, and telemetry dispatch. It does not document upstream telemetry processing after the POST succeeds.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| Upstream metrics endpoint | POST | external | Record code assist metrics |
| Upstream trajectory endpoint | POST | external | Record trajectory analytics |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| Provider post-hooks | plugin/provider | request outcome | Trigger telemetry work after generation | `MetricsHook`, `TrajectoryHook` |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `telemetry_log` | INSERT / UPDATE | `account_email`, `request_id`, `model` | Track per-request telemetry delivery |
| `account_fingerprints` | SELECT / INSERT | `account_email` | Persist stable per-account fingerprints |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Metrics hook | `buildPayload()` | Build metrics payload and update log state |
| Trajectory hook | `buildPayload()` | Build Appendix-shaped trajectory payload and update log state |
| Telemetry utils | prompt builders | Redact or preserve request/conversation content |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Dispatch model | Fire-and-forget with bounded concurrency |
| Privacy mode | `full`, `redacted`, or `off` |
| Persistence | Shared request log plus stable fingerprint store |
| Failure coverage | Success and failure outcomes both reach the telemetry pipeline |

## Flow Steps

1. The request path invokes provider post-hooks in `src/utils/common.js:1281`.
2. `MetricsHook` begins at `src/middleware/antigravity/metrics-post.js:24` and `TrajectoryHook` begins at `src/middleware/antigravity/trajectory-post.js:119`.
3. Stable per-account fingerprints are loaded or created through `src/middleware/antigravity/fingerprint.js:49`, `src/middleware/antigravity/fingerprint.js:69`, and `src/db/fingerprint-store.js:12`.
4. Telemetry mode is resolved through `src/middleware/antigravity/telemetry-utils.js:78`, and `off` short-circuits the payload path.
5. Metrics and trajectory ensure a shared request log row through `src/middleware/antigravity/metrics-post.js:78` and `src/middleware/antigravity/trajectory-post.js:184`.
6. The hooks build payloads in `src/middleware/antigravity/metrics-post.js:85`, `src/middleware/antigravity/trajectory-post.js:191`, `src/middleware/antigravity/telemetry-utils.js:272`, and `src/middleware/antigravity/telemetry-utils.js:305`.
7. Successful sends update `telemetry_log` through `src/db/telemetry-log-store.js:74` and `src/db/telemetry-log-store.js:86`.
8. Cleanup scheduling keeps telemetry retention bounded through the telemetry log store and SQLite maintenance path.

### Failure Scenarios

**Telemetry disabled**:
- `telemetryMode` resolves to `off`.
- Payload construction and outbound send are skipped intentionally.
- End state: no outbound telemetry, no bug condition.

**Telemetry send fails**:
- The hook logs the failure but does not block the request path.
- SQLite still records the attempt so operators can inspect missing sends later.
- End state: client request is unaffected; operational follow-up may be needed.

## Repositories Involved

- **AIClient-2-API**: telemetry shaping, fingerprint persistence, and delivery logging

## Related Flows

- **[Antigravity Content Generation Happy Path](../antigravity-content-generation-happy-path/README.md)**: Supplies the finalized request outcome metadata
- **[Antigravity Provider Lifecycle And TLS Isolation](../antigravity-provider-lifecycle-and-tls-isolation/README.md)**: Supplies the actual selected account and node state carried into telemetry context

## Events Produced

| Event | Purpose |
|-------|---------|
| Metrics POST | Record compact outcome metrics upstream |
| Trajectory POST | Record detailed trajectory analytics upstream |

## Event Consumers

### Provider post-hook Consumers

#### `MetricsHook`

**Handler**: `MetricsHook.run()`

**Purpose**: Emit compact metrics for the completed request.

**Actions**:
- Ensures request log state exists
- Sends metrics payload
- Marks metrics delivery in SQLite

#### `TrajectoryHook`

**Handler**: `TrajectoryHook.run()`

**Purpose**: Emit redacted or full trajectory payloads shaped from the captured template.

**Actions**:
- Builds prompt and conversation-history fields from live context
- Sends the trajectory payload if telemetry is enabled
- Marks trajectory delivery in SQLite

## Database Operations

### `telemetry_log` Table

- **Operation**: `INSERT` / `UPDATE`
- **Key Fields**: `account_email`, `request_id`, `model`
- **Repository**: `src/db/telemetry-log-store.js`

### `account_fingerprints` Table

- **Operation**: `SELECT` / `INSERT`
- **Key Fields**: `account_email`, `fingerprint_json`
- **Repository**: `src/db/fingerprint-store.js`

## External Integrations

- **Antigravity telemetry APIs**: receive metrics and trajectory payloads
  - Endpoint: upstream telemetry endpoints defined by Antigravity
  - Asynchronous fire-and-forget calls during the post-hook phase

## What Happens After This Flow

### State at Flow Completion

- Telemetry rows reflect whether metrics and trajectory were sent
- Account fingerprint remains stable for later requests

### Next Steps

Operators can inspect SQLite telemetry rows to diagnose delivery gaps without needing to replay the request itself.

### External System Integration

Upstream telemetry services may record the request asynchronously after the client response has already finished.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
