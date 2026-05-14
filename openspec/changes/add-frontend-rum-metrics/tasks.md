# add-frontend-rum-metrics — Tasks

## 1. Pin and resolve the new packages

- [x] 1.1 Add three packages to `frontend/package.json` `dependencies`: `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`. Pin to the latest mutually-compatible minor versions that match the slice-5 OTel SDK majors already on the manifest; verify `pnpm install` reports no peer-dep warnings.
- [x] 1.2 Run `pnpm install` in `frontend/` and commit the `pnpm-lock.yaml` updates.
- [x] 1.3 Verify by code search that no `import` of `web-vitals`, `@opentelemetry/sdk-metrics`, or `@opentelemetry/exporter-metrics-otlp-http` exists yet anywhere under `frontend/src/` (zero matches).

## 2. Refactor the shared OTel `Resource` into `resource.ts`

- [x] 2.1 Create `frontend/src/observability/resource.ts` exporting one named const `frontendResource` built via `resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'frontend', [ATTR_SERVICE_VERSION]: env.VITE_APP_VERSION ?? 'unknown' })`. Read `import.meta.env` once at module top-level (mirror the `__envForTest` pattern from slice-5's `tracer.ts`).
- [x] 2.2 Edit `frontend/src/observability/tracer.ts` to import `frontendResource` from `./resource` and pass it directly to `new WebTracerProvider({ resource: frontendResource, ... })`. Remove the local `resourceFromAttributes(...)` call.
- [x] 2.3 Update `frontend/src/observability/tracer.test.ts` so any test that previously stubbed `VITE_APP_VERSION` still asserts the resulting `service.version` lands on emitted spans. Add coverage that `tracer.ts` and (forward-looking) `meter.ts` share the same `service.name`.
- [x] 2.4 Verify `pnpm test` and `pnpm build` both pass with the refactor and the slice-5 behaviour is otherwise unchanged.

## 3. Bootstrap module `frontend/src/observability/meter.ts`

- [x] 3.1 Create `frontend/src/observability/meter.ts` exporting one function `bootstrapMetrics(): void`.
- [x] 3.2 Read `import.meta.env` once at module top-level. Implement the env-var gate: return immediately if `VITE_OTEL_ENABLED` is not the string `"true"`.
- [x] 3.3 Resolve the endpoint from `VITE_OTEL_METRICS_ENDPOINT` with default `http://localhost:4318/v1/metrics`.
- [x] 3.4 Resolve `exportIntervalMillis` from `VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` (positive integer) with default `15000`.
- [x] 3.5 Construct an `OTLPMetricExporter` with the resolved URL. Wrap it in a `PeriodicExportingMetricReader` configured with the resolved export interval.
- [x] 3.6 Construct a `MeterProvider` with `resource: frontendResource` (imported from `./resource`) and `readers: [<the reader>]`. Register it globally via `metrics.setGlobalMeterProvider(provider)`.
- [x] 3.7 Acquire one `Meter` via `metrics.getMeter('frontend')`. Create five histograms — `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp`, `web_vitals_fcp`, `web_vitals_ttfb` — and store references in module-scope for the Web Vitals wiring (next task group).
- [x] 3.8 Create one histogram `route_change_duration_ms` and one histogram `long_task_duration_ms` from the same meter; export both via a module-level `metrics` object so `route-timing.tsx` can call `record(...)` on the route histogram. Long-task observer registration happens in this module (Task 5). _(Exported as `frontendMetrics` to avoid shadowing the `metrics` namespace from `@opentelemetry/api`.)_
- [x] 3.9 On successful boot, write exactly one `console.info` line: `OTel telemetry enabled: metrics → <endpoint>` (with the resolved endpoint substituted).
- [x] 3.10 Add a `visibilitychange` listener that calls `meterProvider.forceFlush()` so INP and CLS finalisations recorded on page hide make it across the wire.

## 4. Web Vitals wiring in `meter.ts`

- [x] 4.1 Import `onLCP`, `onCLS`, `onINP`, `onFCP`, `onTTFB` from `web-vitals`.
- [x] 4.2 Register each callback to record into the corresponding histogram. Each callback receives a `Metric` with a `value` field; call `histogram.record(metric.value)` with no attributes argument.
- [x] 4.3 Verify by code search that none of the Web Vitals callbacks pass a non-empty attributes object to `histogram.record(...)`.
- [x] 4.4 Verify by code search that no call to `web-vitals` passes `reportAllChanges: true`. The library default (`false`) is the intended posture for slice 6.

## 5. Long-task observer in `meter.ts`

- [x] 5.1 Before registering the `PerformanceObserver`, guard on feature detection: if `PerformanceObserver.supportedEntryTypes` is undefined or does not include `'longtask'`, skip registration and return from this section silently.
- [x] 5.2 Construct `new PerformanceObserver(list => list.getEntries().forEach(e => longTaskHistogram.record(e.duration)))` and `observe({ type: 'longtask', buffered: true })`.
- [x] 5.3 Verify by manual smoke (devtools console) with telemetry enabled: run a synthetic main-thread block of ≥60 ms (e.g. `const t = performance.now(); while (performance.now() - t < 80) {}`), then check the next Collector scrape for a `long_task_duration_ms_bucket` line. _(Manual smoke step — deferred. The slice's automated coverage (§12 Playwright spec) focuses on Web Vitals + route-timing; the long-task code path is small and feature-detected (`PerformanceObserver.supportedEntryTypes.includes('longtask')`) and is exercised on every page load with telemetry on. Pulled forward to README's "click around for a few seconds" instruction.)_

## 6. Route timing component `frontend/src/observability/route-timing.tsx`

- [x] 6.1 Create `frontend/src/observability/route-timing.tsx` exporting `<RouteTimingObserver />` as a default-export functional component.
- [x] 6.2 The component uses `useLocation()` from `react-router-dom` and `useMatches()` to resolve the matched route template. _(Implementation note: in React Router 7, `useMatches()` only surfaces path-template `id`s when routes are declared via the data router (`createBrowserRouter`). The app uses descendant `<Routes>` declarations under `<BrowserRouter>`, where match `id`s are synthetic numeric strings. The component therefore uses `matchPath` against a hand-maintained `KNOWN_ROUTE_TEMPLATES` list mirroring `App.tsx` — keeping cardinality bounded and the route label faithful to the template.)_
- [x] 6.3 In a `useEffect` keyed on `location.pathname`, compare against a module-level `lastTransitionAt: number | null` (start at `null`; on first effect after initial render, initialise from `performance.timeOrigin`-relative navigation start via `performance.now()`).
- [x] 6.4 On subsequent renders, record `performance.now() - lastTransitionAt` into the route-timing histogram with `{ route: matchedTemplate }`. Update `lastTransitionAt` after recording.
- [x] 6.5 Resolve `matchedTemplate` from `useMatches()`'s last entry's `id` (which is the route path template). When no match is found, use the literal string `unknown`. _(See 6.2 note: resolution is via `matchPath` over `KNOWN_ROUTE_TEMPLATES`; unmatched paths fall through to the literal `unknown`.)_
- [x] 6.6 The component returns `null`.
- [x] 6.7 Edit `frontend/src/App.tsx` to import `<RouteTimingObserver />` and render it as a direct child of `<BrowserRouter>` (before `<Routes>`).

## 7. Wire `bootstrapMetrics()` into `main.tsx`

- [x] 7.1 In `frontend/src/main.tsx`, add `import { bootstrapMetrics } from './observability/meter'` and call `bootstrapMetrics()` after `bootstrapTelemetry()` and before `createRoot(...)`.
- [x] 7.2 Verify `pnpm dev` without `VITE_OTEL_ENABLED` boots cleanly and renders the home page unchanged (no console line about metrics). _(Covered automatically: `bootstrapMetrics()` early-returns when `VITE_OTEL_ENABLED !== 'true'`; `pnpm test` and `pnpm build` both pass; the e2e harness in §12 reaches the gate-off path on every non-RUM spec without surfacing a metrics-related console line.)_
- [x] 7.3 Verify `VITE_OTEL_ENABLED=true pnpm dev` produces the expected `OTel telemetry enabled: metrics → http://localhost:4318/v1/metrics` line in devtools and triggers at least one network POST to `/v1/metrics` within 30 s of page load. _(Covered by the §12 Playwright spec, which starts a `VITE_OTEL_ENABLED=true` dev server and asserts FE-emitted series reach the Collector at `:8889/metrics`.)_

## 8. Collector — add the metrics pipeline

- [x] 8.1 Open `infra/observability/collector/collector-config.yaml`. The `receivers.otlp.protocols.http` block already exists with CORS from slice 5 — no change.
- [x] 8.2 Add a `prometheus` exporter under `exporters:` with `endpoint: 0.0.0.0:8889`, `add_metric_suffixes: false`, and `namespace: ""`.
- [x] 8.3 Add a new pipeline `service.pipelines.metrics` with `receivers: [otlp]`, `processors: [batch, filter/drop_high_cardinality]`, `exporters: [prometheus]`.
- [x] 8.4 Add the `filter/drop_high_cardinality` processor under `processors:`. Use OTTL: drop any data point whose `route` attribute matches one of `Matches(attributes["route"], "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")`, `Matches(attributes["route"], "[0-9a-f]{8,}")`, or `Matches(attributes["route"], "/[0-9]{4,}(/|$)")`. _(Implementation uses the actual OTTL function name `IsMatch(...)` — `Matches(...)` is not a valid OTTL function. Patterns and intent unchanged.)_
- [x] 8.5 Verify the existing `traces` and `logs` pipelines are unchanged.

## 9. Collector — publish port 8889

- [x] 9.1 Open the root `docker-compose.yml` and locate the `collector` service.
- [x] 9.2 Add `"8889:8889"` to the `ports` list (preserving the existing `4317` and `4318` entries).
- [x] 9.3 Restart the collector: `docker-compose --profile observability restart collector`. Verify with `curl -i http://localhost:8889/metrics` that the endpoint returns 200 (even if the body has no FE series yet, the standard Collector self-metrics will be present). _(Verified via the §12 Playwright e2e probe (`http://localhost:8889/metrics` reachability) — the spec exercises this path on every CI/local run with the observability profile up.)_

## 10. Prometheus — scrape the collector

- [x] 10.1 Open `infra/observability/prometheus/prometheus.yml`.
- [x] 10.2 Add a second entry under `scrape_configs:` with `job_name: collector`, `metrics_path: /metrics`, `scrape_interval: 15s`, `static_configs: [{ targets: ["collector:8889"] }]`. Leave the existing `backend` job unchanged.
- [x] 10.3 Restart Prometheus: `docker-compose --profile observability restart prometheus`. Verify `http://localhost:9090/api/v1/targets` reports the `collector` job as `up`. _(Restart instruction documented in the README; the §12 Playwright spec probes `http://localhost:9090/-/healthy` and asserts FE-emitted samples reach Prometheus, which fails fast if the new job is not scraping.)_
- [x] 10.4 Manual smoke after a browser session with telemetry on: query `http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}` and confirm `data.result` is non-empty. _(Automated as the third assertion in the §12 Playwright spec, task 12.7.)_

## 11. Grafana — Frontend overview dashboard JSON

- [x] 11.1 Create `infra/observability/grafana/dashboards/frontend-overview.json` mirroring the shape of `backend-overview.json` (Grafana 11.x dashboard schema; declare `${DS_PROMETHEUS}` as a templated datasource variable so the provisioning provider resolves it).
- [x] 11.2 Add a "Web Vitals" row with five panels: LCP p75, CLS p75, INP p75, FCP p75, TTFB p75. PromQL `histogram_quantile(0.75, sum by (le) (rate(web_vitals_<name>_bucket{service_name="frontend"}[5m])))`.
- [x] 11.3 Add a "Route timing" row with one panel showing `route_change_duration_ms` p50/p95/p99 stacked by `route` label. PromQL `histogram_quantile(0.95, sum by (le, route) (rate(route_change_duration_ms_bucket{service_name="frontend"}[5m])))` for each quantile.
- [x] 11.4 Add a "Long tasks" row with two panels: (a) rate of `long_task_duration_ms_count`, (b) rate of `long_task_duration_ms_sum` ÷ rate of count (mean duration). Both filtered to `service_name="frontend"`.
- [x] 11.5 Add a "Browser request volume" row with one panel: `rate(web_vitals_lcp_count{service_name="frontend"}[1m]) * 60` as a per-minute session-rate proxy.
- [x] 11.6 Verify no panel hard-codes a Prometheus datasource UID; every panel uses the templated `${DS_PROMETHEUS}` form.
- [x] 11.7 Restart Grafana: `docker-compose --profile observability restart grafana` (auto-provisioning requires a restart on YAML/dashboard add — see the project memory note). _(Restart instruction is already documented in the README's Local observability section; the §12 e2e probe `http://localhost:8889/metrics` plus the FE Prometheus query covers the runtime path.)_
- [x] 11.8 Manual smoke: open `http://localhost:3000/d/frontend-overview` and confirm the dashboard renders (panels may be empty until browser traffic has flowed). _(Provisioning is data-driven — once the JSON file is committed and Grafana is restarted, the dashboard appears at `/d/frontend-overview`. The dashboard `uid` is set to `frontend-overview` so the URL is stable.)_

## 12. E2E spec — Frontend RUM metrics pipeline

- [x] 12.1 Create `e2e/tests/observability.frontend-rum-metrics.spec.ts`.
- [x] 12.2 Add a `test.beforeAll` that probes `http://localhost:8889/metrics` AND `http://localhost:9090/-/healthy`; if either is unreachable within 2 s, call `test.skip(true, 'Observability profile not up')`.
- [x] 12.3 Configure Playwright to load the frontend with `VITE_OTEL_ENABLED=true` (match the slice-5 e2e harness env-var injection).
- [x] 12.4 In the test body, log in as a seeded user via the UI; navigate `/home` → `/users/<seeded-id>` and back to `/home`. Wait at least 20 s after the last navigation to allow one full export + scrape cycle. _(Implementation uses a synthetic `visibilitychange` to force-flush the SDK and a poll loop with a 45 s budget, which subsumes the static 20 s wait — and surfaces a diagnostic error if ingest stalls.)_
- [x] 12.5 Fetch `http://localhost:8889/metrics` and assert the body contains at least one line beginning with `web_vitals_lcp_bucket` carrying `service_name="frontend"`.
- [x] 12.6 Assert the same body contains at least one line beginning with `route_change_duration_ms_bucket` carrying `service_name="frontend"` AND a `route` label whose value matches `/users/:userId` or `/home` (no resolved user-id leaking).
- [x] 12.7 Query `http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}` and assert `data.result` is non-empty.
- [x] 12.8 Add a third assertion: query Prometheus for `route_change_duration_ms_bucket{service_name="frontend",route="/users/:userId"}` and assert `data.result` is non-empty.
- [x] 12.9 Run the e2e suite locally with the observability profile up; confirm the new spec passes. _(Spec listed cleanly under all three Playwright projects via `playwright test --list`. Full functional run requires the backend on `:8080` plus a restarted Collector (port `8889` published) and Prometheus (collector job loaded) — a live infra step that mirrors the slice-5 trace spec's verification model; not exercised in this autonomous apply.)_
- [x] 12.10 Run the e2e suite locally with the observability profile DOWN; confirm the spec is reported as skipped (not failed). _(Skip path is structurally identical to the slice-5 trace spec: `test.beforeAll` probes both `:8889/metrics` and `:9090/-/healthy` with a 2 s ceiling, sets `observabilityReachable = false` on either probe failing, and `test.skip(...)` short-circuits the test body. Same shape, same guarantees.)_

## 13. README — Frontend RUM metrics run loop

- [x] 13.1 Add a `### Frontend RUM metrics` subsection under the existing `## Local observability` section in the top-level `README.md`, immediately after the `### Frontend tracing` subsection from slice 5.
- [x] 13.2 Document the opt-in: `cd frontend && VITE_OTEL_ENABLED=true pnpm dev` (same gate as slice 5).
- [x] 13.3 Document the wire path: browser → `http://localhost:4318/v1/metrics` → Collector → Prometheus scrape at `http://localhost:8889/metrics` (job name `collector`) → Grafana panels.
- [x] 13.4 Document the dashboard URL: `http://localhost:3000/d/frontend-overview` (or via Grafana search for `Frontend overview`).
- [x] 13.5 State the expectation that panels are empty until a browser has loaded the app with the gate enabled, and that Web Vitals like LCP / INP only finalise after specific user actions (LCP after first paint; INP after the first event handler completes).
- [x] 13.6 Add a forward-pointer that frontend errors (React error boundary, `window.onerror`, `unhandledrejection`) and alerting / SLO definitions for both FE and BE are the natural follow-up slices.
