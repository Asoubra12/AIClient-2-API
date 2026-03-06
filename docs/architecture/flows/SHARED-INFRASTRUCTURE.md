# Shared Infrastructure

## Overview

These components appear across multiple Antigravity flows in `AIClient-2-API`. Individual flow READMEs reference them where behavior matters, but they are defined once here to keep the per-flow documents focused on the loop being traced.

## Shared Components

- **HTTP server and request routing**
  - Request ingress begins in `src/handlers/request-handler.js` and `src/services/api-manager.js`.
  - The flow docs omit generic Node server setup and only show route steps that materially affect Antigravity behavior.

- **Plugin and middleware pipeline**
  - Provider pre-hooks and post-hooks are orchestrated through `src/core/plugin-manager.js`.
  - The Antigravity pipeline is registered in `src/middleware/antigravity/index.js`.

- **SQLite persistence**
  - Shared local state lives in `src/db/sqlite.js`.
  - Quota, fingerprint, and telemetry-log flows reuse the same SQLite initialization and retention behavior.

- **Provider pool manager**
  - Pool selection, health tracking, refresh control, and TLS cleanup are centralized in `src/providers/provider-pool-manager.js`.
  - Flow diagrams show pool-manager steps explicitly only when selection, quarantine, refresh, or cleanup is part of the loop being traced.

- **Service manager and adapters**
  - Service lookup and adapter construction live in `src/services/service-manager.js` and `src/providers/adapter.js`.
  - These components form the bridge between request handling and provider-specific runtime behavior.

- **Antigravity provider core**
  - The Antigravity implementation is in `src/providers/gemini/antigravity-core.js`.
  - Bootstrap, generation, telemetry API calls, and quota persistence all terminate here.

- **Launcher supervisor**
  - Master-worker boot, readiness, and heartbeats are coordinated by `src/core/launcher-supervisor.js`.
  - Launcher strategy classes under `src/core/launchers/` are treated as runtime infrastructure rather than separate business flows.

## Omitted By Default

- **Shared libraries**
  - Utility helpers and logger internals are omitted unless they change control flow.

- **Authentication boilerplate**
  - Generic request auth checks are omitted unless they materially alter the Antigravity loop.

- **Transport internals**
  - Axios construction, HTTP agent plumbing, and generic SSE framing are omitted unless they are the point of the flow.

- **Container platform details**
  - Docker, `tini`, and launcher packaging choices are described where they affect supervision behavior, not in every flow.

## Repo-Local Scope Rule

- This library documents only code and runtime interactions implemented inside `AIClient-2-API`.
- External services are shown as named integrations, not as traced repositories.
- Adjacent repos under `C:\Users\AbdallahSoubra\kiro` are intentionally excluded from this first persisted flow set.
