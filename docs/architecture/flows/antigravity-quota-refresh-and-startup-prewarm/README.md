# Antigravity Quota Refresh And Startup Prewarm

**Status**: Active
**Type**: Scheduled
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the background work that keeps Antigravity accounts warm and quota-aware. It includes startup prewarm batching, scheduled quota refresh, near-expiry refresh signaling, and the persistence loop that feeds request-time quota selection.

- Startup prewarm initializes Antigravity accounts in batches of five.
- Scheduled quota refresh deduplicates in-flight work per provider type.
- Refresh failures mark accounts `needsRefresh` for later recovery.
- Request-time quota selection depends on the state maintained here.

## Flow Boundaries

**Start**: Process startup, scheduler tick, or a near-expiry / unauthorized signal marks an account for refresh

**Alternative Starts**: Immediate refresh can be triggered after auth or generation detects stale credentials

**End**: Refreshed account state is persisted and the node can re-enter request selection

**Scope**: Covers background quota and auth maintenance only. It does not cover the request-time generation path itself.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| None public | n/a | `AIClient-2-API` | Internal scheduled and startup maintenance flow |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | Scheduler and startup loops are internal | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `quota_state` | INSERT / UPDATE | `account_email`, `model_name` | Store refreshed quota values |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Service manager | `prewarmAntigravityAccounts()` | Initialize accounts in startup batches |
| Quota scheduler | `scheduleNextRefresh()` / `refreshProviderPool()` | Maintain background quota refresh |
| Provider pool | `_refreshNodeToken()` | Refresh credentials and health state |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Startup batching | 5 accounts per batch with 1 second gap |
| Scheduler dedupe | One in-flight refresh promise per provider type |
| Failure marking | `needsRefresh` and scheduled recovery time can gate selection |
| Feedback loop | Refreshed quota state is consumed by request-time quota selection |

## Flow Steps

1. Startup calls `prewarmAntigravityAccounts()` in `src/services/service-manager.js:408`.
2. Each batch calls `adapter.antigravityApiService.initialize()` in `src/services/service-manager.js:438`.
3. Failed startup prewarm marks the provider `needsRefresh` in `src/services/service-manager.js:450`.
4. The quota scheduler registers the next refresh at `src/middleware/antigravity/quota-scheduler.js:59` and `src/middleware/antigravity/quota-scheduler.js:62`.
5. `refreshProviderPool()` runs at `src/middleware/antigravity/quota-scheduler.js:84` and marks failed providers `needsRefresh` at `src/middleware/antigravity/quota-scheduler.js:118`.
6. Near-expiry or quota-pressure signals in `src/providers/gemini/antigravity-core.js:851`, `src/providers/gemini/antigravity-core.js:905`, `src/providers/gemini/antigravity-core.js:1260`, and `src/providers/gemini/antigravity-core.js:1363` trigger the same maintenance loop.
7. Provider-pool refresh buffering and concurrency control run through `src/providers/provider-pool-manager.js:338`, `src/providers/provider-pool-manager.js:400`, and `src/providers/provider-pool-manager.js:518`.
8. Successful refresh or re-init clears `needsRefresh` and restores health in `src/providers/provider-pool-manager.js:1690`.

### Failure Scenarios

**Refresh repeatedly fails**:
- Refresh count rises through the provider-pool refresh queue.
- The node can be marked unhealthy after the retry budget is exhausted.
- End state: the account is excluded until a later recovery succeeds.

**Startup prewarm partially fails**:
- Healthy accounts are still warmed and usable.
- Failed accounts remain visible as `needs_refresh` or scheduled recovery.
- End state: degraded pool, not total startup failure.

## Repositories Involved

- **AIClient-2-API**: scheduler, prewarm, refresh buffering, and quota persistence

## Related Flows

- **[Antigravity Init Bootstrap And Model Discovery](../antigravity-init-bootstrap-and-model-discovery/README.md)**: The bootstrap chain run by prewarm and refresh
- **[Antigravity Prehook Selection And Chain Setup](../antigravity-prehook-selection-and-chain-setup/README.md)**: Consumes the quota state maintained here

## Events Produced

| Event | Purpose |
|-------|---------|
| None | Internal scheduled maintenance flow |

## Database Operations

### `quota_state` Table

- **Operation**: `INSERT` / `UPDATE`
- **Key Fields**: `account_email`, `model_name`, `remaining_fraction`, `local_estimate`
- **Repository**: `src/db/quota-store.js`

## External Integrations

- **Antigravity bootstrap and model APIs**: Refresh credentials and quota state
  - Endpoint: same initialization and quota calls used by `initialize()`
  - Asynchronous scheduling with synchronous execution when the refresh runs

## What Happens After This Flow

### State at Flow Completion

- Accounts: warmed, marked for refresh, or restored to healthy state
- Quota state: refreshed for later request-time selection

### Next Steps

Request-time quota selection uses the updated quota and health state immediately after refresh completion.

### External System Integration

None beyond the upstream Antigravity calls already completed during refresh.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
