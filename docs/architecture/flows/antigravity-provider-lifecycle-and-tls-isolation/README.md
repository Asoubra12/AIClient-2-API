# Antigravity Provider Lifecycle And TLS Isolation

**Status**: Active
**Type**: Write Operation
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the provider-pool lifecycle rules that decide whether an Antigravity node can be selected, refreshed, quarantined, or cleaned up. It also documents the TLS-isolation constraints that require per-node proxy configuration and destroy cached agents when lifecycle state changes.

- Enabled Antigravity nodes must have a per-node `PROXY_URL` or startup fails fast.
- Selection honors TLS switch-gap and session-budget rules for Antigravity.
- Lifecycle cleanup destroys cached Antigravity agents on unhealthy, quarantine, or removal paths.
- Refresh success now restores health immediately instead of waiting for a later health check.

## Flow Boundaries

**Start**: Provider pool initialization, selection, health change, or refresh-state transition

**Alternative Starts**: Scheduled recovery and explicit refresh enqueue reuse the same lifecycle logic

**End**: Node is selected, excluded, quarantined, refreshed, or cleaned up

**Scope**: Covers repo-local pool state, lifecycle transitions, TLS agent cleanup, and configuration gating. It does not cover request payload conversion or telemetry payload construction.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| None public | n/a | `AIClient-2-API` | Internal provider lifecycle and selection flow |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | Lifecycle changes are internal pool events | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| None mandatory | n/a | n/a | Lifecycle state is tracked mainly in memory and config objects |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Provider pool | `initializeProviderStatus()` | Validate and initialize provider lifecycle state |
| Provider pool | `acquireSlotWithFallback()` | Select a healthy node while respecting lifecycle constraints |
| Provider pool | `markProviderUnhealthyImmediately()` / `resetProviderRefreshStatus()` | Move nodes through unhealthy and recovery transitions |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Startup validation | Missing per-node proxy is a fail-fast configuration error |
| TLS isolation | Selection can wait before switching accounts or hosts |
| Cleanup | Cached Antigravity agents are destroyed on lifecycle changes |
| Recovery | Successful refresh marks the node healthy again immediately |

## Flow Steps

1. Pool initialization runs through `src/providers/provider-pool-manager.js:762`.
2. Startup validation enforces per-node Antigravity proxies through `src/providers/provider-pool-manager.js:210`.
3. Selection-time TLS isolation waits can be applied through `src/providers/provider-pool-manager.js:153` and `src/providers/provider-pool-manager.js:164`.
4. Lifecycle cleanup destroys cached Antigravity agents in `src/providers/provider-pool-manager.js:179` and `src/providers/provider-pool-manager.js:186`.
5. `selectProvider()` prefers `preSelectedUuid` but can fall back to score-based selection at `src/providers/provider-pool-manager.js:1023`.
6. `acquireSlotWithFallback()` runs the pool selection and slot lifecycle at `src/providers/provider-pool-manager.js:1065`.
7. Immediate unhealthy marking executes through `src/providers/provider-pool-manager.js:1565`.
8. Scheduled recovery cleanup uses `src/providers/provider-pool-manager.js:1623` and `src/providers/provider-pool-manager.js:1629`.
9. Refresh success clears `needsRefresh`, `refreshCount`, and `scheduledRecoveryTime`, then marks the node healthy again in `src/providers/provider-pool-manager.js:1699` and `src/providers/provider-pool-manager.js:1707`.

### Failure Scenarios

**Missing per-node proxy**:
- Enabled Antigravity node fails startup validation immediately.
- The repo treats this as invalid configuration, not a soft warning.
- End state: process cannot safely start with that pool configuration.

**Refresh exhausts retry budget**:
- Refresh queue marks the node unhealthy after the maximum refresh count.
- Cached TLS resources are destroyed as part of lifecycle cleanup.
- End state: node is excluded until a later recovery succeeds.

## Repositories Involved

- **AIClient-2-API**: provider lifecycle, TLS cleanup, and selection rules

## Related Flows

- **[Antigravity Quota Refresh And Startup Prewarm](../antigravity-quota-refresh-and-startup-prewarm/README.md)**: Produces `needsRefresh` and recovery transitions
- **[Model Catalog And Provider Health Read Path](../model-catalog-and-provider-health-read-path/README.md)**: Exposes lifecycle state to operators

## Events Produced

| Event | Purpose |
|-------|---------|
| None | Lifecycle transitions stay inside the provider pool manager |

## Database Operations

No persistent database writes are required for the core lifecycle transitions documented here.

## External Integrations

- **Per-node TLS proxy**: required for each enabled Antigravity node
  - Endpoint: per-node `PROXY_URL`
  - Synchronous configuration dependency for selection safety

## What Happens After This Flow

### State at Flow Completion

- Node is either selectable, awaiting recovery, or excluded from the pool
- Cached TLS state has been cleaned when lifecycle rules require it

### Next Steps

Request-time generation and read-path health surfaces consume the lifecycle state established here.

### External System Integration

The only external dependency enforced here is the per-node TLS proxy path used by Antigravity traffic.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
