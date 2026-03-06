# Antigravity IPOasis Dynamic Sticky Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace manual Antigravity `PROXY_URL` config with runtime-generated IPOasis dynamic sticky residential proxies keyed by direct `IPOASIS_SUBUSER_ID`.

**Architecture:** Antigravity nodes will validate against IPOasis runtime-generation config, materialize one sticky proxy per node at startup or recovery, persist that lease in SQLite, and inject the concrete `PROXY_URL` into the live node config before the existing adapter and TLS-isolation path runs. The rest of the Antigravity pipeline stays unchanged once `PROXY_URL` has been materialized.

**Tech Stack:** Node.js ESM, axios, better-sqlite3, Jest

---

### Task 1: Add SQLite proxy lease storage

**Files:**
- Modify: `src/db/sqlite.js`
- Create: `src/db/proxy-lease-store.js`
- Test: `tests/antigravity-ipoasis.test.js`

**Step 1: Write the failing test**

Add tests in `tests/antigravity-ipoasis.test.js` that assert:
- proxy leases can be saved and read by `provider_uuid`
- the stored row preserves `subuser_id`, `proxy_url`, `protocol`, `session_type`, and `lease_state`

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: FAIL because `proxy-lease-store.js` and the SQLite schema do not exist yet.

**Step 3: Write minimal implementation**

- Extend `src/db/sqlite.js` with a `proxy_leases` table.
- Create `src/db/proxy-lease-store.js` with small helpers:
  - `saveProxyLease(lease)`
  - `getProxyLease(providerUuid)`
  - `deleteProxyLease(providerUuid)`
  - `markProxyLeaseError(providerUuid, message)`

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: PASS for the new storage test.

**Step 5: Commit**

```bash
git add src/db/sqlite.js src/db/proxy-lease-store.js tests/antigravity-ipoasis.test.js
git commit -m "feat: add sqlite-backed ipoasis proxy lease storage"
```

### Task 2: Add IPOasis dynamic sticky proxy generation service

**Files:**
- Create: `src/services/ipoasis-service.js`
- Modify: `package.json`
- Test: `tests/antigravity-ipoasis.test.js`

**Step 1: Write the failing test**

Add tests that assert:
- the service calls `GET /v1/proxy/dynamic/{subUserId}` with `count=1` and `sessionType=sticky`
- `host:port:user:pass` normalizes into `http://user:pass@host:port`
- multiple calls for the same `subUserId` can return different concrete leases without colliding

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: FAIL because the runtime generation service does not exist.

**Step 3: Write minimal implementation**

Create `src/services/ipoasis-service.js` that:
- validates `IPOASIS_API_KEY`
- accepts direct `IPOASIS_SUBUSER_ID`
- sends the documented IPOasis request with `sessionType=sticky`
- normalizes the returned proxy string into a URL
- persists the lease via `proxy-lease-store.js`

Use existing `axios` instead of adding a new HTTP client.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: PASS for generation and normalization behavior.

**Step 5: Commit**

```bash
git add src/services/ipoasis-service.js package.json tests/antigravity-ipoasis.test.js
git commit -m "feat: add ipoasis sticky proxy generation service"
```

### Task 3: Replace Antigravity startup validation and lease hydration

**Files:**
- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/services/service-manager.js`
- Test: `tests/antigravity-phase7.test.js`
- Test: `tests/antigravity-phase3-startup.test.js`
- Test: `tests/antigravity-ipoasis.test.js`

**Step 1: Write the failing test**

Add tests that assert:
- enabled Antigravity nodes fail startup when they still define manual `PROXY_URL`
- enabled Antigravity nodes fail startup when `IPOASIS_SUBUSER_ID` is missing
- disabled Antigravity nodes remain exempt
- startup hydrates a persisted lease into live node config
- startup generates a fresh lease when no persisted lease exists

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-phase7.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-ipoasis.test.js --runInBand`

Expected: FAIL because validation still expects static `PROXY_URL`.

**Step 3: Write minimal implementation**

- Replace `_validateAntigravityProxyConfiguration()` with validation for IPOasis config:
  - require `IPOASIS_SUBUSER_ID`
  - reject manual `PROXY_URL`
- Add a startup materialization path in `service-manager.js` before adapter prewarm so live Antigravity nodes receive a runtime `PROXY_URL` from SQLite or IPOasis generation.
- Keep `_hasAntigravityTlsProxy()` for operational selectability after materialization.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-phase7.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-ipoasis.test.js --runInBand`

Expected: PASS for validation and hydration behavior.

**Step 5: Commit**

```bash
git add src/providers/provider-pool-manager.js src/services/service-manager.js tests/antigravity-phase7.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-ipoasis.test.js
git commit -m "feat: materialize antigravity ipoasis proxies at startup"
```

### Task 4: Regenerate leases on refresh and failure recovery

**Files:**
- Modify: `src/providers/provider-pool-manager.js`
- Modify: `src/services/service-manager.js`
- Modify: `tests/antigravity-phase7.test.js`
- Modify: `tests/antigravity-flow-tracer.test.js`
- Modify: `tests/antigravity-ipoasis.test.js`

**Step 1: Write the failing test**

Add tests that assert:
- a node with an errored or missing lease can regenerate one during refresh/recovery
- successful regeneration restores node readiness immediately
- two nodes sharing the same `IPOASIS_SUBUSER_ID` still hold distinct proxy URLs

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-phase7.test.js tests/antigravity-flow-tracer.test.js tests/antigravity-ipoasis.test.js --runInBand`

Expected: FAIL because lease regeneration is not wired into refresh paths.

**Step 3: Write minimal implementation**

- Regenerate or replace leases during the Antigravity refresh path.
- Persist failures into `proxy_leases.last_error`.
- Ensure successful regeneration updates the live node config `PROXY_URL` and immediately returns the node to a selectable state.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-phase7.test.js tests/antigravity-flow-tracer.test.js tests/antigravity-ipoasis.test.js --runInBand`

Expected: PASS for recovery behavior.

**Step 5: Commit**

```bash
git add src/providers/provider-pool-manager.js src/services/service-manager.js tests/antigravity-phase7.test.js tests/antigravity-flow-tracer.test.js tests/antigravity-ipoasis.test.js
git commit -m "feat: regenerate ipoasis leases during antigravity recovery"
```

### Task 5: Update config defaults and examples

**Files:**
- Modify: `src/core/config-manager.js`
- Modify: `configs/config.json.example`
- Modify: `configs/provider_pools.json.example`
- Test: `tests/antigravity-ipoasis.test.js`

**Step 1: Write the failing test**

Add tests that assert:
- config defaults expose IPOasis global keys
- Antigravity example nodes use `IPOASIS_SUBUSER_ID` instead of `PROXY_URL`

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: FAIL because examples and defaults still document manual `PROXY_URL`.

**Step 3: Write minimal implementation**

- Add global IPOasis config defaults to `config-manager.js`.
- Rewrite the example Antigravity pool entries to use IPOasis runtime config.
- Document the current shared sub-user ID example as `1865`, with the note that multiple nodes may share it while still generating separate sticky proxies.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-ipoasis.test.js --runInBand`

Expected: PASS for example/default coverage.

**Step 5: Commit**

```bash
git add src/core/config-manager.js configs/config.json.example configs/provider_pools.json.example tests/antigravity-ipoasis.test.js
git commit -m "docs: update antigravity config for ipoasis sticky proxies"
```

### Task 6: Run the focused and full regression suites

**Files:**
- Test: `tests/antigravity-ipoasis.test.js`
- Test: `tests/antigravity-phase3-startup.test.js`
- Test: `tests/antigravity-phase7.test.js`
- Test: `tests/antigravity-flow-tracer.test.js`
- Test: `tests/antigravity-phase1.test.js`
- Test: `tests/antigravity-phase2-phase3.test.js`
- Test: `tests/antigravity-phase4.test.js`
- Test: `tests/antigravity-phase5-phase6.test.js`
- Test: `tests/antigravity-phase8-launchers.test.js`
- Test: `tests/antigravity-phase8-master.test.js`

**Step 1: Run focused IPOasis tests**

Run: `npx jest tests/antigravity-ipoasis.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-phase7.test.js tests/antigravity-flow-tracer.test.js --runInBand --forceExit`

Expected: PASS

**Step 2: Run the full Antigravity regression suite**

Run: `npx jest tests/antigravity-phase1.test.js tests/antigravity-phase2-phase3.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-phase4.test.js tests/antigravity-phase5-phase6.test.js tests/antigravity-phase7.test.js tests/antigravity-phase8-launchers.test.js tests/antigravity-phase8-master.test.js tests/antigravity-flow-tracer.test.js tests/antigravity-ipoasis.test.js --runInBand --forceExit`

Expected: PASS

**Step 3: Commit**

```bash
git add tests
git commit -m "test: cover ipoasis-backed antigravity proxy materialization"
```
