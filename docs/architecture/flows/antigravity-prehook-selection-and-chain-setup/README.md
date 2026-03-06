# Antigravity Prehook Selection And Chain Setup

**Status**: Active
**Type**: Write Operation
**Complexity**: Medium
**Last Updated**: 2026-03-06

## Overview

This flow covers the Antigravity-specific pre-hook pipeline that runs before actual service selection. It picks the best request-scoped account from quota state, ensures the selected account is initialized, assigns a stable session ID, and reconciles quota reservations after the real provider choice is known.

- The flow is request-scoped and does not mutate shared config.
- Quota selection happens before service acquisition.
- Initialization is lazy and retries once before marking the node unhealthy.
- Reservation reconciliation closes the old mismatch between hinted and actual accounts.

## Flow Boundaries

**Start**: Provider pre-hook execution begins inside `handleContentGenerationRequest()`

**Alternative Starts**: None

**End**: `preSelectedUuid`, `quotaReservation`, and `sessionId` are attached to the request context, and the reservation is reconciled after actual selection

**Scope**: Covers only the Antigravity pre-hook pipeline and its hand-off into service selection. It does not cover the later generation call itself.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| Inherited content endpoints | POST | `AIClient-2-API` | Trigger the shared pre-hook pipeline before generation |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | This flow is synchronous request middleware | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `quota_state` | SELECT / UPDATE | `account_email`, `model_name` | Read local quota and reserve estimated capacity |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Antigravity pipeline | `initialize()` | Register ordered hook execution |
| Quota selection | `QuotaSelectHook.run()` | Pick the best request-scoped account |
| Chain setup | `ChainSetupHook.run()` | Initialize the selected Antigravity account |
| Session identity | `SessionIdHook.run()` | Attach a stable session ID |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Ordering | quota selection -> chain setup -> session ID |
| Persistence | Reads and updates `quota_state` via SQLite-backed store |
| Safety | Reservation is reconciled to the actual account after final selection |
| Recovery | Initialization retries once before unhealthy marking |

## Flow Steps

1. `src/middleware/antigravity/index.js:88` initializes the pipeline and registers `QuotaSelectHook`, `ChainSetupHook`, and `SessionIdHook`.
2. `handleContentGenerationRequest()` enters provider pre-hook execution in `src/utils/common.js:1159`.
3. `QuotaSelectHook` scans healthy, enabled Antigravity accounts in `src/middleware/antigravity/quota-select.js:75`.
4. The hook reads quota state from `src/db/quota-store.js:16` and decrements the local estimate reservation in `src/db/quota-store.js:64` and `src/middleware/antigravity/quota-select.js:138`.
5. The hook returns `preSelectedUuid` and `quotaReservation` in `src/middleware/antigravity/quota-select.js:142`.
6. `ChainSetupHook` initializes the chosen Antigravity account and retries once in `src/middleware/antigravity/chain-setup.js:55` and `src/middleware/antigravity/chain-setup.js:60`.
7. `SessionIdHook` generates a stable session ID in `src/middleware/antigravity/session-id.js:14`.
8. `handleContentGenerationRequest()` threads `preSelectedUuid` into selection options in `src/utils/common.js:1184`.
9. After real provider choice is known, `reconcileQuotaReservation()` closes the loop between hinted and actual account in `src/utils/common.js:1210` and `src/middleware/antigravity/quota-select.js:32`.

### Failure Scenarios

**No quota data at cold start**:
- The hook cannot make a quota-based choice.
- Background refresh is scheduled instead of forcing a bad selection.
- End state: later selection falls back to pool logic.

**Chain setup fails twice**:
- The hook attempts initialization twice.
- The selected node is treated as unhealthy after the retry limit is hit.
- End state: the request path falls into service fallback or failure handling.

## Repositories Involved

- **AIClient-2-API**: Antigravity pre-hook orchestration and quota persistence

## Related Flows

- **[Antigravity Content Generation Happy Path](../antigravity-content-generation-happy-path/README.md)**: Consumes the request-scoped selection output
- **[Antigravity Quota Refresh And Startup Prewarm](../antigravity-quota-refresh-and-startup-prewarm/README.md)**: Refreshes the quota state used here

## Events Produced

| Event | Purpose |
|-------|---------|
| None | This flow uses synchronous request context only |

## Database Operations

### `quota_state` Table

- **Operation**: `SELECT` / `UPDATE`
- **Key Fields**: `account_email`, `model_name`, `local_estimate`
- **Repository**: `src/db/quota-store.js`

## External Integrations

- **Antigravity initialization API**: Lazy bootstrap for the selected account
  - Endpoint: upstream bootstrap chain via `service.initialize()`
  - Synchronous call during pre-hook execution

## What Happens After This Flow

### State at Flow Completion

- Request context: contains `preSelectedUuid`, `quotaReservation`, and `sessionId`
- Selected account: initialized or rejected before generation

### Next Steps

Service acquisition consumes the request-scoped selection data and starts generation or fallback handling.

### External System Integration

If lazy initialization was required, upstream Antigravity bootstrap calls have already begun by the end of this flow.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
