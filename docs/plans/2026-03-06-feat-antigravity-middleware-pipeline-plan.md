---
title: "feat: Antigravity Middleware Pipeline — Full Chain Mimicry"
type: feat
status: active
date: 2026-03-06
origin: docs/brainstorms/2026-03-06-antigravity-deep-rewrite-brainstorm.md
---

# feat: Antigravity Middleware Pipeline — Full Chain Mimicry

## Enhancement Summary

**Deepened on:** 2026-03-06
**Capture-validated on:** 2026-03-06 — All templates verified field-by-field against `mitm-capture/logs/0001–0012`
**Review agents used:** architecture-strategist, security-sentinel, performance-oracle, code-simplicity-reviewer, pattern-recognition-specialist

### Key Improvements Applied
1. **Security: `_preSelectedUuid` → `options.preSelectedUuid`** — Fixed race condition where concurrent requests could cross-contaminate account selection via shared config mutation. Now passed through request-scoped options param.
2. **Security: Trajectory content redaction** — Default to redacted mode for `recordTrajectoryAnalytics`. User conversation content replaced with token-count stubs. API key patterns always masked.
3. **Performance: Telemetry concurrency limiter** — Max 10 trajectory payloads in flight. Prevents 6-21MB memory blow-up under burst traffic.
4. **Performance: Prepared statements** — All SQLite queries via `db.prepare()` (10x faster than raw SQL strings).
5. **Performance: Staggered quota refresh** — 5 accounts/second instead of all 60 at once. Prevents API rate limiting.
6. **Performance: Account pre-warming** — Init all accounts at startup (staggered: 5 at a time) to eliminate 5s first-request latency.
7. **Architecture: Orchestrator moved to Phase 2** — Hook registration framework needed before any hooks can be built.
8. **Architecture: `selectProviderWithFallback()` accounted for** — Pre-selection flows through both selection paths, not just `selectProvider()`.
9. **Architecture: `setTimeout(...).unref()`** — Telemetry timers don't block graceful shutdown.
10. **Stealth: Per-account TLS session isolation** — Mandatory proxy-per-account for Antigravity with velocity-limited switching (PR #310 by @YchampionOP).
11. **Resilience: Tiered LS launch strategies** — Namespace → systemd → docker → fork probe chain with active+passive health checks (PR #323 by @YchampionOP).

### Capture Validation Results (31 discrepancies found and resolved)
See **Appendix A: Capture-Validated Request Templates** at end of document for exact field-by-field structures extracted from MITM captures `0001`–`0012`.

## Overview

Add pre/post middleware hooks to AIClient-2-API's Antigravity provider to make its traffic indistinguishable from a real Antigravity client. Pre-hooks ensure the real request chain setup is complete and select the best account by quota. Post-hooks fire telemetry (metrics + trajectory analytics) with realistic timing. A SQLite-backed quota scheduler tracks per-model `remainingFraction` across all accounts and spreads usage evenly.

This applies learnings from MITM traffic captures of real Antigravity, ZeroGravity analysis, and the linux.do post-guy's account-pooling approach.

## Problem Statement / Motivation

Current AIClient-2-API Antigravity provider:
- Sends only `streamGenerateContent` per request — no post-generation telemetry
- Init chain is incomplete: single `loadCodeAssist` instead of two, missing `fetchAdminControls`
- No device fingerprinting — all requests share identical metadata
- Round-robin account rotation ignores per-model quota (`remainingFraction`)
- Traffic pattern is distinguishable from real Antigravity client

Real Antigravity client (from MITM captures) does:
```
Init (once):  GET cascadeNuxes → fetchUserInfo → loadCodeAssist(chat) → loadCodeAssist(agents) → fetchAvailableModels || fetchAdminControls
Per request:  streamGenerateContent (with userAgent="antigravity", requestType="agent")
Post request: recordCodeAssistMetrics (~12ms after) → recordTrajectoryAnalytics (~95ms after)
```

All requests use header `user-agent: antigravity/{version} {os}/{arch}` (e.g., `antigravity/1.19.6 windows/amd64`).

## Proposed Solution

Middleware pipeline architecture using the existing plugin system, with targeted extensions to support provider-scoped pre/post hooks and quota-aware account selection.

## Technical Approach

### Architecture

```
Client Request
    │
    ▼
┌──────────────────────────────────┐
│  request-handler.js              │
│  ├─ Plugin Auth (line 168)       │
│  ├─ Plugin Middleware (line 181)  │
│  └─ Body parsing + model extract │
│       │                          │
│       ▼                          │
│  ┌────────────────────────────┐  │
│  │  NEW: Provider Pre-Hooks   │  │
│  │  (after body parse, before │  │
│  │   selectProvider)           │  │
│  │  ├─ ChainSetupHook        │  │  → lazy init chain per account
│  │  ├─ QuotaSelectHook       │  │  → pick best account by remainingFraction
│  │  └─ SessionIdHook         │  │  → stable sessionId from hash
│  └────────────────────────────┘  │
│       │                          │
│       ▼                          │
│  selectProvider() (pool manager) │  → honors pre-selected UUID if set
│       │                          │
│       ▼                          │
│  antigravity-core.js             │  → streamGenerateContent (existing)
│       │                          │
│       ▼                          │
│  ┌────────────────────────────┐  │
│  │  NEW: Provider Post-Hooks  │  │
│  │  (fire-and-forget, async)  │  │
│  │  ├─ MetricsHook           │  │  → recordCodeAssistMetrics (~10ms delay)
│  │  └─ TrajectoryHook        │  │  → recordTrajectoryAnalytics (~80ms delay)
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Critical Architecture Decisions

**A1. QuotaSelectHook vs selectProvider() integration** (resolves SpecFlow Gap 1)

QuotaSelectHook does NOT replace `selectProvider()`. Instead:
1. QuotaSelectHook returns the best account's UUID via the request-scoped `options` parameter — NOT through shared `config` object (prevents race condition under concurrent requests where two requests could overwrite each other's pre-selection).
2. The pre-selected UUID is passed as `options.preSelectedUuid` to `selectProvider()` and flows through to `selectProviderWithFallback()` → `_doSelectProvider()`. Both selection paths must honor the hint.
3. In `_doSelectProvider()`: after the filter chain (healthy, not disabled, not draining, not cooling, not risk-blocked), if `options.preSelectedUuid` matches a candidate in the filtered set, select it. Otherwise fall back to normal LRU scoring.
4. The hint is consumed once and not persisted — no stale hints survive across retries in the credential-switch retry loop.
5. This preserves all existing safety mechanisms (cooldown, draining, risk policy) while adding quota intelligence.

**A2. Hook execution point** (resolves SpecFlow Gap 2)

The existing `executeMiddleware()` at line 181 runs too early (before body parsing). Solution:
- Add a new hook point: `executeProviderPreHooks(providerType, model, config)` called inside `handleContentGenerationRequest()` in `src/utils/common.js` — after body parsing (line 1128) but before `getApiServiceWithFallback()` (line 1134).
- Provider pre-hooks are registered per provider type. Only Antigravity hooks run for Antigravity requests.

**A3. onContentGenerated guard** (resolves SpecFlow Gap 25)

The guard at `common.js:1209` (`if (CONFIG?._monitorRequestId)`) must be relaxed. Change to:
```js
if (CONFIG?._monitorRequestId || CONFIG?._telemetryEnabled)
```
Antigravity middleware sets `_telemetryEnabled = true` during pre-hooks.

**A4. Post-hook data contract** (resolves SpecFlow Gap 8)

Extend `onContentGenerated` hook to receive response metadata:
```js
{
  originalRequestBody, processedRequestBody, fromProvider, toProvider, model, isStream,
  // NEW fields:
  responseTokenCount, thinkingTokenCount, latencyMs, firstTokenLatencyMs,
  finishReason, traceId, requestId, streamingDuration
}
```
Backward-compatible — existing hooks ignore new fields.

**A5. Telemetry timing correction**

MITM captures show telemetry fires ~10ms (metrics) and ~82ms (trajectory) after generation **starts** the next request, not after it completes. In our case (single-request context), fire immediately after streaming completes:
- `recordCodeAssistMetrics`: `setTimeout(fn, uniform(10, 200))` ms
- `recordTrajectoryAnalytics`: `setTimeout(fn, uniform(50, 300))` ms

Both fire-and-forget via `setTimeout(...).unref()` to prevent timers from blocking graceful shutdown. No `await`. Errors logged at debug level only.

**A6. Telemetry concurrency limiter**

Never have more than 10 trajectory payloads in flight simultaneously. Use a semaphore counter (`pendingTelemetryCount`). If the count exceeds 10, skip telemetry for new requests until the queue drains. This prevents memory blow-up under burst traffic (50 concurrent requests × 120-430KB payloads = 6-21MB of pending telemetry).

**A7. Trajectory payload privacy — opt-in with content redaction**

The `recordTrajectoryAnalytics` payload includes full conversation context (user prompts, code, system prompt). This is a data exfiltration risk by design. Mitigations:
- **Default: redacted mode** — Strip user message content from trajectory payload. Replace with hash-derived stubs: `"[REDACTED: 106 tokens]"` preserving `numTokens` for structural similarity.
- **Opt-in: full mode** — Configurable per-account in `provider_pools.json` via `telemetryMode: "full" | "redacted" | "off"`. Default `"redacted"`.
- **Content filtering** — Before inclusion, scan for patterns matching API keys (`sk-*`, `AKIA*`, `ghp_*`), private URLs, and email addresses. Mask these even in full mode.

**A8. Account pre-warming at startup**

Pre-initialize all accounts at startup in staggered parallel (5 accounts at a time, 1-second gap between batches) to eliminate the 5-second first-request latency. The init chain (fetchUserInfo → 2×loadCodeAssist → fetchAvailableModels || fetchAdminControls) takes ~5 seconds per account. Without pre-warming, the first request per account blocks for this duration.

### Implementation Phases

#### Phase 1: Foundation — Hook System + SQLite

**Tasks:**
1. Add `better-sqlite3` dependency to `package.json`
2. Create `src/db/sqlite.js` — connection manager with WAL mode, auto-create schema, **all queries via prepared statements** (10x faster than raw SQL strings)
3. Create `src/db/quota-store.js` — CRUD for `quota_state` table (prepared statements cached at init)
4. Create `src/db/fingerprint-store.js` — CRUD for `account_fingerprints` table (prepared statements cached at init)
5. Add provider pre-hook and post-hook execution points in `src/utils/common.js`
6. Modify `src/providers/provider-pool-manager.js`: both `selectProvider()` AND `selectProviderWithFallback()` honor `options.preSelectedUuid` (passed via request-scoped options, NOT shared config)
7. Relax `onContentGenerated` guard in `src/utils/common.js:1209`
8. Extend hook data contract with response metadata

**Files touched:**
- `package.json` (add better-sqlite3)
- `src/db/sqlite.js` (new)
- `src/db/quota-store.js` (new)
- `src/db/fingerprint-store.js` (new)
- `src/utils/common.js` (lines 1128-1134: add pre-hooks; lines 1209-1223: relax guard + extend data)
- `src/providers/provider-pool-manager.js` (lines 1423-1528: honor `options.preSelectedUuid` in `_doSelectProvider`)
- `src/services/service-manager.js` (line 469+: thread `options.preSelectedUuid` through `getApiServiceWithFallback()` → `selectProviderWithFallback()`)
- `src/core/plugin-manager.js` (add executeProviderPreHooks, executeProviderPostHooks)

**Success criteria:**
- SQLite DB created at `configs/antigravity.db` on first run with all queries using prepared statements
- Pre-hook point fires for Antigravity requests after body parsing
- Post-hook point fires after generation with full response metadata
- Both `selectProvider()` and `selectProviderWithFallback()` honor pre-selected UUID via options param while still checking cooldown/risk
- No race condition: concurrent requests with different pre-selected UUIDs never cross-contaminate

#### Phase 2: Pipeline Orchestrator + Session ID (moved from Phase 6)

**Rationale:** The orchestrator establishes the hook registration framework that all subsequent phases depend on. Without it, Phase 3's QuotaSelectHook has nowhere to register. Build the skeleton first, fill in behavior later.

**Tasks:**
1. Create `src/middleware/antigravity/index.js` — pipeline orchestrator
   - Registers all pre/post hooks with plugin system
   - Defines execution order (priority numbers)
   - Provider-scoped: only activates for `gemini-antigravity` provider
   - Hooks can be registered incrementally as phases are built
2. Create `src/middleware/antigravity/session-id.js` — SessionIdHook
   - **Already implemented** in `antigravity-core.js:159` as `generateStableSessionID()` — SHA-256 of first user message, take first 8 bytes as BigInt, negate → signed int64 string (e.g., `-3750763034362895579`)
   - Confirmed from MITM capture: sessionId is stable across all requests in same session (same value for #0007, #0008, #0012, #0015)
   - **No new code needed** — existing implementation matches real Antigravity exactly
   - SessionIdHook just validates the existing behavior is preserved through the middleware pipeline

**Files:**
- `src/middleware/antigravity/index.js` (new)
- `src/middleware/antigravity/session-id.js` (new)

**Success criteria:**
- Pipeline orchestrator loads and registers hooks on startup
- Only runs for Antigravity provider requests
- Same conversation produces same sessionId across requests
- Hooks execute in defined priority order

#### Phase 3: Init Chain Fix

**Tasks:**
1. Fix `antigravity-core.js` init to match real chain:
   - Add `GET /v1internal/cascadeNuxes` call first (no body, no auth header needed — capture `0001`)
   - Add `fetchUserInfo()` call: `POST /v1internal:fetchUserInfo` with body `{}` (capture `0002`)
   - Split `loadCodeAssist` into two sequential calls (see exact params below)
   - Add `fetchAdminControls()` parallel with `fetchAvailableModels()`
2. Add init chain mutex to prevent concurrent initialization per account
3. Store quota data from `fetchAvailableModels` response into SQLite during init
4. **Pre-warm all accounts at startup** — staggered parallel (5 accounts at a time, 1s gap between batches) to avoid 5-second first-request latency

**Exact init chain params (RESOLVED from captures 0002–0006):**
```
1. GET  /v1internal/cascadeNuxes              → no body, no auth (capture 0001)
2. POST /v1internal:fetchUserInfo             → body: {} (capture 0002)
3. POST /v1internal:loadCodeAssist            → body: {"metadata":{"ideType":"ANTIGRAVITY"}} (capture 0003)
4. POST /v1internal:loadCodeAssist            → body: {"cloudaicompanionProject":"<project>","metadata":{"ideType":"ANTIGRAVITY"}} (capture 0004)
5. POST /v1internal:fetchAvailableModels      → body: {"project":"<project>"} (capture 0005)  ┐ parallel
6. POST /v1internal:fetchAdminControls        → body: {"project":"<project>"} (capture 0006)  ┘ parallel
```

Note: Steps 5+6 fire in parallel (88ms apart in capture). `<project>` is the `cloudaicompanionProject` returned from step 3 or step 2's response.

All requests use header `user-agent: antigravity/{version} {os}/{arch}` and `content-type: application/json`.

**Files touched:**
- `src/providers/gemini/antigravity-core.js` (lines 928-1000: `discoverProjectAndModels()` rewrite)

**Success criteria:**
- Init chain matches: cascadeNuxes → fetchUserInfo → loadCodeAssist(chat) → loadCodeAssist(agents) → fetchAvailableModels || fetchAdminControls
- Concurrent requests for same account don't double-init (mutex)
- Quota data persisted in SQLite after init
- All accounts pre-warmed at startup (no 5s latency on first request)

#### Phase 4: Quota-Aware Selection

**Tasks:**
1. Create `src/middleware/antigravity/quota-select.js` — QuotaSelectHook
   - Reads SQLite for all accounts' `remainingFraction` for requested model
   - Picks account with highest fraction
   - Applies local decrement heuristic (subtract estimated `1/weeklyQuota` per request from cached value)
   - Returns `preSelectedUuid` via request-scoped options (NOT shared config — see A1)
2. Create quota refresh scheduler:
   - Lazy mode: refresh every 30 minutes
   - Near-resetTime mode: refresh every 5 minutes when within 2 hours of `resetTime`
   - Reactive: immediate refresh on 429 response
   - **Staggered execution**: process 5 accounts at a time with 1-second gap between batches (not all 60 at once). Prevents API rate limiting and reduces burst of SQLite writes.
3. Cold start fallback: if no SQLite data, fall back to existing LRU selection and trigger async quota fetch for all accounts

**Files:**
- `src/middleware/antigravity/quota-select.js` (new)
- `src/middleware/antigravity/quota-scheduler.js` (new — background refresh timer)

**Success criteria:**
- Requests route to account with most remaining quota for the requested model
- Local decrement prevents thundering herd on single account between refreshes
- Cold start works without SQLite data (graceful fallback)
- 429 triggers immediate quota refresh
- Quota refresh is staggered (never more than 5 concurrent fetchAvailableModels calls)

#### Phase 5: Device Fingerprinting

**Tasks:**
1. Create `src/middleware/antigravity/fingerprint.js` — FingerprintManager
   - On first use per account: generate fingerprint from template, store in SQLite
   - Template based on captured structure (exact from capture `0010` metadata):
     ```json
     {
       "deviceFingerprint": "<uuid-v4>",
       "extensionName": "antigravity",
       "extensionPath": "<os-specific-path>",
       "hardware": "<amd64|arm64>",
       "ideName": "antigravity",
       "ideVersion": "1.19.6",
       "locale": "en",
       "os": "<windows|darwin|linux>",
       "regionCode": "US",
       "userTierId": "free-tier"
     }
     ```
   - Captured example: `extensionPath` = `c:\Users\AbdallahSoubra\AppData\Local\Programs\Antigravity\resources\app\extensions\antigravity`
   - Values weighted toward common distributions (80% windows/amd64, 15% darwin/arm64, 5% linux/amd64)
   - `extensionPath` matches OS:
     - Windows: `c:\Users\<name>\AppData\Local\Programs\Antigravity\resources\app\extensions\antigravity`
     - macOS: `/Users/<name>/.vscode/extensions/antigravity`
     - Linux: `/home/<name>/.vscode/extensions/antigravity`
   - `locale` = `"en"` (not `"en-US"` — capture confirms short form)
   - `regionCode` = `"US"` (constant in captured data)
2. Fingerprint is static per account (no evolution in v1)

**Files:**
- `src/middleware/antigravity/fingerprint.js` (new)

**Success criteria:**
- Each account gets unique, stable fingerprint
- Fingerprints are realistic (correct OS paths, common resolutions)
- Fingerprints persist across restarts via SQLite

#### Phase 6: Telemetry Post-Hooks

**Tasks:**
1. Create `src/middleware/antigravity/metrics-post.js` — MetricsHook
   - Builds `recordCodeAssistMetrics` payload from **Appendix A.9** exact template
   - Fills: project, requestId (new UUID), traceId (random 8-byte hex), timestamp (ISO-8601 nanoseconds), streamingLatency (nanosecond-precision seconds strings), isAgentic, initiationMethod, trajectoryId
   - `metadata.platform` must match fingerprint: `"WINDOWS_AMD64"` / `"DARWIN_ARM64"` / `"LINUX_AMD64"`
   - Fires `setTimeout(fn, uniform(10, 200)).unref()` after generation completes
   - Fire-and-forget: errors logged at debug, no retry
2. Create `src/middleware/antigravity/trajectory-post.js` — TrajectoryHook
   - Builds `recordTrajectoryAnalytics` payload from **Appendix A.10** exact template
   - Must include ALL required fields: `trajectoryType`, `source`, `trajectoryId`, `cascadeId`, `executorMetadatas`, `generatorMetadata` (with `chatModel`, `plannerConfig`, `stepIndices`), `metadata` (inner), `steps`
   - `chatModel.model` = `"MODEL_PLACEHOLDER_M26"` (NOT the actual model name)
   - `chatModel.responseModel` = actual model (e.g., `"claude-opus-4-6-thinking"`)
   - `chatModel.usage.apiProvider` = `"API_PROVIDER_ANTHROPIC_VERTEX"`
   - `chatModel.usage.responseId` format: `"req_vrtx_<id>"`
   - `chatModel.promptSections`: 12 sections with correct titles (see A.10)
   - `chatModel.tools`: 20 tool declarations with correct names (see A.10)
   - `chatModel.completionConfig`: exact structure from A.10
   - `plannerConfig`: static template captured from A.10 (~3KB, version-specific)
   - Fires `setTimeout(fn, uniform(50, 300)).unref()` after generation completes
   - **Content redaction by default** (see A7): user messages replaced with `[REDACTED: N tokens]` stubs. Full mode opt-in via `telemetryMode: "full"` in provider_pools.json.
   - **Content filtering**: scan for API key patterns (`sk-*`, `AKIA*`, `ghp_*`), private URLs, emails — mask even in full mode
   - **Concurrency limiter**: max 10 trajectory payloads in flight (see A6). Skip telemetry if limit exceeded.
3. Both send telemetry even on failed generations (with error status in payload)
4. Both use `.unref()` on setTimeout to not block graceful shutdown

**Files:**
- `src/middleware/antigravity/metrics-post.js` (new)
- `src/middleware/antigravity/trajectory-post.js` (new)
- `tools/security-poc/payloads/recordCodeAssistMetrics.json` (reference template)
- `tools/security-poc/payloads/recordTrajectoryAnalytics.json` (reference template)

**Success criteria:**
- Both telemetry calls fire after every Antigravity generation
- Payloads match real Antigravity structure (validated against captured data)
- Telemetry does NOT block client response or graceful shutdown
- Failed telemetry does not crash or log at warn/error level
- Never more than 10 trajectory payloads in flight simultaneously
- User content redacted by default; API keys/secrets masked in all modes

(Session ID + Pipeline Orchestrator moved to Phase 2)

#### Phase 7: Per-Account TLS Session Isolation (PR #310 by @YchampionOP)

**Problem:** All Antigravity accounts share a single module-level `https.Agent` (`antigravity-core.js:28-33`). TLS session tickets, connection pools, and socket reuse are shared across accounts. Google could correlate accounts by observing TLS session resumption patterns from the same connection pool on the same IP.

**Approach:** Proxy-per-account — every Antigravity account MUST have its own proxy (`PROXY_URL` in `provider_pools.json`). This gives complete isolation: different IPs, different TLS sessions, different TCP connections. Velocity limiting on top prevents rapid cycling that could trigger behavioral detection. (see brainstorm: docs/brainstorms/2026-03-06-tls-isolation-tiered-ls-launch-brainstorm.md)

**Tasks:**
1. Add proxy enforcement in `provider-pool-manager.js` `_doSelectProvider()` — reject `gemini-antigravity` nodes without `PROXY_URL` with clear error: `"Antigravity accounts require PROXY_URL for TLS isolation"`. Other provider types unaffected.
2. Add velocity limiter in `provider-pool-manager.js`:
   - **Account switching rate**: Track `lastUsedTimestamp` per `(host, accountUuid)` pair. Enforce min 30s gap between using different accounts on the same target host. Configurable via `TLS_MIN_SWITCH_GAP_MS` in config.json (default: 30000).
   - **New TLS session rate**: Track new TLS handshake count per sliding 60s window across all accounts. Cap at 5/minute. Configurable via `TLS_MAX_NEW_SESSIONS_PER_MIN` (default: 5).
   - Both limits trigger a brief hold (wait for gap to elapse) rather than rejection.
3. Add agent lifecycle management:
   - Per-account proxy agent is already created by `proxy-utils.js` on each adapter init (no caching/sharing issue).
   - Add `destroyAgent(accountUuid)` to clean up proxy agent when account enters cooldown/quarantine/removal.
   - Hook into `markProviderUnhealthyImmediately()` and risk policy `quarantine` transition.
4. Update `configs/provider_pools.json.example` to show `PROXY_URL` as required for Antigravity nodes.
5. Add validation on pool load: warn at startup if any Antigravity nodes lack `PROXY_URL`.

**Files:**
- `src/providers/provider-pool-manager.js` (edit — proxy enforcement filter + velocity limiter)
- `src/providers/adapter.js` (edit — agent cleanup on destroy)
- `configs/provider_pools.json.example` (edit — add PROXY_URL to Antigravity example)
- `configs/config.json.example` (edit — add TLS_MIN_SWITCH_GAP_MS, TLS_MAX_NEW_SESSIONS_PER_MIN)

**Success criteria:**
- Antigravity accounts without `PROXY_URL` are never selected; clear error logged
- Account switching on same host is rate-limited (min 30s gap by default)
- New TLS sessions capped at 5/minute by default
- Proxy agent destroyed when account enters cooldown/quarantine
- Startup validation warns about missing proxy configs
- No impact on non-Antigravity providers

#### Phase 8: Tiered LS Launch Strategies (PR #323 by @YchampionOP)

**Problem:** `master.js` uses simple `child_process.fork()` with basic exponential backoff. This breaks or underperforms in Docker (PID 1 signal handling), systemd (no notify socket), WSL (interop quirks), and lacks process namespace isolation on Linux.

**Approach:** Hybrid auto-detect + config override. Auto-probe launch strategies in order until one succeeds. Config override available for advanced users. Active + passive health checks. (see brainstorm: docs/brainstorms/2026-03-06-tls-isolation-tiered-ls-launch-brainstorm.md)

**Tasks:**
1. Create strategy interface and implementations in `src/core/launchers/`:
   - `launcher-base.js` — base class with `isAvailable()`, `launch()`, `shutdown()`, `name`
   - `namespace-launcher.js` — Linux namespaces (PID/mount via `unshare`). Detect: probe `unshare --user true` at startup. PID namespace for process isolation, mount namespace for `/tmp` isolation. Network namespace disabled by default (adds latency). Falls through if `unshare` fails at runtime (e.g., Docker restricts it).
   - `systemd-notify-launcher.js` — Detect: `$NOTIFY_SOCKET` env var present. Sends `READY=1` after worker is up, `STOPPING=1` on shutdown, `WATCHDOG=1` at half the `WatchdogSec` interval. Uses `sd-notify` npm package (official, under systemd org) or pure-JS Unix socket fallback.
   - `docker-aware-launcher.js` — Detect: `/.dockerenv` exists or `/proc/1/cgroup` contains docker/containerd. Handles PID 1 signal forwarding (explicit `SIGTERM`/`SIGINT` handlers), zombie reaping via periodic `waitpid(-1, WNOHANG)`. Recommends tini/dumb-init in logs if running as PID 1 without init.
   - `simple-fork-launcher.js` — Always available. Current `child_process.fork()` logic extracted from `master.js`. The universal fallback.
2. Create `src/core/launcher-supervisor.js` — the probe chain orchestrator:
   - Default probe order: `namespace → systemd → docker → simple-fork`
   - Config override: `"launchStrategy": "namespace"` in config.json skips probing
   - Logs which strategy was selected and why
   - Re-probes on restart (environment may change, e.g., container migration)
3. Add active + passive health checks:
   - **Active**: IPC heartbeat ping every 30s. Worker responds with `{ type: 'heartbeat_pong', memory: process.memoryUsage(), cpu: process.cpuUsage(), requestCount }`. 3 missed heartbeats = restart. Configurable: `HEARTBEAT_INTERVAL_MS` (default: 30000), `HEARTBEAT_MAX_MISSES` (default: 3).
   - **Passive**: Existing crash detection via `exit` event. Add unresponsive detection: if no IPC message received within `HEARTBEAT_INTERVAL_MS * HEARTBEAT_MAX_MISSES`, restart.
   - Health data exposed via existing `/master/health` endpoint (add memory, cpu, uptime, strategy name, heartbeat stats).
4. Refactor `master.js` to use `launcher-supervisor.js` instead of inline fork logic. Keep management HTTP server and signal handling in master.js.
5. Add config keys to `config.json.example`:
   - `"launchStrategy": "auto"` (auto|namespace|systemd|docker|fork)
   - `"heartbeatIntervalMs": 30000`
   - `"heartbeatMaxMisses": 3`

**Files:**
- `src/core/launchers/launcher-base.js` (new)
- `src/core/launchers/namespace-launcher.js` (new)
- `src/core/launchers/systemd-notify-launcher.js` (new)
- `src/core/launchers/docker-aware-launcher.js` (new)
- `src/core/launchers/simple-fork-launcher.js` (new — extracted from master.js)
- `src/core/launcher-supervisor.js` (new — probe chain + health monitor)
- `src/core/master.js` (edit — use launcher-supervisor instead of inline fork)
- `src/services/api-server.js` (edit — respond to heartbeat_ping IPC messages)
- `configs/config.json.example` (edit — add launch strategy + heartbeat config)

**Success criteria:**
- Auto-detect selects correct strategy for Docker, systemd, WSL, bare metal environments
- Config override bypasses auto-detect when set
- Namespace launcher provides PID + mount isolation on supported Linux systems
- Graceful fallback: if namespace/systemd/docker launcher fails, falls to simple fork
- Active heartbeat detects hung workers within 90s (3 x 30s)
- Passive detection catches crashes immediately
- `/master/health` reports strategy name, heartbeat stats, worker memory/CPU
- Windows/macOS always use simple-fork strategy (no namespace/systemd detection)
- Existing restart behavior (exponential backoff, max 10 attempts) preserved

## Alternative Approaches Considered

1. **Deep Rewrite** — Rewrite antigravity-core.js to bake in all new behavior. Rejected: too risky for existing users, hard to review, couples everything tightly. (see brainstorm)

2. **Layered Integration** — Separate service modules plugged into adapter/pool architecture. Rejected: more indirection than needed, middleware pattern is cleaner for "do X before, do Y after" semantics. (see brainstorm)

## System-Wide Impact

### Interaction Graph

```
Client Request
  → request-handler.js (body parsing)
  → plugin-manager.js (executeProviderPreHooks)
    → quota-select.js (reads SQLite quota_state → returns preSelectedUuid via options)
    → chain-setup (may call cascadeNuxes, fetchUserInfo, loadCodeAssist×2, fetchAvailableModels, fetchAdminControls)
    → session-id.js (hashes prompt content)
  → provider-pool-manager.js (selectProviderWithFallback — honors options.preSelectedUuid)
    → Phase 7: proxy enforcement filter (reject Antigravity nodes without PROXY_URL)
    → Phase 7: velocity limiter (enforce switch gap + session rate cap)
  → antigravity-core.js (streamGenerateContent → Google API via per-account proxy agent)
  → common.js (onContentGenerated hook)
    → plugin-manager.js (executeProviderPostHooks)
      → metrics-post.js (setTimeout.unref → recordCodeAssistMetrics → Google API)
      → trajectory-post.js (setTimeout.unref → recordTrajectoryAnalytics [redacted] → Google API)
        → fingerprint.js (reads SQLite account_fingerprints)
        → concurrency limiter (max 10 in-flight, skip if exceeded)
      → SQLite telemetry_log write
```

### Error Propagation

| Error | Source | Handling |
|-------|--------|----------|
| SQLite init failure | `src/db/sqlite.js` | Log warning, fall back to in-memory cache. All middleware degrades gracefully. |
| SQLite write failure | quota/fingerprint stores | Log debug, continue. Data is non-critical cache. |
| Init chain partial failure | chain-setup hook | Retry failed step once. If still fails, mark account unhealthy, fall back to next account. |
| fetchAvailableModels 429 | quota-scheduler | Back off, try next account. Set `cooldownUntil` on pool node. |
| Telemetry 401 (token expired) | metrics/trajectory hooks | Log debug, drop. Do NOT refresh token for telemetry — it's fire-and-forget. |
| Telemetry network error | metrics/trajectory hooks | Log debug, drop. No retry. |
| selectProvider finds pre-selected UUID is cooling down | provider-pool-manager | Ignore pre-selection, fall back to normal LRU scoring. |
| Telemetry concurrency limit exceeded | trajectory-post.js | Skip telemetry for this request. Log debug. |
| Graceful shutdown with pending telemetry timers | metrics/trajectory hooks | `.unref()` on all timers — process exits without waiting. Some telemetry dropped. |

### State Lifecycle Risks

- **Partial init:** Mutex per account prevents concurrent init. If init fails mid-way, `isInitialized` stays false, next request retries full chain.
- **Stale quota data:** Local decrement heuristic prevents over-routing to single account. Background refresh keeps data fresh.
- **SQLite corruption:** On startup, validate schema. If corrupt, delete and recreate (data is a cache, not source of truth).
- **telemetry_log unbounded growth:** 7-day retention. Daily cleanup deletes rows older than 7 days.

### API Surface Parity

| Interface | Needs Update | Reason |
|-----------|-------------|--------|
| `plugin-manager.js` | Yes | Add `executeProviderPreHooks()`, `executeProviderPostHooks()` |
| `common.js` handleContentGenerationRequest | Yes | Add pre-hook call, extend post-hook data |
| `provider-pool-manager.js` selectProvider | Yes | Honor `options.preSelectedUuid` in both `selectProvider()` and `_doSelectProvider()` |
| `service-manager.js` getApiServiceWithFallback | Yes | Thread `options.preSelectedUuid` through to `selectProviderWithFallback()` |
| `antigravity-core.js` initialize | Yes | Fix init chain to match real + pre-warm at startup |
| `adapter.js` AntigravityApiServiceAdapter | Yes | Agent cleanup on destroy (Phase 7) |
| `request-handler.js` | No | Pre-hooks go in common.js, not here |
| `master.js` | Yes | Refactor to use launcher-supervisor (Phase 8) |
| `api-server.js` worker | Yes | Respond to heartbeat_ping IPC messages (Phase 8) |

## Acceptance Criteria

### Functional Requirements

- [ ] Init chain matches real: cascadeNuxes → fetchUserInfo → loadCodeAssist(chat) → loadCodeAssist(agents) → fetchAvailableModels || fetchAdminControls
- [ ] `recordCodeAssistMetrics` fires after every generation with correct payload structure
- [ ] `recordTrajectoryAnalytics` fires after every generation with full conversation context + fingerprint
- [ ] Per-account device fingerprints are unique, stable, and realistic
- [ ] Quota-aware account selection picks highest `remainingFraction` for requested model
- [ ] Stable sessionId produced from hash of system prompt + first user message
- [ ] Telemetry does NOT block client response
- [ ] Graceful degradation if SQLite unavailable (falls back to in-memory + existing LRU)
- [ ] All Antigravity accounts have `PROXY_URL` configured (Phase 7 enforcement)
- [ ] Account switching on same host rate-limited (min 30s gap by default)
- [ ] New TLS sessions capped at 5/minute across all accounts
- [ ] Proxy agent destroyed on account cooldown/quarantine
- [ ] Worker process launched via best available strategy (namespace > systemd > docker > fork)
- [ ] Active heartbeat detects hung workers within 90s (3 x 30s default)
- [ ] `/master/health` reports launch strategy, heartbeat stats, worker resource usage

### Non-Functional Requirements

- [ ] Telemetry adds < 5ms latency to client response (fire-and-forget via setTimeout)
- [ ] SQLite operations are synchronous but < 1ms per read/write (better-sqlite3 with WAL)
- [ ] No new npm vulnerabilities introduced by better-sqlite3
- [ ] Works on Windows (native), WSL2, Linux, macOS
- [ ] Velocity limiter adds < 1ms overhead to provider selection (in-memory tracking only)
- [ ] Heartbeat IPC overhead negligible (< 1KB per ping, 30s interval)

### Quality Gates

- [ ] All existing tests pass (no regressions)
- [ ] New unit tests for each middleware hook
- [ ] Integration test: full request lifecycle with telemetry verification
- [ ] Payload structure validated against captured MITM data
- [ ] Test: Antigravity node without PROXY_URL is rejected by pool manager
- [ ] Test: velocity limiter enforces switching gap and session rate cap
- [ ] Test: launcher probe chain falls through correctly on unsupported environments
- [ ] Test: heartbeat ping/pong cycle triggers restart on 3 missed beats

## Dependencies & Prerequisites

- `better-sqlite3` npm package (native module — requires build tools on target platform)
- MITM capture data at `mitm-capture/logs/` for payload templates and parameter extraction
- Existing security-poc payloads at `tools/security-poc/payloads/` as templates

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `better-sqlite3` native module fails to compile on target | Medium | High | Fallback to `sql.js` (WASM, no native). Or graceful degradation to in-memory. |
| Telemetry payloads diverge from real Antigravity after updates | High | Medium | Periodically re-capture with MITM proxy to update templates. |
| Quota local decrement heuristic is inaccurate | Medium | Low | Tune based on observed behavior. Over-counting is better than under-counting. |
| Double selection conflict between QuotaSelectHook and selectProvider | Low | High | Pre-selection passed via request-scoped `options` param (not shared config). Both `selectProvider` and `selectProviderWithFallback` honor it. Tests cover concurrent requests. |
| Init chain mutex causes deadlock under high concurrency | Low | High | Mutex with 30s timeout. On timeout, skip init and let request proceed (will lazy-init on next attempt). |
| Trajectory payload leaks user conversation content to Google | High | Critical | Default to redacted mode. Full mode opt-in per account. API key patterns always masked. |
| Telemetry memory blow-up under burst traffic | Medium | High | Concurrency limiter: max 10 in-flight trajectory payloads. Skip if limit exceeded. |
| Race condition on `_preSelectedUuid` under concurrent requests | High | High | Eliminated: pre-selection flows through request-scoped `options`, never mutates shared config. |
| 5-second first-request latency per account | High | Medium | Pre-warm all accounts at startup (staggered: 5 at a time, 1s gaps). |
| Quota refresh storm (60 simultaneous fetchAvailableModels) | Medium | Medium | Staggered refresh: 5 accounts/second, not all at once. |
| Proxy infrastructure cost for all Antigravity accounts | Medium | Medium | Required for TLS isolation. Users can use rotating residential proxies or SOCKS5 services. Clear error message explains requirement. |
| Velocity limiter causes request queuing under high load | Low | Medium | Limiter uses brief hold (wait for gap) not rejection. Under sustained load, accounts spread naturally. Tunable via config. |
| Namespace launcher fails silently in restrictive containers | Medium | Low | Probe catches failure at launch time, falls to next strategy. Docker-aware launcher handles container-specific issues. |
| systemd sd-notify native addon fails to compile | Low | Medium | Fallback to pure-JS Unix socket implementation (just a datagram send). |
| Heartbeat false positive restart during GC pause | Low | Medium | 90s tolerance (3 x 30s) is generous. GC pauses rarely exceed 1-2s. Worker can send heartbeat from separate setInterval. |

## File Structure

```
src/
  db/
    sqlite.js                       → connection manager, schema init, graceful degradation
    quota-store.js                  → quota_state CRUD
    fingerprint-store.js            → account_fingerprints CRUD
  middleware/
    antigravity/
      index.js                     → pipeline orchestrator, hook registration
      chain-setup.js               → lazy init chain per account (pre-hook)
      quota-select.js              → pick best account by remainingFraction (pre-hook)
      quota-scheduler.js           → background refresh timer
      session-id.js                → stable sessionId generation (pre-hook)
      fingerprint.js               → per-account fingerprint generation + storage
      metrics-post.js              → recordCodeAssistMetrics (post-hook)
      trajectory-post.js           → recordTrajectoryAnalytics (post-hook)
  core/
    launchers/
      launcher-base.js             → base class: isAvailable(), launch(), shutdown()
      namespace-launcher.js        → Linux PID/mount namespace via unshare
      systemd-notify-launcher.js   → systemd notify socket integration
      docker-aware-launcher.js     → PID 1 signal handling, zombie reaping
      simple-fork-launcher.js      → current fork() logic (universal fallback)
    launcher-supervisor.js         → probe chain orchestrator + health monitor
    master.js                      → (edit) use launcher-supervisor instead of inline fork
```

## SQLite Schema

```sql
-- configs/antigravity.db

CREATE TABLE IF NOT EXISTS account_fingerprints (
  account_email TEXT PRIMARY KEY,
  fingerprint_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quota_state (
  account_email TEXT NOT NULL,
  model_name TEXT NOT NULL,
  remaining_fraction REAL NOT NULL DEFAULT 1.0,
  local_estimate REAL NOT NULL DEFAULT 1.0,  -- decremented locally between refreshes
  reset_time TEXT,
  last_refreshed TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_email, model_name)
);

CREATE TABLE IF NOT EXISTS telemetry_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_email TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  metrics_sent INTEGER NOT NULL DEFAULT 0,
  trajectory_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Retention index for cleanup
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_log(created_at);
```

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-06-antigravity-deep-rewrite-brainstorm.md](docs/brainstorms/2026-03-06-antigravity-deep-rewrite-brainstorm.md) — Key decisions carried forward: middleware pipeline architecture, full telemetry mimicry, per-account fingerprints with captured templates, smart quota scheduling with SQLite, session ID replication via hashing.
- **TLS + LS brainstorm:** [docs/brainstorms/2026-03-06-tls-isolation-tiered-ls-launch-brainstorm.md](docs/brainstorms/2026-03-06-tls-isolation-tiered-ls-launch-brainstorm.md) — Key decisions: proxy-per-account mandatory for Antigravity, dual velocity limiting, hybrid auto-detect + config override for launch strategies, active+passive health checks. PRs: #310, #323 by @YchampionOP.

### Internal References

- Plugin system: `src/core/plugin-manager.js` (executeMiddleware at line 356, executeHook at line 447)
- Request handler: `src/handlers/request-handler.js` (middleware at line 181)
- Content generation: `src/utils/common.js` (handleContentGenerationRequest at line 1098, hook guard at line 1209)
- Provider selection: `src/providers/provider-pool-manager.js` (selectProvider at line 1396, scoring at line 537)
- Antigravity core: `src/providers/gemini/antigravity-core.js` (init at line 928, generate at line 1349, shared agent at line 22-33)
- AI monitor plugin: `src/plugins/ai-monitor/index.js` (reference hook implementation)
- Config: `configs/provider_pools.json` (quotaExhaustedUntil field already exists, PROXY_URL per-node)
- Proxy utils: `src/utils/proxy-utils.js` (per-node proxy agent creation, SOCKS5/HTTP CONNECT)
- Master supervisor: `src/core/master.js` (current fork + exponential backoff, management HTTP on port 3100)
- Service adapter: `src/providers/adapter.js` (per-account adapter cache keyed by provider+uuid at line 668)

### Captured Data References

- MITM proxy logs: `mitm-capture/logs/proxy.log` (full request chain timing)
- Trajectory payload: `mitm-capture/logs/0010-req-body.json` (123KB real payload)
- Metrics payload: `mitm-capture/logs/0009-req-body.json` (511B real payload)
- Fingerprint structure: `mitm-capture/logs/0010-req-body.json` → `metadata`
- Init chain params: `mitm-capture/logs/0002-0006-req-body.json` (full init sequence)
- streamGenerateContent: `mitm-capture/logs/0007-req-body.json` (71KB, agent request)

---

## Appendix A: Capture-Validated Request Templates

Every field below is extracted directly from MITM captures `0001`–`0012`. Fields marked `<dynamic>` must be filled at runtime.

### A.1 Common Headers (all requests)

```
Host: daily-cloudcode-pa.googleapis.com
User-Agent: antigravity/1.19.6 windows/amd64    ← format: antigravity/{ideVersion} {os}/{hardware}
Authorization: Bearer <oauth2-token>
Content-Type: application/json
Accept-Encoding: gzip
```

Note: `streamGenerateContent` uses `Transfer-Encoding: chunked` instead of `Content-Length`.

### A.2 Init Chain — cascadeNuxes (capture 0001)

```
GET /v1internal/cascadeNuxes HTTP/2
```
No body. No Authorization header needed. Response: HTML/nux content (not important for mimicry — just needs to fire).

### A.3 Init Chain — fetchUserInfo (capture 0002)

```
POST /v1internal:fetchUserInfo
Body: {}
```

### A.4 Init Chain — loadCodeAssist #1 "chat" (capture 0003)

```
POST /v1internal:loadCodeAssist
Body: {"metadata":{"ideType":"ANTIGRAVITY"}}
```

### A.5 Init Chain — loadCodeAssist #2 "agents" (capture 0004)

```
POST /v1internal:loadCodeAssist
Body: {"cloudaicompanionProject":"<project-id>","metadata":{"ideType":"ANTIGRAVITY"}}
```
`<project-id>` = the `cloudaicompanionProject` from fetchUserInfo or loadCodeAssist #1 response (e.g., `"snappy-decker-84xv4"`).

### A.6 Init Chain — fetchAvailableModels (capture 0005)

```
POST /v1internal:fetchAvailableModels
Body: {"project":"<project-id>"}
```

### A.7 Init Chain — fetchAdminControls (capture 0006)

```
POST /v1internal:fetchAdminControls
Body: {"project":"<project-id>"}
```
Fires in parallel with fetchAvailableModels (88ms apart in capture).

### A.8 streamGenerateContent — Full Structure (capture 0007)

**URL:** `POST /v1internal:streamGenerateContent?alt=sse`

**Top-level body keys** (6 keys total):
```json
{
  "project": "<project-id>",
  "requestId": "agent/<timestamp-ms>/<trajectory-uuid>/<step-index>",
  "request": { ... },
  "model": "<model-name>",
  "userAgent": "antigravity",
  "requestType": "agent"
}
```

**Key fields explained:**
- `project`: Same project ID from init chain (e.g., `"snappy-decker-84xv4"`)
- `requestId` format: `"agent/{Date.now()}/{trajectoryId}/{stepIndex}"` — e.g., `"agent/1772754457436/179c837c-8253-4105-902c-d37299fc89d0/4"`
- `model`: The actual backend model name (e.g., `"claude-opus-4-6-thinking"`) — NOT `MODEL_PLACEHOLDER_M26`
- `userAgent`: Always `"antigravity"` (string, not the HTTP header)
- `requestType`: `"agent"` for generation, `"checkpoint"` for summary/title requests

**`request` object keys** (6 keys):
```json
{
  "contents": [ ... ],
  "systemInstruction": { "role": "user", "parts": [{"text": "<system-prompt>"}] },
  "tools": [{ "functionDeclarations": [ ... ] }],
  "toolConfig": { "functionCallingConfig": { "mode": "VALIDATED" } },
  "generationConfig": { ... },
  "sessionId": "<negative-int64-string>"
}
```

**`generationConfig` (exact from capture):**
```json
{
  "temperature": 0.4,
  "topP": 1,
  "topK": 50,
  "candidateCount": 1,
  "maxOutputTokens": 16384,
  "stopSequences": ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"],
  "thinkingConfig": {
    "includeThoughts": true,
    "thinkingBudget": 1024
  }
}
```

**`toolConfig`:**
```json
{
  "functionCallingConfig": {
    "mode": "VALIDATED"
  }
}
```

**`sessionId`:** Negative int64 string (e.g., `"-3750763034362895579"`). Already implemented correctly in `antigravity-core.js:159`.

### A.9 recordCodeAssistMetrics — Full Template (capture 0009)

**URL:** `POST /v1internal:recordCodeAssistMetrics`

```json
{
  "project": "<project-id>",
  "requestId": "<uuid-v4>",
  "metadata": {
    "ideType": "ANTIGRAVITY",
    "ideVersion": "1.19.6",
    "platform": "WINDOWS_AMD64"
  },
  "metrics": [
    {
      "timestamp": "<ISO-8601-with-nanoseconds>",
      "conversationOffered": {
        "status": "ACTION_STATUS_NO_ERROR",
        "traceId": "<16-hex-chars>",
        "streamingLatency": {
          "firstMessageLatency": "<seconds>.<nanoseconds>s",
          "totalLatency": "<seconds>.<nanoseconds>s"
        },
        "isAgentic": true,
        "initiationMethod": "AGENT",
        "trajectoryId": "<trajectory-uuid>"
      }
    }
  ]
}
```

**Key details:**
- `requestId`: A **new UUID** (different from `streamGenerateContent` requestId) — e.g., `"79b08672-3ada-4dcf-96d0-810721e00a4c"`
- `metadata.platform`: `"WINDOWS_AMD64"` / `"DARWIN_ARM64"` / `"LINUX_AMD64"` (matches fingerprint os/hardware)
- `traceId`: Random 8-byte hex string (16 chars) — e.g., `"177f77bdaf82ab35"`
- `streamingLatency` format: `"{seconds}.{nanoseconds}s"` — e.g., `"2.733911300s"`, `"3.844579200s"`
- `isAgentic` and `initiationMethod` and `trajectoryId`: **Only present for `requestType: "agent"`** requests. Omitted for checkpoint/summary requests (confirmed by comparing 0009 vs 0011).
- `timestamp`: ISO-8601 with nanosecond precision — e.g., `"2026-03-05T23:47:41.272557Z"`

### A.10 recordTrajectoryAnalytics — Full Template (capture 0010)

**URL:** `POST /v1internal:recordTrajectoryAnalytics`

**Top-level structure** (2 keys):
```json
{
  "trajectory": { ... },
  "metadata": {
    "deviceFingerprint": "<uuid-v4>",
    "extensionName": "antigravity",
    "extensionPath": "c:\\Users\\<name>\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity",
    "hardware": "amd64",
    "ideName": "antigravity",
    "ideVersion": "1.19.6",
    "locale": "en",
    "os": "windows",
    "regionCode": "US",
    "userTierId": "free-tier"
  }
}
```

**`trajectory` object keys** (8 keys):
```json
{
  "cascadeId": "<conversation-uuid>",
  "executorMetadatas": [
    {
      "executionId": "<uuid>",
      "lastStepIdx": 5,
      "numGeneratorInvocations": 1,
      "terminationReason": "EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL"
    }
  ],
  "generatorMetadata": [ { "chatModel": { ... }, "executionId": "<uuid>", "plannerConfig": { ... }, "stepIndices": [4] } ],
  "metadata": {
    "createdAt": "<ISO-8601>",
    "initializationStateId": "<uuid>"
  },
  "source": "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
  "steps": [ ... ],
  "trajectoryId": "<trajectory-uuid>",
  "trajectoryType": "CORTEX_TRAJECTORY_TYPE_CASCADE"
}
```

**`trajectory.generatorMetadata[0].chatModel` keys** (15 keys):
```
chatStartMetadata, completionConfig, lastCacheIndex, messageMetadata,
messagePrompts, model, promptSections, responseModel, retryInfos,
streamingDuration, systemPrompt, timeToFirstToken, toolChoice, tools, usage
```

**Critical `chatModel` fields:**
- `model`: `"MODEL_PLACEHOLDER_M26"` (internal name, NOT the actual model)
- `responseModel`: `"claude-opus-4-6-thinking"` (actual model used)
- `toolChoice`: `{"optionName": "auto"}`
- `streamingDuration`: `"1.200789200s"` (nanosecond string)
- `timeToFirstToken`: `"2.647838400s"` (nanosecond string)

**`chatModel.usage`:**
```json
{
  "apiProvider": "API_PROVIDER_ANTHROPIC_VERTEX",
  "cacheReadTokens": "15942",
  "inputTokens": "1991",
  "model": "MODEL_PLACEHOLDER_M26",
  "outputTokens": "56",
  "responseHeader": { "sessionID": "-3750763034362895579" },
  "responseId": "req_vrtx_011CYkpt6XmjHWhztJBibKzA",
  "responseOutputTokens": "56"
}
```

**`chatModel.completionConfig`:**
```json
{
  "fimEotProbThreshold": 1,
  "firstTemperature": 0.4,
  "maxNewlines": "200",
  "maxTokens": "16384",
  "numCompletions": "1",
  "stopPatterns": ["<|user|>","<|bot|>","<|context_request|>","<|endoftext|>","<|end_of_turn|>"],
  "temperature": 0.4,
  "topK": "50",
  "topP": 1
}
```

**`chatModel.promptSections`** (12 sections, titles):
```
identity, user_information, tool_calling, web_application_development,
ephemeral_message, artifacts, user_rules, workflows, skills,
knowledge_discovery, persistent_context, communication_style
```
Each section has `title`, optionally `content` (static template) and/or `dynamicContent` (runtime), and `metadata.sourceType`/`metadata.templateKey`.

**`chatModel.tools`** (20 tool names):
```
browser_subagent, command_status, find_by_name, generate_image, grep_search,
list_dir, list_resources, multi_replace_file_content, read_resource,
read_terminal, read_url_content, replace_file_content, run_command,
search_web, send_command_input, view_code_item, view_content_chunk,
view_file, view_file_outline, write_to_file
```

**`chatModel.retryInfos`:**
```json
[{
  "traceId": "<16-hex>",
  "usage": {
    "apiProvider": "API_PROVIDER_ANTHROPIC_VERTEX",
    "cacheReadTokens": "15942",
    "inputTokens": "1991",
    "model": "MODEL_PLACEHOLDER_M26",
    "outputTokens": "56",
    "responseHeader": { "sessionID": "<session-id>" },
    "responseId": "req_vrtx_<id>",
    "responseOutputTokens": "56"
  }
}]
```

**`chatModel.messagePrompts`** — array of message objects:
```json
{
  "prompt": "<message-text>",
  "source": "CHAT_MESSAGE_SOURCE_USER" | "CHAT_MESSAGE_SOURCE_SYSTEM",
  "numTokens": 106,
  "safeForCodeTelemetry": true,
  "stepIdx": 1,
  "thinking": "<thinking-text>",
  "thinkingSignature": "<base64-encoded-signature>",
  "promptCacheOptions": { "type": "CACHE_CONTROL_TYPE_EPHEMERAL" }
}
```
Not all fields present on every message. `thinking` and `thinkingSignature` only on model responses. `numTokens` and `safeForCodeTelemetry` vary.

**`trajectory.steps`** (array, 6 steps in capture):
```json
{
  "metadata": {
    "createdAt": "<ISO-8601>",
    "executionId": "<uuid>",
    "internalMetadata": {
      "statusTransitions": [{ "timestamp": "...", "updatedStatus": "CORTEX_STEP_STATUS_DONE" }]
    },
    "source": "CORTEX_STEP_SOURCE_USER_EXPLICIT",
    "sourceTrajectoryStepInfo": { "cascadeId": "...", "trajectoryId": "..." }
  },
  "status": "CORTEX_STEP_STATUS_DONE",
  "type": "CORTEX_STEP_TYPE_USER_INPUT",
  "userInput": {
    "activeUserState": {},
    "items": [{ "text": "<user-message>" }],
    "userConfig": { "conversationHistoryConfig": {...}, "plannerConfig": {...} },
    "userResponse": "<user-message>"
  }
}
```

**`trajectory.generatorMetadata[0].plannerConfig`** — massive config object (~3KB). Key fields:
- `modelName`: `"claude-opus-4-6-thinking"`
- `planModel`: `"MODEL_PLACEHOLDER_M26"`
- `maxOutputTokens`: 16384
- `truncationThresholdTokens`: 160000
- Contains full `toolConfig` with settings for browser, code editing, commands, search, etc.
- This is a **static template** per Antigravity version — capture once, reuse.

### A.11 Timing Analysis (from capture timestamps)

```
0001 cascadeNuxes       @ 23:45:59.775   (GET, no auth)
0002 fetchUserInfo      @ 23:47:30.976   (91s gap — user was idle)
0003 loadCodeAssist #1  @ 23:47:31.631   (+655ms)
0004 loadCodeAssist #2  @ 23:47:33.114   (+1483ms)
0005 fetchAvailableModels @ 23:47:34.864 (+1750ms)
0006 fetchAdminControls @ 23:47:34.952   (+88ms — parallel with 0005)
0007 streamGenerateContent (agent) @ 23:47:37.464 (+2512ms)
0008 streamGenerateContent (checkpoint) @ 23:47:41.287 (+3823ms — fires when 0007 completes)
0009 recordCodeAssistMetrics @ 23:47:41.299 (+12ms after 0008)
0010 recordTrajectoryAnalytics @ 23:47:41.382 (+83ms after 0009)
0011 recordCodeAssistMetrics @ 23:47:42.459 (+1077ms — for checkpoint 0008)
0012 streamGenerateContent (agent) @ 23:47:54.707 (next turn)
```

**Telemetry timing relative to generation completion:**
- Metrics fires ~12ms after generation stream completes
- Trajectory fires ~95ms after generation stream completes
- Both fire essentially immediately — the `setTimeout(uniform(10,200))` / `setTimeout(uniform(50,300))` in the plan add enough jitter

### A.12 Checkpoint/Summary Requests (capture 0008)

Real Antigravity fires a SECOND `streamGenerateContent` after each agent response — for conversation title/summary:
- `requestType`: `"checkpoint"` (not `"agent"`)
- `requestId`: `"checkpoint/<uuid>"` format
- `model`: `"gemini-2.5-flash-lite"` (lighter model)
- `thinkingConfig`: `{ "includeThoughts": false, "thinkingBudget": 0 }`
- `topK`: 40 (not 50)
- No `toolConfig`
- Separate `systemInstruction` (summarizer prompt, not the full agent prompt)
- Gets its own `recordCodeAssistMetrics` (0011) but NO `recordTrajectoryAnalytics`

**Implementation decision:** We do NOT need to implement checkpoint requests. They are an internal Antigravity feature for conversation management. Our proxy only handles generation requests from the client. However, for maximum stealth in the metrics/trajectory payloads, we should be aware these exist.

### A.13 Constants Reference

| Constant | Value | Source |
|----------|-------|--------|
| `trajectoryType` | `CORTEX_TRAJECTORY_TYPE_CASCADE` | capture 0010 |
| `source` | `CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT` | capture 0010 |
| `terminationReason` | `EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL` | capture 0010 |
| `apiProvider` | `API_PROVIDER_ANTHROPIC_VERTEX` | capture 0010 usage |
| `model` (internal) | `MODEL_PLACEHOLDER_M26` | capture 0010 chatModel |
| `metrics status` | `ACTION_STATUS_NO_ERROR` | capture 0009 |
| `initiationMethod` | `AGENT` | capture 0009 |
| `ideType` | `ANTIGRAVITY` | captures 0003, 0009 |
| `userAgent` (body) | `antigravity` | captures 0007, 0008 |
| `functionCallingConfig.mode` | `VALIDATED` | capture 0007 |
| `step type` | `CORTEX_STEP_TYPE_USER_INPUT` | capture 0010 |
| `step status` | `CORTEX_STEP_STATUS_DONE` | capture 0010 |
| `step source` | `CORTEX_STEP_SOURCE_USER_EXPLICIT` | capture 0010 |
| `toolChoice` | `{"optionName": "auto"}` | capture 0010 |
| `cacheControlType` | `CACHE_CONTROL_TYPE_EPHEMERAL` | capture 0010 |
