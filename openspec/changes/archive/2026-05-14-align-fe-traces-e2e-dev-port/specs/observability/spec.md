# observability — delta for align-fe-traces-e2e-dev-port

## MODIFIED Requirements

### Requirement: End-to-end test proves browser → backend trace continuity

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/observability.frontend-traces.spec.ts` that, with the observability profile up and telemetry enabled:

- logs in as a seeded user via the UI,
- triggers a `POST /api/v1/posts` from the UI (not via direct API call),
- captures the `traceparent` header on the outgoing request via Playwright's `request.headers()`,
- polls Tempo's HTTP API (`http://localhost:3200/api/traces/<traceId>`) until **both** `resource.service.name=frontend` AND `resource.service.name=backend` spans are present in the returned trace (not just any non-empty response — the backend's span batch lands first, and the FE batch arrives after a BatchSpanProcessor flush + Collector → Tempo ingest tail, so the loop SHALL continue past the first non-empty batch until the FE-side span is also visible, with the existing 30-second total budget and 1-second interval),
- asserts the backend ECS log line emitted for that request carries the same `trace.id` value as the `traceparent` from the browser.

The spawned telemetry-enabled `vite dev` server SHALL bind to `http://localhost:5173` (the canonical Vite dev port, already in the Collector's CORS allowlist). The test SHALL NOT bind to a port outside that allowlist; spawning the dev server on an off-allowlist port would CORS-block the browser's OTLP POSTs and the FE half of the trace would never reach Tempo. The `--strictPort` flag SHALL be passed so a busy `:5173` fails loud rather than silently selecting a fallback.

The test SHALL `test.skip(...)` itself when the Tempo HTTP API is not reachable, matching the slice-3 pattern. The test SHALL NOT depend on which service.name span is the root of the trace tree (the root may be `documentLoad` or a click span, both of which are `frontend`).

#### Scenario: Test asserts trace continuity for one POST /api/v1/posts

- **WHEN** the e2e test runs against an observability-up environment
- **THEN** the test passes
- **AND** the test makes exactly one assertion that the browser-emitted `traceparent` carries a 32-hex-character trace id
- **AND** the test makes exactly one assertion that the Tempo trace contains spans from both `service.name=frontend` and `service.name=backend`
- **AND** the test makes exactly one assertion that the backend's log line for the request carries the same `trace.id`.

#### Scenario: Test self-skips when Tempo is unreachable

- **GIVEN** the observability profile is NOT running (Tempo HTTP API on `:3200` is unreachable)
- **WHEN** the e2e test executes
- **THEN** the test is reported as skipped, not failed
- **AND** the skip reason mentions Tempo reachability.

#### Scenario: Tempo poll waits for the FE span, not just any batch

- **GIVEN** the e2e test has captured a `traceparent` from the browser's `POST /api/v1/posts`
- **WHEN** the test polls `GET http://localhost:3200/api/traces/<traceId>`
- **THEN** the loop SHALL continue past a response that contains only `resource.service.name=backend` spans
- **AND** the loop SHALL return only when the response contains at least one `resource.service.name=frontend` span AND at least one `resource.service.name=backend` span
- **AND** the loop SHALL respect a 30-second total budget; on budget exhaustion the test SHALL fail with a message identifying which service name(s) were still missing.

#### Scenario: Telemetry-enabled dev server binds to the allowlisted dev origin

- **WHEN** the e2e test's `beforeAll` spawns its own `vite dev` server (so the build can read `VITE_OTEL_ENABLED=true`)
- **THEN** the server binds to `http://localhost:5173` exactly (host MUST be the literal `localhost`, not `127.0.0.1` — CORS treats those as distinct origins and only `http://localhost:5173` is in `cors.allowed_origins`)
- **AND** the spawn passes `--strictPort` so a busy port fails the test loudly rather than silently using a fallback
- **AND** the Origin the browser presents to the Collector's CORS preflight (`http://localhost:5173`) is already in `cors.allowed_origins` on the OTLP/HTTP receiver.

#### Scenario: Loki HTTP API is reachable from the host

- **GIVEN** the observability profile is running
- **WHEN** the e2e test issues `GET http://localhost:3100/loki/api/v1/query_range` from the Playwright process running on the host
- **THEN** Loki responds (`docker-compose.yml` SHALL publish container port 3100 to host port 3100 on the `loki` service)
- **AND** the Grafana → Tempo `tracesToLogs` pivot continues to use the container DNS address (`http://loki:3100`), unaffected by the host port mapping.

#### Scenario: Loki query matches the ECS-nested trace.id shape

- **GIVEN** the e2e test has captured a `traceparent` from the browser's `POST /api/v1/posts`
- **WHEN** the test polls `GET http://localhost:3100/loki/api/v1/query_range` with a LogQL filter that selects lines containing the trace id
- **THEN** the filter SHALL match the backend's ECS-nested emission (`"trace":{"id":"<id>"`), not a flat dotted key (`"trace.id":"<id>"`)
- **AND** the test SHALL accept the line as a match if the 32-hex trace id appears anywhere in the stored line (the id is unique enough to make false positives impossible and avoids coupling the assertion to the loki exporter's field-order choices).
