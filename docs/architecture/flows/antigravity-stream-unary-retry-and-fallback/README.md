# Antigravity Stream Unary Retry And Fallback

**Status**: Active
**Type**: Write Operation
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the unhappy path after an Antigravity generation attempt fails. It captures error metadata, marks bad nodes unhealthy when appropriate, reacquires a replacement service or credential, reconciles quota against the actual replacement node, and either retries successfully or returns a terminal error.

- Stream and unary handlers share the same fallback shape.
- Retry is only possible before streaming bytes have been committed to the client.
- Health marking and slot cleanup are part of the control loop, not optional cleanup.
- The reservation mismatch between hinted and actual account is closed before recursive retry.

## Flow Boundaries

**Start**: Unary or stream generation throws after the initial provider has been selected

**Alternative Starts**: Pool slot acquisition can also force fallback if no healthy preferred node is available

**End**: A replacement credential/provider succeeds, or the request returns a terminal error after releasing the slot

**Scope**: Covers request-local retry and pool/provider fallback after generation failure. It does not cover the initial success path.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| Inherited content endpoints | POST | `AIClient-2-API` | Same ingress as the main generation flow |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | Retry is internal request control flow | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `quota_state` | UPDATE | `account_email`, `model_name`, `local_estimate` | Reconcile quota reservation when the actual account changes |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Request handler | `handleStreamRequest()` / unary path | Capture errors and decide whether retry is legal |
| Provider pool | `markProviderUnhealthyImmediately()` | Remove bad nodes from selection |
| Service manager | `getApiServiceWithFallback()` | Acquire replacement service/credential |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Retry gate | Disabled once stream bytes are already committed |
| Health loop | Failed pooled nodes can be marked unhealthy immediately |
| Selection loop | Retry re-enters pooled selection with `acquireSlot: true` |
| Reservation handling | Old hinted account and actual replacement account are reconciled |

## Flow Steps

1. The stream path calls the backend at `src/utils/common.js:512`; the unary path does so at `src/utils/common.js:871`.
2. When an exception occurs, error metadata is merged into `responseMetadata` at `src/utils/common.js:652` or `src/utils/common.js:915`.
3. If the error is pool-relevant, the active node is marked unhealthy through `src/utils/common.js:705`, `src/utils/common.js:928`, and `src/providers/provider-pool-manager.js:1565`.
4. The request path asks `getApiServiceWithFallback()` for a replacement in `src/utils/common.js:731` or `src/utils/common.js:960`.
5. `getApiServiceWithFallback()` re-enters pooled selection through `src/services/service-manager.js:539` and `src/services/service-manager.js:563`.
6. `selectProvider()` in `src/providers/provider-pool-manager.js:1023` tries `preSelectedUuid` first and falls back to score-based selection when needed.
7. `reconcileQuotaReservation()` updates the reservation to match the actual replacement account in `src/utils/common.js:737`, `src/utils/common.js:966`, and `src/middleware/antigravity/quota-select.js:32`.
8. The request body is rebuilt for the replacement provider and the handler recurses back into stream or unary processing in `src/utils/common.js:742`, `src/utils/common.js:971`, `src/utils/common.js:759`, and `src/utils/common.js:988`.
9. Every exit path releases the slot through `src/providers/provider-pool-manager.js:909`.

### Failure Scenarios

**Stream already started**:
- Once bytes have been emitted, safe retry is no longer possible.
- The handler returns the terminal error for the live stream.
- End state: slot released, request fails in-place.

**No healthy replacement exists**:
- Fallback selection exhausts the current pool and configured fallbacks.
- The request returns its terminal error after cleanup.
- End state: failure is surfaced to the client with cleaned pool state.

## Repositories Involved

- **AIClient-2-API**: retry control loop, pool fallback, and cleanup

## Related Flows

- **[Antigravity Content Generation Happy Path](../antigravity-content-generation-happy-path/README.md)**: Happy-path counterpart to this recovery flow
- **[Antigravity Provider Lifecycle And TLS Isolation](../antigravity-provider-lifecycle-and-tls-isolation/README.md)**: Defines the unhealthy/quarantine behavior used here

## Events Produced

| Event | Purpose |
|-------|---------|
| None | Retry is handled synchronously inside the request path |

## Database Operations

### `quota_state` Table

- **Operation**: `UPDATE`
- **Key Fields**: `account_email`, `model_name`, `local_estimate`
- **Repository**: `src/db/quota-store.js`

## External Integrations

- **Replacement provider or fallback provider**: Handles the retried generation call
  - Endpoint: provider-specific generation endpoint
  - Synchronous call during retry execution

## What Happens After This Flow

### State at Flow Completion

- Request: either `completed after retry` or `failed terminally`
- Pool state: failed nodes may be unhealthy or quarantined
- Reservation state: tied to the actual account used, not the original hint

### Next Steps

If retry succeeds, post-generation hooks resume as part of the happy path. If retry fails terminally, telemetry still records the failure outcome.

### External System Integration

A successful retry still ends with the same upstream Antigravity generation APIs, just through a different account or provider.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
