# observability — delta for add-frontend-traces

## ADDED Requirements

### Requirement: Frontend bootstraps an OTel `WebTracerProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The `frontend/` project SHALL pin the following packages in `frontend/package.json` as runtime dependencies: `@opentelemetry/sdk-trace-web`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/context-zone`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-fetch`, `@opentelemetry/instrumentation-document-load`, and `@opentelemetry/instrumentation-user-interaction`. Each coordinate SHALL be pinned with an explicit, non-`latest`, non-tilde-without-bound version range.

The frontend SHALL declare a module `frontend/src/observability/tracer.ts` exporting one function `bootstrapTelemetry(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, construct a `Resource` carrying at minimum the attributes `service.name="frontend"` and `service.version=<value of import.meta.env.VITE_APP_VERSION>`;
- register a `WebTracerProvider` with that resource, a `ZoneContextManager`, a `BatchSpanProcessor`, and an `OTLPTraceExporter` whose URL defaults to `http://localhost:4318/v1/traces` and is overridable via `import.meta.env.VITE_OTEL_TRACES_ENDPOINT`;
- register exactly three auto-instrumentations: `DocumentLoadInstrumentation`, `FetchInstrumentation`, and `UserInteractionInstrumentation`;
- write exactly one console line of the form `OTel telemetry enabled: traces → <endpoint>` when boot succeeds, so a reader can confirm activation from devtools.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapTelemetry()` synchronously before `createRoot(...)` is called.

#### Scenario: SDK packages are pinned with explicit versions

- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block declares each of the nine listed `@opentelemetry/*` packages
- **AND** each coordinate's version range starts with a digit, a caret, or a tilde-with-bound (NOT `latest`, NOT `*`).

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapTelemetry()` runs
- **THEN** no OTel `WebTracerProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled:` is written
- **AND** no outbound POST to `/v1/traces` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: traces → <endpoint>`
- **AND** a `WebTracerProvider` is registered globally (verifiable via `trace.getTracerProvider()`).

#### Scenario: Application source has no compile-time dependency on the OTel SDK outside the observability module

- **WHEN** a reader greps `frontend/src/` for `import .* from ['\"]@opentelemetry/`
- **THEN** every match's file path starts with `frontend/src/observability/`.

### Requirement: Outbound browser fetch requests to the backend carry a W3C `traceparent` header

When telemetry is enabled, `FetchInstrumentation` SHALL be configured with `propagateTraceHeaderCorsUrls` matching exactly the backend origins reachable from the browser:

- the dev backend at `http://localhost:8080`,
- the Vite proxy-relative path family `/api/v1/*` (same-origin),
- the value of `import.meta.env.VITE_API_BASE_URL` if set at build time.

The instrumentation SHALL NOT propagate `traceparent` or `tracestate` headers to any other origin (CDN, font host, analytics host).

#### Scenario: Same-origin fetch to backend carries traceparent

- **GIVEN** the frontend is loaded with telemetry enabled
- **WHEN** an authenticated user triggers a `POST /api/v1/posts` via the UI
- **THEN** the outgoing HTTP request to that URL carries a header named `traceparent` whose value matches the W3C format `00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`.

#### Scenario: Cross-origin fetch to a third-party host carries no traceparent

- **GIVEN** the frontend is loaded with telemetry enabled
- **AND** a `fetch` call is made to a host other than the backend (e.g. a stub fetch to `https://example.com/`)
- **WHEN** a reader inspects the outgoing request headers
- **THEN** no `traceparent` header is present
- **AND** no `tracestate` header is present.

#### Scenario: Backend log line for the traced request carries the same `trace.id`

- **GIVEN** the frontend issues a fetch carrying `traceparent: 00-<X>-<Y>-01` to the backend
- **WHEN** the backend processes the request and emits an access log line
- **THEN** the JSON line's `trace.id` field equals the value `<X>` from the inbound header.

### Requirement: Browser-emitted spans carry `service.name=frontend` and `service.version`

The `Resource` registered with the `WebTracerProvider` SHALL declare at least these resource attributes on every span:

- `service.name` exactly equal to the string `frontend`,
- `service.version` equal to the value of `import.meta.env.VITE_APP_VERSION` (Vite injects this at build time from `frontend/package.json`'s `version` field; if the field is absent the value SHALL be the literal string `unknown`).

Spans SHALL NOT carry any resource attribute whose value is derived from request input (no `user.id`, `post.id`, or other per-request identifier as a resource attribute — those are span attributes if anywhere, never resource attributes).

#### Scenario: Browser-emitted spans land in Tempo with service.name=frontend

- **GIVEN** the frontend is loaded with telemetry enabled and the observability profile is running
- **WHEN** a user clicks a button that fires a backend request
- **AND** a reader queries Tempo for the resulting trace
- **THEN** at least one span in the trace carries `service.name=frontend`
- **AND** at least one span in the trace carries `service.name=backend`
- **AND** both spans share the same `trace.id`.

#### Scenario: service.version is the package version

- **GIVEN** `frontend/package.json` declares `"version": "0.0.0"`
- **WHEN** a span lands in Tempo
- **THEN** its resource attribute `service.version` equals `0.0.0`.

### Requirement: OTel Collector OTLP/HTTP receiver allows CORS for Vite origins

The file `infra/observability/otel-collector-config.yaml` SHALL declare a `cors` block on the `otlp` receiver's `http` protocol stanza with:

- `allowed_origins` containing at minimum `http://localhost:5173` (Vite dev) and `http://localhost:4173` (Vite preview),
- `allowed_headers` containing at minimum `*` OR the explicit list `["Content-Type", "traceparent", "tracestate"]`.

The receiver SHALL continue to listen on `0.0.0.0:4318` and SHALL continue to accept gRPC OTLP on `:4317` unchanged. The CORS block SHALL apply only to the HTTP protocol; the gRPC receiver SHALL NOT carry a CORS block.

#### Scenario: Collector config declares the CORS allowlist on the OTLP/HTTP receiver

- **WHEN** a reader inspects `infra/observability/otel-collector-config.yaml`
- **THEN** the file declares an `otlp` receiver with an `http` protocol stanza
- **AND** that stanza contains a `cors` block
- **AND** the `cors.allowed_origins` list includes both `http://localhost:5173` and `http://localhost:4173`.

#### Scenario: Preflight from Vite dev origin is accepted

- **GIVEN** the observability profile is running
- **WHEN** a client issues `OPTIONS http://localhost:4318/v1/traces` with `Origin: http://localhost:5173` and `Access-Control-Request-Method: POST`
- **THEN** the response status is 200 OR 204
- **AND** the response carries `Access-Control-Allow-Origin: http://localhost:5173`.

#### Scenario: Preflight from a disallowed origin is rejected

- **GIVEN** the observability profile is running
- **WHEN** a client issues `OPTIONS http://localhost:4318/v1/traces` with `Origin: https://evil.example.com`
- **THEN** the response does NOT carry `Access-Control-Allow-Origin: https://evil.example.com`
- **AND** the response does NOT carry `Access-Control-Allow-Origin: *`.

### Requirement: Collector redacts high-cardinality path segments from FE and BE spans

The file `infra/observability/otel-collector-config.yaml` SHALL declare a `transform` processor (`transform/redact-path-ids` or equivalent name) that, on every span passing through the `traces/default` pipeline, replaces matches of the following patterns inside span name, `http.url`, `http.target`, and `url.full` (where present) with the literal token `{id}`:

- UUID v4 (lowercase hex with hyphens): `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
- opaque hex segments of length 8 or more (`[0-9a-f]{8,}`) when bounded by `/` or end-of-string;
- numeric segments of length 4 or more (`[0-9]{4,}`) when bounded by `/` or end-of-string.

The processor SHALL be wired into the `traces/default` pipeline before the Tempo exporter, after any receiver-side processors. The processor SHALL apply to spans from any `service.name` value (FE and BE both).

#### Scenario: Collector pipeline lists the redaction processor before the Tempo exporter

- **WHEN** a reader inspects `infra/observability/otel-collector-config.yaml`
- **THEN** the file declares a `transform/redact-path-ids` processor (or equivalent name)
- **AND** the `service.pipelines.traces` (or `service.pipelines.traces/default`) `processors` list includes that processor
- **AND** the processor appears before any Tempo exporter in the same pipeline's `exporters` evaluation order.

#### Scenario: UUID segment is redacted in a browser-emitted span

- **GIVEN** the frontend issues a fetch to `/api/v1/users/00000000-0000-0000-0000-000000000abc/follow`
- **WHEN** the resulting span is queried from Tempo
- **THEN** the span's `http.url` attribute does NOT contain the substring `00000000-0000-0000-0000-000000000abc`
- **AND** the span's `http.url` attribute contains the substring `{id}`.

#### Scenario: Numeric id segment is redacted in a backend-emitted span

- **GIVEN** the backend handles `GET /api/v1/users/123456`
- **WHEN** the resulting span is queried from Tempo
- **THEN** no span attribute on that span contains the substring `/123456`
- **AND** at least one span attribute contains the substring `/{id}`.

### Requirement: Browser → Collector traffic goes direct; Vite proxy is NOT extended to `/v1/traces`

The file `frontend/vite.config.ts` SHALL NOT declare a proxy entry whose target is the OTel Collector. The proxy configuration SHALL remain restricted to backend paths (currently `/api/v1` and `/actuator`).

#### Scenario: Vite proxy config covers only backend paths

- **WHEN** a reader inspects the `server.proxy` (and `preview.proxy`) blocks in `frontend/vite.config.ts`
- **THEN** every proxy key matches either `/api/v1*` or `/actuator*`
- **AND** no proxy key matches `/v1/traces`, `/otlp*`, or any path under the Collector.

### Requirement: Browser-side header capture is left at OTel defaults

The `FetchInstrumentation` registration in `frontend/src/observability/tracer.ts` SHALL NOT pass an `applyCustomAttributesOnSpan` (or equivalent) hook that synthesises request- or response-header attributes onto spans. The OTel default behaviour (URL, method, status code, timings recorded; headers NOT recorded) SHALL be preserved.

#### Scenario: No header capture hook is configured

- **WHEN** a reader inspects `frontend/src/observability/tracer.ts`
- **THEN** the `FetchInstrumentation` constructor call carries no key named `applyCustomAttributesOnSpan`, `requestHook`, or `responseHook`
- **AND** no code in `frontend/src/observability/` calls `span.setAttribute('http.request.header.*', ...)` or `span.setAttribute('http.response.header.*', ...)`.

#### Scenario: Authorization header does not leak to a span

- **GIVEN** the frontend issues an authenticated `POST /api/v1/posts` carrying `Authorization: Bearer <jwt>`
- **WHEN** the resulting span is queried from Tempo
- **THEN** no span attribute on that span contains the substring `Bearer `
- **AND** no span attribute on that span carries a name starting with `http.request.header.authorization`.

### Requirement: Tempo datasource provisioning enables the service graph

The file `infra/observability/grafana/provisioning/datasources/tempo.yaml` SHALL declare on the existing `Tempo` datasource a `jsonData.serviceMap` block configured to render the service graph. The block SHALL reference the existing Prometheus datasource by name (`Prometheus`) so the service graph queries traffic metrics from Prometheus.

#### Scenario: Tempo datasource declares the serviceMap block

- **WHEN** a reader inspects `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one `Tempo` datasource
- **AND** the datasource's `jsonData` carries a `serviceMap` key whose `datasourceUid` (or `datasourceName`) refers to the `Prometheus` datasource.

### Requirement: End-to-end test proves browser → backend trace continuity

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/observability.frontend-traces.spec.ts` that, with the observability profile up and telemetry enabled:

- logs in as a seeded user via the UI,
- triggers a `POST /api/v1/posts` from the UI (not via direct API call),
- captures the `traceparent` header on the outgoing request via Playwright's `request.headers()`,
- polls Tempo's HTTP API (`http://localhost:3200/api/traces/<traceId>`) until a single trace is returned containing at least one span with `service.name=frontend` AND at least one span with `service.name=backend`,
- asserts the backend ECS log line emitted for that request carries the same `trace.id` value as the `traceparent` from the browser.

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

### Requirement: README documents the frontend tracing run loop

The repository's `README.md` SHALL add a `### Frontend tracing` subsection inside the existing `## Local observability` section, after the existing trace-pivot documentation. The subsection SHALL document:

- the `VITE_OTEL_ENABLED=true pnpm dev` invocation (in `frontend/`),
- the Tempo URL via Grafana, with the one-trace-two-services shape (`frontend` plus `backend`),
- the click→trace pivot (clicking a UI button produces a trace whose root is in `frontend`),
- the fact that `traceparent` is propagated only to the backend, not to third-party hosts.

#### Scenario: README documents the run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Frontend tracing` subsection nested under `## Local observability`
- **AND** the section names the `VITE_OTEL_ENABLED=true pnpm dev` invocation
- **AND** the section names Grafana's Tempo service-name filter and references both `frontend` and `backend` service values
- **AND** the section explicitly states that `traceparent` propagation is restricted to the backend origin.
