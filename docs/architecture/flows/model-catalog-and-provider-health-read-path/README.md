# Model Catalog And Provider Health Read Path

**Status**: Active
**Type**: Read Operation
**Complexity**: Medium
**Last Updated**: 2026-03-06

## Overview

This flow covers the read-only surfaces that expose model catalog data and provider health state. It includes the protocol model-list endpoints, the direct `/provider_health` route, and the status shaping that makes strict Antigravity constraints visible as explicit availability states.

- `/health` is intentionally shallow and is not the same as `/provider_health`.
- `/provider_health` summarizes pool state rather than just process liveness.
- Model aggregation can run in `AUTO` mode across the full pool or in single-provider mode.
- Missing Antigravity per-node proxies show up as an explicit `missing_proxy` availability state.

## Flow Boundaries

**Start**: `GET /v1/models`, `GET /v1beta/models`, or `GET /provider_health`

**Alternative Starts**: `GET /health` is related but intentionally excluded from deep provider-state reporting

**End**: Aggregated models or provider-health summary is returned to the caller

**Scope**: Covers repo-local read paths only. It does not change provider state except for transient live model fetches.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| `/health` | GET | `AIClient-2-API` | Shallow process health |
| `/provider_health` | GET | `AIClient-2-API` | Provider-pool health and availability summary |
| `/v1/models` | GET | `AIClient-2-API` | OpenAI-style model catalog |
| `/v1beta/models` | GET | `AIClient-2-API` | Gemini-style model catalog |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| None | n/a | n/a | Read-only HTTP flow | n/a |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| None mandatory | n/a | n/a | This flow mainly reads in-memory pool state and provider configuration |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Request handler | `/provider_health` branch | Return provider summary directly |
| Model list handler | `handleModelListRequest()` | Aggregate and normalize model lists |
| Service manager | `getProviderStatus()` | Shape health and availability response |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Health distinction | `/health` != `/provider_health` |
| Aggregation mode | `AUTO` pools all available models; single-provider mode queries one service |
| Availability modeling | Explicit `availabilityState` separates invalid config from healthy selection |
| Disabled behavior | Disabled providers are omitted from selectable-health summaries |

## Flow Steps

1. `/provider_health` is handled directly in `src/handlers/request-handler.js:121`.
2. `getProviderStatus()` in `src/services/service-manager.js:649` loads provider pools and shapes the response.
3. Availability is classified, including `missing_proxy`, through `src/services/service-manager.js:37`.
4. Model list requests route through `src/services/api-manager.js:26` and `src/services/api-manager.js:30`.
5. `handleModelListRequest()` in `src/utils/common.js:1037` chooses `AUTO` aggregation or single-provider resolution.
6. In `AUTO` mode, `getAllAvailableModels()` aggregates models through `src/providers/provider-pool-manager.js:1395`.
7. In single-provider mode, `getApiService()` resolves one provider in `src/services/service-manager.js:499` and the service `listModels()` result is normalized in `src/utils/common.js:1077`.

### Failure Scenarios

**Provider model fetch fails**:
- Aggregation can fall back to static provider model lists.
- The read path still returns a model catalog when possible.
- End state: degraded but non-terminal model visibility.

**Provider is configured but not selectable**:
- The health surface marks it unavailable rather than silently hiding the reason.
- End state: caller sees `missing_proxy`, `disabled`, or unhealthy summary state.

## Repositories Involved

- **AIClient-2-API**: HTTP routing, health shaping, and model aggregation

## Related Flows

- **[Antigravity Provider Lifecycle And TLS Isolation](../antigravity-provider-lifecycle-and-tls-isolation/README.md)**: Defines the pool health state surfaced here
- **[Master Worker Launcher Supervision](../master-worker-launcher-supervision/README.md)**: Provides the separate master-level health surface

## Events Produced

| Event | Purpose |
|-------|---------|
| None | Read-only flow |

## Database Operations

No persistent database operations are required on the hot path for this flow.

## External Integrations

- **Provider model-list APIs**: Used when a live provider can enumerate models
  - Endpoint: provider-specific list models endpoint
  - Synchronous call during model aggregation

## What Happens After This Flow

### State at Flow Completion

- Caller has a read-only snapshot of model or provider health state

### Next Steps

Operators use this surface to decide whether request-path failures come from pool health, config invalidity, or model visibility issues.

### External System Integration

None required after the response is returned.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
