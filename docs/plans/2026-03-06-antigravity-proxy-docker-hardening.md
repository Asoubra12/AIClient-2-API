# Antigravity Proxy Validation And Docker Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fail fast when any enabled Antigravity node is missing a per-node `PROXY_URL`, and harden Docker runtime packaging so PID 1 uses `tini` and native `waitpid2` support is installable.

**Architecture:** Add a strict Antigravity startup validation step in the provider-pool initialization path so invalid pools stop boot instead of merely warning. Harden the container packaging layer by installing `tini` and native build prerequisites before `npm install`, then run the master process under `tini` and keep compose aligned with `init: true`.

**Tech Stack:** Node.js, Jest, Docker, Alpine Linux, provider pool manager

---

### Task 1: Fail Fast On Missing Antigravity Per-Node Proxy

**Files:**
- Modify: `tests/antigravity-phase7.test.js`
- Modify: `src/providers/provider-pool-manager.js`

**Step 1: Write the failing test**

Add a Phase 7 regression that constructs a `ProviderPoolManager` with an enabled `gemini-antigravity` node missing `PROXY_URL` and asserts initialization throws a config error naming the offending UUID.

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-phase7.test.js --runInBand --forceExit`
Expected: FAIL because startup currently warns and continues.

**Step 3: Write minimal implementation**

In `src/providers/provider-pool-manager.js`, replace the startup warning-only behavior for enabled Antigravity nodes missing `PROXY_URL` with strict validation that throws an error during initialization. Keep disabled nodes excluded from the failure list.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-phase7.test.js --runInBand --forceExit`
Expected: PASS

### Task 2: Keep Health Surface Explicit For Invalid Antigravity Config

**Files:**
- Modify: `tests/antigravity-flow-tracer.test.js`
- Modify: `src/services/service-manager.js`

**Step 1: Write the failing test**

Add a focused regression asserting the provider health/read path reports an explicit invalid availability state for Antigravity nodes that are not selectable because their per-node proxy is missing.

**Step 2: Run test to verify it fails**

Run: `npx jest tests/antigravity-flow-tracer.test.js --runInBand --forceExit`
Expected: FAIL because the invalid-config state is not surfaced strongly enough.

**Step 3: Write minimal implementation**

Update the provider status shaping in `src/services/service-manager.js` so the read path exposes a distinct invalid/misconfigured availability state for Antigravity nodes with missing `PROXY_URL`.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-flow-tracer.test.js --runInBand --forceExit`
Expected: PASS

### Task 3: Harden Docker PID 1 Packaging

**Files:**
- Modify: `tests/antigravity-phase8-launchers.test.js`
- Modify: `Dockerfile`
- Modify: `docker/docker-compose.yml`

**Step 1: Write the failing tests**

Add packaging-level regressions that assert:
- the Docker image installs `tini`
- native build prerequisites are installed before `npm install`
- the image entrypoint runs `tini --`
- compose enables `init: true`

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/antigravity-phase8-launchers.test.js --runInBand --forceExit`
Expected: FAIL because the current container runs `sh -c node ...` directly and does not declare `init: true`.

**Step 3: Write minimal implementation**

Update `Dockerfile` to install `tini` plus native build prerequisites before `npm install`, add `ENTRYPOINT ["tini","--"]`, and keep the existing master command under that entrypoint. Update `docker/docker-compose.yml` to set `init: true`.

**Step 4: Run test to verify it passes**

Run: `npx jest tests/antigravity-phase8-launchers.test.js --runInBand --forceExit`
Expected: PASS

### Task 4: Verify The Approved Batch

**Files:**
- Test: `tests/antigravity-flow-tracer.test.js`
- Test: `tests/antigravity-phase7.test.js`
- Test: `tests/antigravity-phase8-launchers.test.js`
- Test: `tests/antigravity-phase8-master.test.js`

**Step 1: Run focused verification**

Run: `npx jest tests/antigravity-flow-tracer.test.js tests/antigravity-phase7.test.js tests/antigravity-phase8-launchers.test.js tests/antigravity-phase8-master.test.js --runInBand --forceExit`
Expected: PASS

**Step 2: Run full Antigravity regression**

Run: `npx jest tests/antigravity-phase1.test.js tests/antigravity-phase2-phase3.test.js tests/antigravity-phase3-startup.test.js tests/antigravity-phase4.test.js tests/antigravity-phase5-phase6.test.js tests/antigravity-phase7.test.js tests/antigravity-phase8-launchers.test.js tests/antigravity-phase8-master.test.js tests/antigravity-flow-tracer.test.js --runInBand --forceExit`
Expected: PASS
