# Architecture Flows

## Overview

This library documents the implemented Antigravity runtime flows inside `AIClient-2-API`. It focuses on the request, bootstrap, telemetry, provider-lifecycle, and launcher loops that were traced directly from code and validated during the March 6, 2026 Antigravity audit.

## Flows

### Write Operations

| Flow | Complexity | Start | End | Repos |
|------|------------|-------|-----|-------|
| [Antigravity Content Generation Happy Path](./antigravity-content-generation-happy-path/README.md) | High | `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent` | Response returned and provider post-hooks scheduled | 1 |
| [Antigravity Prehook Selection And Chain Setup](./antigravity-prehook-selection-and-chain-setup/README.md) | Medium | Provider pre-hook execution for an Antigravity-bound generation request | Request-scoped Antigravity account is selected, initialized, and sessionized | 1 |
| [Antigravity Stream Unary Retry And Fallback](./antigravity-stream-unary-retry-and-fallback/README.md) | High | Generation error or pool-slot failure during content handling | Request succeeds on fallback or terminates with final error metadata | 1 |

### Read Operations

| Flow | Complexity | Start | End | Repos |
|------|------------|-------|-----|-------|
| [Model Catalog And Provider Health Read Path](./model-catalog-and-provider-health-read-path/README.md) | Medium | `GET /v1/models`, `GET /v1beta/models`, `GET /provider_health`, `GET /health`, `GET /master/health` | Aggregated health or model catalog response returned | 1 |

### Event-Triggered Flows

| Flow | Complexity | Start | End | Repos |
|------|------------|-------|-----|-------|
| [Antigravity Telemetry Metrics And Trajectory](./antigravity-telemetry-metrics-and-trajectory/README.md) | High | Provider post-hook execution after generation success or failure | Telemetry API calls are sent and payloads are persisted to SQLite | 1 |
| [Antigravity Provider Lifecycle And TLS Isolation](./antigravity-provider-lifecycle-and-tls-isolation/README.md) | High | Pool selection, health changes, refresh failures, or TLS cleanup events | Provider is selected, quarantined, refreshed, or re-admitted | 1 |
| [Master Worker Launcher Supervision](./master-worker-launcher-supervision/README.md) | High | Master boot, worker IPC, or restart requests | Worker reaches ready state or is restarted/stopped | 1 |

### Scheduled Flows

| Flow | Complexity | Start | End | Repos |
|------|------------|-------|-----|-------|
| [Antigravity Init Bootstrap And Model Discovery](./antigravity-init-bootstrap-and-model-discovery/README.md) | High | Antigravity service `initialize()` or lazy bootstrap | Project, user, model, and quota state are loaded into service state and SQLite | 1 |
| [Antigravity Quota Refresh And Startup Prewarm](./antigravity-quota-refresh-and-startup-prewarm/README.md) | Medium | Startup prewarm, quota scheduler, or token-near-expiry refresh | Account readiness and quota state are refreshed for later selection | 1 |

### Deprecated Flows

| Flow | Deprecated Date | Reason |
|------|-----------------|--------|
| none | n/a | n/a |

## Coverage Summary

- Total in-scope API endpoints: 15 mapped / 15 in scope
- Total in-scope runtime events: 4 mapped / 4 in scope
- Total documented flow folders: 9
- Unmapped endpoints: none in the repo-local Antigravity scope
- Unmapped runtime events: none in the repo-local Antigravity scope

## Dead Events

- None confirmed in the repo-local Antigravity scope. UI event-broadcast traffic exists, but it is outside this focused flow set.

## Gaps

- Adjacent repositories are intentionally excluded from this first library pass.
- No OpenAPI or AsyncAPI artifacts exist in this repo for the traced Antigravity surfaces.
- Endpoint and runtime-event counts are scoped to the Antigravity audit surface, not the entire application.

## Cross-Flow Observations

- The primary loop seam is request-scoped account selection flowing into pool-slot acquisition, then back into post-hook telemetry.
- SQLite is the shared state anchor across quota, fingerprint, and telemetry flows.
- The launcher loop is structurally separate from the content path, but readiness and restart semantics directly affect `/master/health` and operational debugging.
- The fixed disconnections from the audit are now part of the documented flow shape rather than side notes: request correlation, quota reconciliation, refresh re-admission, and readiness-aware restart handling.
