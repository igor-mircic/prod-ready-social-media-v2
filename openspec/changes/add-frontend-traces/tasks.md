# add-frontend-traces — Tasks

## 1. Pin and resolve the OTel browser SDK packages

- [ ] 1.1 Add the nine `@opentelemetry/*` packages to `frontend/package.json` `dependencies`: `sdk-trace-web`, `exporter-trace-otlp-http`, `context-zone`, `resources`, `semantic-conventions`, `instrumentation`, `instrumentation-fetch`, `instrumentation-document-load`, `instrumentation-user-interaction`. Pin to the latest mutually-compatible minor versions; verify pnpm reports no peer-dep warnings.
- [ ] 1.2 Run `pnpm install` in `frontend/` and commit the `pnpm-lock.yaml` updates.
- [ ] 1.3 Verify by code search that no `import` of `@opentelemetry/*` exists yet outside `frontend/src/observability/` (the directory does not exist yet; the search should return zero matches).

## 2. Bootstrap module `frontend/src/observability/tracer.ts`

- [ ] 2.1 Create the directory `frontend/src/observability/` and the file `tracer.ts` exporting one function `bootstrapTelemetry(): void`.
- [ ] 2.2 Implement the env-var gate: return immediately if `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`.
- [ ] 2.3 Construct a `Resource` from `@opentelemetry/resources` carrying `service.name=frontend` and `service.version=import.meta.env.VITE_APP_VERSION ?? 'unknown'`. Use constants from `@opentelemetry/semantic-conventions` for the attribute keys.
- [ ] 2.4 Wire the `VITE_APP_VERSION` injection in `frontend/vite.config.ts` via the `define` option (or `loadEnv`), reading from `frontend/package.json`'s `version` field at build time. Verify the value is a string literal in the built bundle.
- [ ] 2.5 Register a `WebTracerProvider` with the resource, a `ZoneContextManager` (cross-async context), and a `BatchSpanProcessor` configured with `scheduledDelayMillis=500` (overridable via `import.meta.env.VITE_OTEL_BATCH_DELAY_MS`).
- [ ] 2.6 Configure `OTLPTraceExporter` with `url=import.meta.env.VITE_OTEL_TRACES_ENDPOINT ?? 'http://localhost:4318/v1/traces'`.
- [ ] 2.7 Call `registerInstrumentations` with `DocumentLoadInstrumentation`, `FetchInstrumentation` (configured with `propagateTraceHeaderCorsUrls` restricted to the dev backend and `VITE_API_BASE_URL`), and `UserInteractionInstrumentation` (event list `["click", "submit"]`).
- [ ] 2.8 On successful boot, write exactly one `console.info` line: `OTel telemetry enabled: traces → <endpoint>` (with the resolved endpoint substituted).
- [ ] 2.9 Verify by code search that `tracer.ts` does NOT pass `applyCustomAttributesOnSpan`, `requestHook`, or `responseHook` to any instrumentation.

## 3. Wire the bootstrap into `main.tsx`

- [ ] 3.1 In `frontend/src/main.tsx`, add `import { bootstrapTelemetry } from './observability/tracer'` and call `bootstrapTelemetry()` synchronously before `createRoot(...)`.
- [ ] 3.2 Verify `pnpm dev` (without `VITE_OTEL_ENABLED`) still boots and renders the home page unchanged.
- [ ] 3.3 Verify `VITE_OTEL_ENABLED=true pnpm dev` produces the expected `OTel telemetry enabled:` console line in devtools and no other behaviour change.

## 4. Collector — enable CORS on the OTLP/HTTP receiver

- [ ] 4.1 Open `infra/observability/otel-collector-config.yaml` and locate the existing `receivers.otlp.protocols.http` block.
- [ ] 4.2 Add a `cors:` block with `allowed_origins: ["http://localhost:5173", "http://localhost:4173"]` and `allowed_headers: ["*"]`.
- [ ] 4.3 Verify the gRPC receiver under `receivers.otlp.protocols.grpc` is unchanged and does NOT carry a `cors:` block.
- [ ] 4.4 Restart the Collector via `docker-compose --profile observability restart otel-collector`. Verify the Collector log line on startup acknowledges the CORS configuration.
- [ ] 4.5 Manual smoke: `curl -i -X OPTIONS http://localhost:4318/v1/traces -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST'` returns 200 or 204 with `Access-Control-Allow-Origin: http://localhost:5173`.
- [ ] 4.6 Manual smoke: same OPTIONS with `Origin: https://evil.example.com` does NOT carry an `Access-Control-Allow-Origin` header for the evil origin.

## 5. Collector — add the path-segment redaction processor

- [ ] 5.1 In `infra/observability/otel-collector-config.yaml`, add a `transform/redact-path-ids` processor under `processors:`. Use the `traces` context and write three OTTL statements (or the equivalent regex syntax for the Collector version pinned in slice 4): redact UUID v4, opaque hex ≥8, and numeric ≥4 from the span name, `http.url`, `http.target`, and `url.full` attributes.
- [ ] 5.2 Wire the processor into `service.pipelines.traces.processors`, placed before the Tempo exporter (after `batch`, after any receiver-side processors).
- [ ] 5.3 Verify the processor applies to all `service.name` values (no `where` clause filtering by service).
- [ ] 5.4 Restart the Collector and verify the log line on startup acknowledges the processor.
- [ ] 5.5 Manual smoke: from devtools console with telemetry enabled, run `fetch('/api/v1/users/00000000-0000-0000-0000-000000000abc/follow')`. Query Tempo's recent traces; confirm the resulting span's `http.url` carries `{id}` and not the UUID.

## 6. Provision Tempo service-graph for the Tempo datasource

- [ ] 6.1 Open `infra/observability/grafana/provisioning/datasources/tempo.yaml`.
- [ ] 6.2 Add a `jsonData.serviceMap.datasourceUid` (or `datasourceName: Prometheus`) block referencing the existing Prometheus datasource.
- [ ] 6.3 Restart Grafana via `docker-compose --profile observability restart grafana` so provisioning re-reads.
- [ ] 6.4 Manual smoke: in Grafana → Explore → Tempo → Service Graph, after driving a few browser requests, the graph shows a `frontend → backend` edge.

## 7. Vitest unit test — boot is a safe no-op in jsdom

- [ ] 7.1 Create `frontend/src/observability/tracer.test.ts`.
- [ ] 7.2 Test 1: with `import.meta.env.VITE_OTEL_ENABLED` undefined, `bootstrapTelemetry()` does not throw, does not register a global tracer provider, and writes no `console.info` line.
- [ ] 7.3 Test 2: stub `import.meta.env.VITE_OTEL_ENABLED='true'` and `import.meta.env.VITE_OTEL_TRACES_ENDPOINT='http://stub/v1/traces'`; assert `bootstrapTelemetry()` writes exactly one `console.info` line of the form `OTel telemetry enabled: traces → http://stub/v1/traces`.
- [ ] 7.4 Test 3: after the enabled-boot test, assert `trace.getTracerProvider()` from `@opentelemetry/api` is NOT the no-op provider.
- [ ] 7.5 Run `pnpm test` and confirm all three tests pass.

## 8. E2E test — browser→backend trace continuity

- [ ] 8.1 Create `e2e/tests/observability.frontend-traces.spec.ts`.
- [ ] 8.2 Add a `test.beforeAll` that probes `http://localhost:3200/ready`; if not 200 within 2 seconds, call `test.skip(true, 'Tempo not reachable')`.
- [ ] 8.3 In the test body, configure Playwright to load the frontend with `VITE_OTEL_ENABLED=true` (set the env on the dev server invocation or use the production build with the env var baked in — match the e2e harness pattern from slice 3).
- [ ] 8.4 Log in as a seeded user via the UI.
- [ ] 8.5 Attach a `page.on('request', ...)` listener that captures the `traceparent` header on the request to `POST /api/v1/posts`. Trigger the request from the UI (post composer submit).
- [ ] 8.6 Parse the captured `traceparent` to extract the 32-hex-character trace id.
- [ ] 8.7 Poll Tempo's API `GET http://localhost:3200/api/traces/<traceId>` with a 30-second budget and 1-second interval until a response is returned.
- [ ] 8.8 Assert the response contains at least one span with `resource.service.name=frontend` AND at least one with `resource.service.name=backend`.
- [ ] 8.9 Assert the backend's ECS log line for the request (queried from Loki via the slice-4 Grafana data source) carries the same `trace.id`. Use the Loki HTTP API at `http://localhost:3100/loki/api/v1/query_range`.
- [ ] 8.10 Run the e2e suite locally with the observability profile up; confirm the new spec passes.
- [ ] 8.11 Run the e2e suite locally with the observability profile DOWN; confirm the new spec is reported as skipped (not failed).

## 9. README — frontend tracing run loop

- [ ] 9.1 Add a `### Frontend tracing` subsection under the existing `## Local observability` section in the top-level `README.md`.
- [ ] 9.2 Document the opt-in: `cd frontend && VITE_OTEL_ENABLED=true pnpm dev`.
- [ ] 9.3 Document the click→trace pivot: clicking the post composer's submit produces a trace whose root span is in `service.name=frontend`, with child spans flowing into `service.name=backend`.
- [ ] 9.4 Document the Tempo service-name filter (`{ resource.service.name = "frontend" }` and `= "backend"`) and the service-graph pivot in Grafana Explore.
- [ ] 9.5 Explicitly state that `traceparent` propagation is restricted to the backend origin and is NOT sent to third-party hosts.
- [ ] 9.6 Add a forward-pointer that frontend RUM metrics (Web Vitals) and frontend errors are the natural follow-up slices.

## 10. Final verification

- [ ] 10.1 Run `pnpm -C frontend lint`, `pnpm -C frontend test`, `pnpm -C frontend build`; all pass.
- [ ] 10.2 Run `openspec validate add-frontend-traces --strict`; reports no errors.
- [ ] 10.3 Confirm by code search that `frontend/src/` contains no `import` of `@opentelemetry/*` outside `frontend/src/observability/`.
- [ ] 10.4 Confirm by code search that `frontend/vite.config.ts` does not declare a proxy entry whose target is the Collector.
- [ ] 10.5 Confirm by code search that `backend/` has zero changes (no Java source, no Gradle build, no resources).
- [ ] 10.6 Manual end-to-end smoke with the full observability profile up:
  - start `docker-compose --profile observability up -d`,
  - start the backend (`./gradlew :backend:bootRun`),
  - start the frontend with `VITE_OTEL_ENABLED=true pnpm dev`,
  - log in via the browser,
  - submit a post via the composer,
  - in Grafana → Explore → Tempo, find the resulting trace, confirm it carries spans from both `frontend` and `backend`,
  - click the `Logs for this span` data link on the backend span, confirm Loki returns the ECS log line for the same `trace.id`.
- [ ] 10.7 Push branch, open PR, watch CI, archive change.
