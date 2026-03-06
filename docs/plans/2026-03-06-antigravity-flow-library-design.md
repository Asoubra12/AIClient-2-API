# Antigravity Flow Library Design

**Date:** 2026-03-06

## Goal

Persist the traced Antigravity architecture flows for `AIClient-2-API` under `docs/architecture/flows/` so future debugging and change-impact work can use stable, code-backed flow documents instead of session memory.

## Scope

- Document only the implemented Antigravity surfaces inside this repository.
- Follow the `flow-tracer` output structure exactly enough to support future extension.
- Capture the validated loop breakpoints and the fixes already landed in this branch.

## Output Shape

The flow library will contain:

- `docs/architecture/flows/index.md`
- `docs/architecture/flows/SHARED-INFRASTRUCTURE.md`
- `docs/architecture/flows/requirements.md`
- One folder per traced flow, each with:
  - `README.md`
  - `diagram.mermaid`

## Flow Set

The first persisted batch covers these repo-local flows:

1. `antigravity-content-generation-happy-path`
2. `antigravity-prehook-selection-and-chain-setup`
3. `antigravity-init-bootstrap-and-model-discovery`
4. `antigravity-stream-unary-retry-and-fallback`
5. `antigravity-quota-refresh-and-startup-prewarm`
6. `antigravity-telemetry-metrics-and-trajectory`
7. `antigravity-provider-lifecycle-and-tls-isolation`
8. `master-worker-launcher-supervision`
9. `model-catalog-and-provider-health-read-path`

## Documentation Rules

- Treat this repo as the system boundary; adjacent repos are out of scope unless directly imported or called from code here.
- Keep the diagrams at architectural-step granularity, not function-call granularity.
- Call out loop seams explicitly:
  - pre-hook output to provider selection
  - bootstrap to quota store to quota selection
  - generation outcome to telemetry
  - provider lifecycle to TLS cleanup
  - launcher readiness to heartbeat and restart handling
- Record known constraints separately from actual breakage.

## Verification

- Ensure every documented flow has both `README.md` and `diagram.mermaid`.
- Ensure the index maps every documented flow into a category.
- Spot-check step references against the traced source files before close-out.
