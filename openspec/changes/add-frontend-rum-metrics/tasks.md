# add-frontend-rum-metrics — Tasks

## 1. Pin and resolve the new packages

- [ ] 1.1 Add three packages to `frontend/package.json` `dependencies`: `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`. Pin to the latest mutually-compatible minor versions that match the slice-5 OTel SDK majors already on the manifest; verify `pnpm install` reports no peer-dep warnings.
- [ ] 1.2 Run `pnpm install` in `frontend/` and commit the `pnpm-lock.yaml` updates.
- [ ] 1.3 Verify by code search that no `import` of `web-vitals`, `@opentelemetry/sdk-metrics`, or `@opentelemetry/exporter-metrics-otlp-http` exists yet anywhere under `frontend/src/` (zero matches).

## 2. Refactor the shared OTel `Resource` into `resource.ts`

- [ ] 2.1 Create `frontend/src/observability/resource.ts` exporting one named const `frontendResource` built via `resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'frontend', [ATTR_SERVICE_VERSION]: env.VITE_APP_VERSION ?? 'unknown' })`. Read `import.meta.env` once at module top-level (mirror the `__envForTest` pattern from slice-5's `tracer.ts`).
- [ ] 2.2 Edit `frontend/src/observability/tracer.ts` to import `frontendResource` from `./resource` and pass it directly to `new WebTracerProvider({ resource: frontendResource, ... })`. Remove the local `resourceFromAttributes(...)` call.
- [ ] 2.3 Update `frontend/src/observability/tracer.test.ts` so any test that previously stubbed `VITE_APP_VERSION` still asserts the resulting `service.version` lands on emitted spans. Add coverage that `tracer.ts` and (forward-looking) `meter.ts` share the same `service.name`.
- [ ] 2.4 Verify `pnpm test` and `pnpm build` both pass with the refactor and the slice-5 behaviour is otherwise unchanged.

## 3. Bootstrap module `frontend/src/observability/meter.ts`

- [ ] 3.1 Create `frontend/src/observability/meter.ts` exporting one function `bootstrapMetrics(): void`.
- [ ] 3.2 Read `import.meta.env` once at module top-level. Implement the env-var gate: return immediately if `VITE_OTEL_ENABLED` is not the string `"true"`.
- [ ] 3.3 Resolve the endpoint from `VITE_OTEL_METRICS_ENDPOINT` with default `http://localhost:4318/v1/metrics`.
- [ ] 3.4 Resolve `exportIntervalMillis` from `VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` (positive integer) with default `15000`.
- [ ] 3.5 Construct an `OTLPMetricExporter` with the resolved URL. Wrap it in a `PeriodicExportingMetricReader` configured with the resolved export interval.
- [ ] 3.6 Construct a `MeterProvider` with `resource: frontendResource` (imported from `./resource`) and `readers: [<the reader>]`. Register it globally via `metrics.setGlobalMeterProvider(provider)`.
- [ ] 3.7 Acquire one `Meter` via `metrics.getMeter('frontend')`. Create five histograms — `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp`, `web_vitals_fcp`, `web_vitals_ttfb` — and store references in module-scope for the Web Vitals wiring (next task group).
- [ ] 3.8 Create one histogram `route_change_duration_ms` and one histogram `long_task_duration_ms` from the same meter; export both via a module-level `metrics` object so `route-timing.tsx` can call `record(...)` on the route histogram. Long-task observer registration happens in this module (Task 5).
- [ ] 3.9 On successful boot, write exactly one `console.info` line: `OTel telemetry enabled: metrics → <endpoint>` (with the resolved endpoint substituted).
- [ ] 3.10 Add a `visibilitychange` listener that calls `meterProvider.forceFlush()` so INP and CLS finalisations recorded on page hide make it across the wire.

## 4. Web Vitals wiring in `meter.ts`

- [ ] 4.1 Import `onLCP`, `onCLS`, `onINP`, `onFCP`, `onTTFB` from `web-vitals`.
- [ ] 4.2 Register each callback to record into the corresponding histogram. Each callback receives a `Metric` with a `value` field; call `histogram.record(metric.value)` with no attributes argument.
- [ ] 4.3 Verify by code search that none of the Web Vitals callbacks pass a non-empty attributes object to `histogram.record(...)`.
- [ ] 4.4 Verify by code search that no call to `web-vitals` passes `reportAllChanges: true`. The library default (`false`) is the intended posture for slice 6.

## 5. Long-task observer in `meter.ts`

- [ ] 5.1 Before registering the `PerformanceObserver`, guard on feature detection: if `PerformanceObserver.supportedEntryTypes` is undefined or does not include `'longtask'`, skip registration and return from this section silently.
- [ ] 5.2 Construct `new PerformanceObserver(list => list.getEntries().forEach(e => longTaskHistogram.record(e.duration)))` and `observe({ type: 'longtask', buffered: true })`.
- [ ] 5.3 Verify by manual smoke (devtools console) with telemetry enabled: run a synthetic main-thread block of ≥60 ms (e.g. `const t = performance.now(); while (performance.now() - t < 80) {}`), then check the next Collector scrape for a `long_task_duration_ms_bucket` line.

## 6. Route timing component `frontend/src/observability/route-timing.tsx`

- [ ] 6.1 Create `frontend/src/observability/route-timing.tsx` exporting `<RouteTimingObserver />` as a default-export functional component.
- [ ] 6.2 The component uses `useLocation()` from `react-router-dom` and `useMatches()` to resolve the matched route template.
- [ ] 6.3 In a `useEffect` keyed on `location.pathname`, compare against a module-level `lastTransitionAt: number | null` (start at `null`; on first effect after initial render, initialise from `performance.timeOrigin`-relative navigation start via `performance.now()`).
- [ ] 6.4 On subsequent renders, record `performance.now() - lastTransitionAt` into the route-timing histogram with `{ route: matchedTemplate }`. Update `lastTransitionAt` after recording.
- [ ] 6.5 Resolve `matchedTemplate` from `useMatches()`'s last entry's `id` (which is the route path template). When no match is found, use the literal string `unknown`.
- [ ] 6.6 The component returns `null`.
- [ ] 6.7 Edit `frontend/src/App.tsx` to import `<RouteTimingObserver />` and render it as a direct child of `<BrowserRouter>` (before `<Routes>`).

## 7. Wire `bootstrapMetrics()` into `main.tsx`

- [ ] 7.1 In `frontend/src/main.tsx`, add `import { bootstrapMetrics } from './observability/meter'` and call `bootstrapMetrics()` after `bootstrapTelemetry()` and before `createRoot(...)`.
- [ ] 7.2 Verify `pnpm dev` without `VITE_OTEL_ENABLED` boots cleanly and renders the home page unchanged (no console line about metrics).
- [ ] 7.3 Verify `VITE_OTEL_ENABLED=true pnpm dev` produces the expected `OTel telemetry enabled: metrics → http://localhost:4318/v1/metrics` line in devtools and triggers at least one network POST to `/v1/metrics` within 30 s of page load.

## 8. Collector — add the metrics pipeline

- [ ] 8.1 Open `infra/observability/collector/collector-config.yaml`. The `receivers.otlp.protocols.http` block already exists with CORS from slice 5 — no change.
- [ ] 8.2 Add a `prometheus` exporter under `exporters:` with `endpoint: 0.0.0.0:8889`, `add_metric_suffixes: false`, and `namespace: ""`.
- [ ] 8.3 Add a new pipeline `service.pipelines.metrics` with `receivers: [otlp]`, `processors: [batch, filter/drop_high_cardinality]`, `exporters: [prometheus]`.
- [ ] 8.4 Add the `filter/drop_high_cardinality` processor under `processors:`. Use OTTL: drop any data point whose `route` attribute matches one of `Matches(attributes["route"], "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")`, `Matches(attributes["route"], "[0-9a-f]{8,}")`, or `Matches(attributes["route"], "/[0-9]{4,}(/|$)")`.
- [ ] 8.5 Verify the existing `traces` and `logs` pipelines are unchanged.

## 9. Collector — publish port 8889

- [ ] 9.1 Open the root `docker-compose.yml` and locate the `collector` service.
- [ ] 9.2 Add `"8889:8889"` to the `ports` list (preserving the existing `4317` and `4318` entries).
- [ ] 9.3 Restart the collector: `docker-compose --profile observability restart collector`. Verify with `curl -i http://localhost:8889/metrics` that the endpoint returns 200 (even if the body has no FE series yet, the standard Collector self-metrics will be present).

## 10. Prometheus — scrape the collector

- [ ] 10.1 Open `infra/observability/prometheus/prometheus.yml`.
- [ ] 10.2 Add a second entry under `scrape_configs:` with `job_name: collector`, `metrics_path: /metrics`, `scrape_interval: 15s`, `static_configs: [{ targets: ["collector:8889"] }]`. Leave the existing `backend` job unchanged.
- [ ] 10.3 Restart Prometheus: `docker-compose --profile observability restart prometheus`. Verify `http://localhost:9090/api/v1/targets` reports the `collector` job as `up`.
- [ ] 10.4 Manual smoke after a browser session with telemetry on: query `http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}` and confirm `data.result` is non-empty.

## 11. Grafana — Frontend overview dashboard JSON

- [ ] 11.1 Create `infra/observability/grafana/dashboards/frontend-overview.json` mirroring the shape of `backend-overview.json` (Grafana 11.x dashboard schema; declare `${DS_PROMETHEUS}` as a templated datasource variable so the provisioning provider resolves it).
- [ ] 11.2 Add a "Web Vitals" row with five panels: LCP p75, CLS p75, INP p75, FCP p75, TTFB p75. PromQL `histogram_quantile(0.75, sum by (le) (rate(web_vitals_<name>_bucket{service_name="frontend"}[5m])))`.
- [ ] 11.3 Add a "Route timing" row with one panel showing `route_change_duration_ms` p50/p95/p99 stacked by `route` label. PromQL `histogram_quantile(0.95, sum by (le, route) (rate(route_change_duration_ms_bucket{service_name="frontend"}[5m])))` for each quantile.
- [ ] 11.4 Add a "Long tasks" row with two panels: (a) rate of `long_task_duration_ms_count`, (b) rate of `long_task_duration_ms_sum` ÷ rate of count (mean duration). Both filtered to `service_name="frontend"`.
- [ ] 11.5 Add a "Browser request volume" row with one panel: `rate(web_vitals_lcp_count{service_name="frontend"}[1m]) * 60` as a per-minute session-rate proxy.
- [ ] 11.6 Verify no panel hard-codes a Prometheus datasource UID; every panel uses the templated `${DS_PROMETHEUS}` form.
- [ ] 11.7 Restart Grafana: `docker-compose --profile observability restart grafana` (auto-provisioning requires a restart on YAML/dashboard add — see the project memory note).
- [ ] 11.8 Manual smoke: open `http://localhost:3000/d/frontend-overview` and confirm the dashboard renders (panels may be empty until browser traffic has flowed).

## 12. E2E spec — Frontend RUM metrics pipeline

- [ ] 12.1 Create `e2e/tests/observability.frontend-rum-metrics.spec.ts`.
- [ ] 12.2 Add a `test.beforeAll` that probes `http://localhost:8889/metrics` AND `http://localhost:9090/-/healthy`; if either is unreachable within 2 s, call `test.skip(true, 'Observability profile not up')`.
- [ ] 12.3 Configure Playwright to load the frontend with `VITE_OTEL_ENABLED=true` (match the slice-5 e2e harness env-var injection).
- [ ] 12.4 In the test body, log in as a seeded user via the UI; navigate `/home` → `/users/<seeded-id>` and back to `/home`. Wait at least 20 s after the last navigation to allow one full export + scrape cycle.
- [ ] 12.5 Fetch `http://localhost:8889/metrics` and assert the body contains at least one line beginning with `web_vitals_lcp_bucket` carrying `service_name="frontend"`.
- [ ] 12.6 Assert the same body contains at least one line beginning with `route_change_duration_ms_bucket` carrying `service_name="frontend"` AND a `route` label whose value matches `/users/:userId` or `/home` (no resolved user-id leaking).
- [ ] 12.7 Query `http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}` and assert `data.result` is non-empty.
- [ ] 12.8 Add a third assertion: query Prometheus for `route_change_duration_ms_bucket{service_name="frontend",route="/users/:userId"}` and assert `data.result` is non-empty.
- [ ] 12.9 Run the e2e suite locally with the observability profile up; confirm the new spec passes.
- [ ] 12.10 Run the e2e suite locally with the observability profile DOWN; confirm the spec is reported as skipped (not failed).

## 13. README — Frontend RUM metrics run loop

- [ ] 13.1 Add a `### Frontend RUM metrics` subsection under the existing `## Local observability` section in the top-level `README.md`, immediately after the `### Frontend tracing` subsection from slice 5.
- [ ] 13.2 Document the opt-in: `cd frontend && VITE_OTEL_ENABLED=true pnpm dev` (same gate as slice 5).
- [ ] 13.3 Document the wire path: browser → `http://localhost:4318/v1/metrics` → Collector → Prometheus scrape at `http://localhost:8889/metrics` (job name `collector`) → Grafana panels.
- [ ] 13.4 Document the dashboard URL: `http://localhost:3000/d/frontend-overview` (or via Grafana search for `Frontend overview`).
- [ ] 13.5 State the expectation that panels are empty until a browser has loaded the app with the gate enabled, and that Web Vitals like LCP / INP only finalise after specific user actions (LCP after first paint; INP after the first event handler completes).
- [ ] 13.6 Add a forward-pointer that frontend errors (React error boundary, `window.onerror`, `unhandledrejection`) and alerting / SLO definitions for both FE and BE are the natural follow-up slices.
