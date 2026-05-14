# align-fe-traces-e2e-dev-port

## Why

The slice-5 Playwright spec `e2e/tests/observability.frontend-traces.spec.ts`
spawns its own `vite dev` server on port `5174` so it can run with
`VITE_OTEL_ENABLED=true` without colliding with the shared e2e harness's
`vite preview` on `4173`. But the Collector's CORS allowlist (added by
slice 5) only contains `http://localhost:5173` (Vite dev default) and
`http://localhost:4173` (Vite preview default). When the browser running
on `5174` issues the OTLP preflight to `http://localhost:4318/v1/traces`,
the Collector refuses to return `Access-Control-Allow-Origin`, the
browser drops the OTLP POST, and the FE half of the trace never reaches
Tempo. The `traceparent` still propagates on the same-origin Vite-proxy
hop to the backend (no preflight, so CORS is irrelevant there), so the
test sees only `service.name=backend` spans and the
`expect(serviceNames).toContain('frontend')` assertion fails locally.

The same spec passes in CI because the observability stack is not
running (the test self-skips on `/ready` unreachable) — so the bug only
surfaces when a developer runs the e2e suite locally with the
`observability` compose profile up, which is exactly the path the spec
was designed to validate.

A second, latent issue compounds the first: the test's
`pollTempoForTrace` returns as soon as Tempo has any batches at all.
The backend's batch arrives within ~1s; the FE batch, even with CORS
fixed, may arrive seconds later (BatchSpanProcessor flush +
Collector → Tempo pipeline). The current test would race the
ingest tail even after the CORS fix.

## What Changes

- **E2E test only**: change `TELEMETRY_PORT` from `5174` to `5173` in
  `e2e/tests/observability.frontend-traces.spec.ts`. `5173` is already
  the canonical Vite dev port the slice-5 Collector CORS allowlist was
  written for; the existing scenario "Preflight from Vite dev origin
  is accepted" already covers it. `5173` is unused at e2e-test time
  because the harness's preview server runs on `4173`. The
  `--strictPort` flag the test already passes makes a port collision
  fail loud rather than silently steal a fallback port.
- **E2E test only**: harden `pollTempoForTrace` to keep polling until
  Tempo returns at least one span with `service.name=frontend` AND at
  least one with `service.name=backend`, with the existing 30-second
  budget and 1-second interval. Today the loop exits on first
  non-empty response, which races the FE batch's ingest tail.
- **Collector CORS allowlist**: unchanged. The two-port allowlist
  remains the documented contract (Vite dev + Vite preview, full
  stop). Adding `5174` would broaden the surface to accommodate a
  test-internal port choice the rest of the system has no business
  knowing about.

## Capabilities

### New Capabilities

(None.)

### Modified Capabilities

- `observability`: one existing scenario (the end-to-end trace-
  continuity test scenario) is tightened — the test SHALL poll until
  both `service.name=frontend` and `service.name=backend` spans are
  present, not just any batch. No new requirements, no new scenarios;
  the same delta updates the existing scenario's polling assertion.

## Impact

- **E2E**: one file changes
  (`e2e/tests/observability.frontend-traces.spec.ts`). One port
  literal, one helper rewrite.
- **Collector / Infra**: no changes. The CORS allowlist stays at the
  two documented ports.
- **Frontend**: no changes. The bootstrap, the env gate, and the SDK
  wiring are all correct as shipped in slice 5.
- **Backend**: no changes.
- **CI**: no behaviour change — the test continues to self-skip when
  Tempo is unreachable, which is still the CI default until a future
  slice spins up the observability stack in CI.
