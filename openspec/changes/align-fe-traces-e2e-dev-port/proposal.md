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

- **E2E test**: change `TELEMETRY_PORT` from `5174` to `5173` in
  `e2e/tests/observability.frontend-traces.spec.ts`. `5173` is already
  the canonical Vite dev port the slice-5 Collector CORS allowlist was
  written for; the existing scenario "Preflight from Vite dev origin
  is accepted" already covers it. `5173` is unused at e2e-test time
  because the harness's preview server runs on `4173`. The
  `--strictPort` flag the test already passes makes a port collision
  fail loud rather than silently steal a fallback port.
- **E2E test**: also bind/navigate via `localhost`, not `127.0.0.1`.
  CORS treats `http://localhost:5173` and `http://127.0.0.1:5173` as
  distinct origins; only the former is in the Collector's allowlist.
  Both `--host` (passed to `vite dev`) and `TELEMETRY_URL` switch to
  `localhost` so the browser's `Origin` header matches the allowlist
  exactly. (Discovered during local verification — without this, the
  port fix alone still CORS-blocks the OTLP preflight.)
- **E2E test**: harden `pollTempoForTrace` to keep polling until
  Tempo returns at least one span with `service.name=frontend` AND at
  least one with `service.name=backend`, with the existing 30-second
  budget and 1-second interval. Today the loop exits on first
  non-empty response, which races the FE batch's ingest tail.
- **E2E test**: extend the Playwright per-test timeout to 120s via
  `test.setTimeout(120_000)`. Playwright's default 30s ceiling is
  smaller than the Tempo poll budget alone (30s), so any real ingest
  delay surfaced as a generic test-timeout instead of as the poll's
  diagnostic error. (Discovered during local verification.)
- **E2E test**: fix the Loki query and result check to match the
  actual stored line shape. The slice-5 spec's filter looked for the
  flat dotted key `"trace.id":"…"`, but the backend emits ECS-nested
  `"trace":{"id":"…"}` — so the filter never matched and the test's
  Loki assertion always failed when run locally. Replace the brittle
  shape regex with a substring match on the 32-hex trace id (unique
  enough to avoid false positives, immune to exporter field-order
  changes). (Discovered during local verification.)
- **Infra (`docker-compose.yml`)**: expose Loki on host port `3100`.
  Slice 4 added Loki without a `ports:` mapping, so the slice-5 e2e
  spec's call to `http://localhost:3100/loki/api/v1/query_range`
  always failed locally with connection-refused. Adding one
  `3100:3100` mapping makes Loki host-reachable for direct API
  debugging and for this spec; Grafana's tracesToLogs pivot keeps
  using container DNS (`http://loki:3100`). (Discovered during local
  verification.)
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

- **E2E**: `e2e/tests/observability.frontend-traces.spec.ts` changes
  — port literal, host literal, two helper rewrites
  (`pollTempoForTrace`, `pollLokiForTraceId`), and a per-test timeout
  bump.
- **Infra**: `docker-compose.yml` gains one `ports: ["3100:3100"]`
  entry on the `loki` service. The Collector CORS allowlist stays
  unchanged (still the two documented Vite ports).
- **Frontend**: no changes. The bootstrap, the env gate, and the SDK
  wiring are all correct as shipped in slice 5.
- **Backend**: no changes.
- **CI**: no behaviour change — the test continues to self-skip when
  Tempo is unreachable, which is still the CI default until a future
  slice spins up the observability stack in CI. The Loki host port
  exposure is also a no-op in CI for the same reason (the
  observability profile is not started).
