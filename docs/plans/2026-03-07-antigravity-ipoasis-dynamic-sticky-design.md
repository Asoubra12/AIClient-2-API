# Antigravity IPOasis Dynamic Sticky Design

**Date:** 2026-03-07

## Goal

Replace manual Antigravity `PROXY_URL` configuration with runtime-generated IPOasis dynamic sticky residential proxies, while keeping the existing TLS-isolation and provider-selection pipeline unchanged after startup materialization.

## Approved Requirements

- Every enabled `gemini-antigravity` node must use IPOasis dynamic residential proxies.
- `sessionType` must always be `sticky`.
- Manual Antigravity `PROXY_URL` is no longer accepted as configuration input.
- The runtime must not call IPOasis to resolve sub-user usernames.
- Each node will carry the direct numeric IPOasis sub-user identifier in config.
- Multiple Antigravity nodes may share the same IPOasis sub-user ID, but each node must get its own separately generated sticky proxy.
- Runtime-generated proxy state should live in SQLite, not in `provider_pools.json`.

## Configuration Model

### Global config

Global app config will provide the shared IPOasis API credentials and defaults:

- `IPOASIS_API_KEY`
- `IPOASIS_PROXY_PROTOCOL` defaulting to `http`
- `IPOASIS_PROXY_COUNTRY`
- optional `IPOASIS_PROXY_CITY`
- optional `IPOASIS_PROXY_STATE`

`IPOASIS_PLAN_ID` is not required for runtime generation in the approved design, because the app will not resolve sub-users by username.

### Per-node Antigravity config

Each enabled `gemini-antigravity` node must provide:

- `IPOASIS_SUBUSER_ID`

Each node may override generation settings with:

- `IPOASIS_PROTOCOL`
- `IPOASIS_COUNTRY`
- `IPOASIS_CITY`
- `IPOASIS_STATE`

The node must not define manual `PROXY_URL` in source config. `PROXY_URL` becomes a runtime-only field injected after lease materialization.

## Runtime Architecture

### 1. SQLite-backed proxy lease state

Add a new SQLite table for runtime proxy leases keyed by Antigravity provider UUID. This table holds the currently materialized proxy for a node and the latest generation metadata:

- `provider_uuid`
- `provider_type`
- `subuser_id`
- `proxy_url`
- `protocol`
- `country`
- `city`
- `state`
- `session_type`
- `lease_state`
- `last_generated_at`
- `last_error`

This matches the existing repo pattern where runtime state such as quotas, fingerprints, and telemetry is persisted outside static config.

### 2. IPOasis proxy generation service

Add a dedicated runtime service responsible for:

- validating required IPOasis settings
- calling `GET /v1/proxy/dynamic/{subUserId}`
- forcing `count=1`
- forcing `sessionType=sticky`
- normalizing IPOasis `host:port:user:pass` strings into a URL compatible with the current proxy-agent stack
- persisting the lease into SQLite

The service does not resolve usernames. It only consumes direct `IPOASIS_SUBUSER_ID`.

### 3. Startup materialization

During provider-pool initialization:

- Antigravity validation changes from "must already have `PROXY_URL`" to "must have valid IPOasis runtime generation config and must not define manual `PROXY_URL`".
- For each enabled Antigravity node, the runtime loads any persisted lease from SQLite.
- If a valid persisted lease exists, inject it into the live node config as `PROXY_URL`.
- If no lease exists, generate a new sticky proxy via IPOasis, persist it, and inject it as `PROXY_URL`.

After this step, the rest of the system continues to operate on a normal concrete `PROXY_URL`. No downstream TLS, OAuth, adapter, quota, telemetry, or request-selection code should need semantic changes.

## Refresh and Recovery Behavior

Proxy lease regeneration should happen when:

- the node has no persisted lease
- the persisted lease fails runtime validation
- the node enters refresh/recovery paths after proxy-auth or upstream connection failures

Lease regeneration updates SQLite first, then updates the live node config. Successful regeneration should immediately restore node selectability.

## Error Handling

- Missing `IPOASIS_API_KEY` or missing per-node `IPOASIS_SUBUSER_ID` is a startup validation error for enabled Antigravity nodes.
- Manual `PROXY_URL` on an enabled Antigravity node is a startup validation error.
- IPOasis generation failure marks the node unavailable and records the failure in SQLite and logs.
- Disabled nodes are exempt from runtime generation validation.
- Shared sub-user IDs are allowed; leases remain keyed by node UUID, not by sub-user ID.

## Testing Strategy

Add focused tests for:

- startup validation rejecting manual Antigravity `PROXY_URL`
- startup validation requiring `IPOASIS_SUBUSER_ID`
- runtime generation turning IPOasis response strings into valid `PROXY_URL` values
- lease persistence and hydration from SQLite
- multiple nodes sharing one `IPOASIS_SUBUSER_ID` but getting distinct generated leases
- refresh/regeneration restoring node readiness after a lease failure

## Files Expected To Change

- `src/core/config-manager.js`
- `src/db/sqlite.js`
- `src/providers/provider-pool-manager.js`
- `src/services/service-manager.js`
- `configs/config.json.example`
- `configs/provider_pools.json.example`
- `tests/antigravity-phase7.test.js`
- new SQLite store and IPOasis runtime service files

## Notes

- The directly resolved live IPOasis data for the current account is:
  - residential plan id: `1271`
  - shared sub-user username: `aiproxy`
  - shared sub-user id: `1865`
- The implementation should use the numeric sub-user ID path and should not perform username lookup at runtime.
