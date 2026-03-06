# Antigravity Init Bootstrap And Model Discovery

**Status**: Active
**Type**: Event-Triggered
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the real Antigravity account bootstrap chain used by this repo. It authenticates or refreshes the account, runs the bootstrap discovery calls, loads project and user state, fetches available models and admin controls, and persists quota data for later request-time selection.

- Initialization is per-account and guarded by an in-flight mutex.
- The bootstrap chain is ordered and now matches the captured plan.
- Quota discovery is part of initialization, not a separate manual step.
- Successful refresh immediately reconnects the provider to the pool state.

## Flow Boundaries

**Start**: `service.initialize()` is invoked for an Antigravity account

**Alternative Starts**: Startup prewarm, lazy chain setup, and retry-driven init reuse the same bootstrap path

**End**: Account has authenticated, project and model state is loaded, and quota state has been persisted

**Scope**: Covers repo-local bootstrap, auth refresh, project discovery, and quota persistence. It does not document upstream Antigravity internals after the repo receives the responses.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| Upstream `cascadeNuxes` | POST/GET path-style via caller | external | Bootstrap chain warm-up |
| Upstream `fetchUserInfo` | POST | external | Discover account identity |
| Upstream `loadCodeAssist` | POST | external | Load metadata and project context |
| Upstream `fetchAvailableModels` | POST | external | Discover models and quota |
| Upstream `fetchAdminControls` | POST | external | Load control-plane metadata |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | This flow is direct bootstrap logic | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `quota_state` | INSERT / UPDATE | `account_email`, `model_name` | Persist quota information discovered during init |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Antigravity service | `initialize()` | Gate account bootstrap behind auth and discovery |
| Discovery chain | `discoverProjectAndModels()` | Execute ordered bootstrap calls |
| Quota store | `upsertQuota()` | Persist quota state for later selection |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Auth strategy | Reuse valid token, refresh near-expiry token, or start auth flow |
| Bootstrap order | `cascadeNuxes -> fetchUserInfo -> loadCodeAssist(metadata) -> loadCodeAssist(project) -> fetchAvailableModels/fetchAdminControls` |
| Persistence | Quota data is written during init |
| Recovery | Refresh success clears `needsRefresh` and marks the node healthy again |

## Flow Steps

1. `initialize()` starts at `src/providers/gemini/antigravity-core.js:860` and ensures only one bootstrap is in flight for the account.
2. Auth state is checked and refreshed when needed through `src/providers/gemini/antigravity-core.js:905`, `src/providers/gemini/antigravity-core.js:919`, and `src/providers/gemini/antigravity-core.js:923`.
3. `discoverProjectAndModels()` begins in `src/providers/gemini/antigravity-core.js:1026`.
4. The bootstrap chain runs `cascadeNuxes` at `src/providers/gemini/antigravity-core.js:1034`, `fetchUserInfo` at `src/providers/gemini/antigravity-core.js:1038`, and metadata `loadCodeAssist` at `src/providers/gemini/antigravity-core.js:1041`.
5. If onboarding is needed, `onboardUser` is invoked through `src/providers/gemini/antigravity-core.js:1057`.
6. Project-scoped `loadCodeAssist` is issued at `src/providers/gemini/antigravity-core.js:1081`.
7. Models and admin controls are fetched through `src/providers/gemini/antigravity-core.js:1087`, `src/providers/gemini/antigravity-core.js:1106`, and `src/providers/gemini/antigravity-core.js:1145`.
8. Quota refresh is triggered or persisted for later selection, and the scheduler can be nudged through `src/providers/gemini/antigravity-core.js:853`.
9. When refresh succeeds, pool refresh state is cleared and the node is marked healthy in `src/providers/provider-pool-manager.js:1690`.

### Failure Scenarios

**Token refresh or auth bootstrap fails**:
- The account cannot serve requests yet.
- Startup prewarm or chain setup records the failure and may mark the node for refresh.
- End state: provider remains unavailable until a later recovery path succeeds.

**Bootstrap discovery fails after auth**:
- The account has credentials but lacks project/model state.
- Request-time chain setup or scheduled prewarm must retry later.
- End state: node is not safe for selection.

## Repositories Involved

- **AIClient-2-API**: auth, bootstrap discovery, quota persistence

## Related Flows

- **[Antigravity Quota Refresh And Startup Prewarm](../antigravity-quota-refresh-and-startup-prewarm/README.md)**: Calls initialization in startup and scheduled contexts
- **[Antigravity Prehook Selection And Chain Setup](../antigravity-prehook-selection-and-chain-setup/README.md)**: Reuses initialization lazily for request-time chain setup

## Events Produced

| Event | Purpose |
|-------|---------|
| None | Bootstrap is direct call-driven logic |

## Database Operations

### `quota_state` Table

- **Operation**: `INSERT` / `UPDATE`
- **Key Fields**: `account_email`, `model_name`, `remaining_fraction`, `local_estimate`
- **Repository**: `src/db/quota-store.js`

## External Integrations

- **Antigravity bootstrap APIs**: project discovery and account metadata
  - Endpoint: `cascadeNuxes`, `fetchUserInfo`, `loadCodeAssist`, `fetchAvailableModels`, `fetchAdminControls`
  - Synchronous call chain during initialization

## What Happens After This Flow

### State at Flow Completion

- Account: authenticated and initialized
- Project state: loaded
- Quota state: persisted for scheduler and request-time selection

### Next Steps

The account becomes eligible for startup prewarm completion, request-time chain setup reuse, and quota-based selection.

### External System Integration

Upstream Antigravity has already supplied the bootstrap metadata needed by this repo.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
