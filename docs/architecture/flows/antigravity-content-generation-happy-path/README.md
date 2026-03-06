# Antigravity Content Generation Happy Path

**Status**: Active
**Type**: Write Operation
**Complexity**: High
**Last Updated**: 2026-03-06

## Overview

This flow covers the successful repo-local Antigravity request path from HTTP ingress to the final unary or streaming response. It includes request normalization, Antigravity pre-hook execution, pool-backed service selection, upstream generation, slot release, and fire-and-forget telemetry handoff.

- The request path starts at protocol-specific content endpoints and converges in `src/utils/common.js`.
- Antigravity hooks run before service selection, not after it.
- The same flow handles unary and streaming generation with different internal handlers.
- Telemetry and plugin post-hooks run after the response outcome metadata is finalized.

## Flow Boundaries

**Start**: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, or `POST /v1beta/models/{model}:generateContent|streamGenerateContent`

**Alternative Starts**: None within this repo-local flow

**End**: Final response is emitted, the active slot is released, and `onContentGenerated` plus provider post-hooks are triggered

**Scope**: Covers request entry, hook execution, service selection, Antigravity generation, slot lifecycle, and post-generation handoff. It does not document upstream Antigravity internals beyond the API calls made by this repo.

## Quick Reference

### API Endpoints

| Endpoint | Method | Repository | Purpose |
|----------|--------|------------|---------|
| `/v1/chat/completions` | POST | `AIClient-2-API` | OpenAI-style content generation ingress |
| `/v1/responses` | POST | `AIClient-2-API` | OpenAI Responses ingress |
| `/v1/messages` | POST | `AIClient-2-API` | Anthropic-style ingress |
| `/v1beta/models/{model}:generateContent` | POST | `AIClient-2-API` | Gemini unary ingress |
| `/v1beta/models/{model}:streamGenerateContent` | POST | `AIClient-2-API` | Gemini streaming ingress |

### Events Reference

| Event Name | Domain | Subject | Purpose | Consumers |
|------------|--------|---------|---------|-----------|
| `onContentGenerated` | plugin | request outcome | Notify plugins after generation metadata is finalized | Plugin hooks registered in `src/core/plugin-manager.js` |

### Database Tables

| Table | Operation | Key Fields | Purpose |
|-------|-----------|------------|---------|
| `telemetry_log` | INSERT / UPDATE | `account_email`, `request_id`, `model` | Persist metrics and trajectory delivery state |

### Domain Operations

| Aggregate | Method | Purpose |
|-----------|--------|---------|
| Content request handler | `handleContentGenerationRequest()` | Normalize protocol-specific requests into the shared generation path |
| Provider pool | `acquireSlotWithFallback()` | Reserve a healthy node for the request |
| Antigravity service | `generateContent()` / `generateContentStream()` | Execute upstream generation |

## Key Characteristics

| Aspect | Value |
|--------|-------|
| Selection strategy | Request-scoped selection with optional `preSelectedUuid` |
| Success criteria | Response returned, node marked healthy, slot released |
| Post-response work | Telemetry and plugin post-hooks run after outcome metadata is finalized |
| Correlation | Request IDs fall back to the proxy request ID when upstream metadata does not provide one |

## Flow Steps

1. The request enters `src/handlers/request-handler.js:101` and is routed by `src/services/api-manager.js:38`, `src/services/api-manager.js:42`, `src/services/api-manager.js:46`, or `src/services/api-manager.js:51` depending on the client protocol.
2. `handleContentGenerationRequest()` in `src/utils/common.js:1110` parses the body, extracts the model and stream mode, and builds the provider-shaped pre-hook payload.
3. Provider pre-hooks execute in `src/utils/common.js:1159`, which is where the Antigravity pipeline attaches request-scoped selection data.
4. `getApiServiceWithFallback()` is called from `src/utils/common.js:1188` and resolves a service plus pool metadata in `src/services/service-manager.js:539`.
5. If the request is pool-backed, `acquireSlotWithFallback()` reserves the node in `src/services/service-manager.js:563` and `src/providers/provider-pool-manager.js:1065`.
6. The shared handler converts the request for the backend and dispatches either the stream path at `src/utils/common.js:512` or the unary path at `src/utils/common.js:871`.
7. The Antigravity adapter executes upstream generation through `src/providers/gemini/antigravity-core.js:1437` or `src/providers/gemini/antigravity-core.js:1513`.
8. On success, the request handler records healthy outcome metadata in `src/utils/common.js:645` and `src/utils/common.js:909`.
9. The active slot is always released in `src/utils/common.js:799` or `src/utils/common.js:1018`.
10. Final hook metadata is assembled in `src/utils/common.js:1255`, request correlation is finalized in `src/utils/common.js:1264`, and `onContentGenerated` plus provider post-hooks are triggered in `src/utils/common.js:1270` and `src/utils/common.js:1281`.

### Asynchronous Side Effects - Post Response

11. Metrics and trajectory hooks run fire-and-forget after the request path has enough metadata to describe success or failure.
12. SQLite telemetry rows are created or updated so telemetry completion can be audited later.

### Failure Scenarios

**Generation failure before retry**:
- The request path captures the error into response metadata.
- The unhealthy node path and retry/fallback flow may take over.
- Control passes to the separate [Antigravity Stream Unary Retry And Fallback](../antigravity-stream-unary-retry-and-fallback/README.md) flow.

**Telemetry send failure**:
- The request still completes because post-hooks are intentionally fire-and-forget.
- `telemetry_log` remains the audit surface for missed deliveries.
- End state: caller succeeds, operational follow-up may be required.

## Repositories Involved

- **AIClient-2-API**: HTTP ingress, pool selection, Antigravity generation, telemetry handoff

## Related Flows

- **[Antigravity Prehook Selection And Chain Setup](../antigravity-prehook-selection-and-chain-setup/README.md)**: Supplies request-scoped account selection and session state
- **[Antigravity Stream Unary Retry And Fallback](../antigravity-stream-unary-retry-and-fallback/README.md)**: Handles the unhappy path after generation failure
- **[Antigravity Telemetry Metrics And Trajectory](../antigravity-telemetry-metrics-and-trajectory/README.md)**: Consumes the finalized request outcome metadata

## Events Produced

| Event | Purpose |
|-------|---------|
| `onContentGenerated` | Notify plugins after response metadata is available |

## Event Consumers

### `onContentGenerated` Consumers

#### Plugin manager

**Handler**: `PluginManager.executeHook()`

**Purpose**: Run generic post-generation hooks after the response metadata is complete.

**Actions**:
- Executes registered plugin callbacks
- Hands provider-specific post-hook execution off to the Antigravity telemetry layer

## Database Operations

### `telemetry_log` Table

- **Operation**: `INSERT` / `UPDATE` (via telemetry log store helpers)
- **Key Fields**: `account_email`, `request_id`, `model`
- **Repository**: `src/db/telemetry-log-store.js`

## External Integrations

- **Antigravity generation API**: Executes unary and streaming generation
  - Endpoint: provider-defined `generateContent` / `streamGenerateContent`
  - Synchronous call during request execution

## What Happens After This Flow

### State at Flow Completion

- Request: `completed`
- Selected node: `healthy` and released back to the pool
- Telemetry row: created or updated for post-hook delivery tracking

### Next Steps

The immediate next work is provider post-hook execution, which may emit metrics and trajectory telemetry.

### External System Integration

Upstream Antigravity has already returned the model output by the time this flow ends. Later telemetry calls are separate.

## Diagram

See [diagram.mermaid](./diagram.mermaid) for the complete visual flow.
