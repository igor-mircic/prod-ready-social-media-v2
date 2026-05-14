# observability — delta for add-frontend-rum-metrics

## ADDED Requirements

### Requirement: Frontend pins the Web Vitals library and OTel browser metrics SDK packages

The `frontend/` project SHALL pin the following packages in `frontend/package.json` as runtime dependencies: `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`. Each coordinate SHALL be pinned with an explicit, non-`latest` version range. The packages SHALL be imported only from files under `frontend/src/observability/`.

#### Scenario: New SDK packages are pinned with explicit versions

- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block declares each of `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`
- **AND** each coordinate's version range starts with a digit, a caret, or a tilde-with-bound (NOT `latest`, NOT `*`).

#### Scenario: Application source has no compile-time dependency on the new packages outside the observability module

- **WHEN** a reader greps `frontend/src/` for `import .* from ['"]web-vitals` or `import .* from ['"]@opentelemetry/sdk-metrics` or `import .* from ['"]@opentelemetry/exporter-metrics-otlp-http`
- **THEN** every match's file path starts with `frontend/src/observability/`.

### Requirement: Frontend bootstraps an OTel `MeterProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The frontend SHALL declare a module `frontend/src/observability/meter.ts` exporting one function `bootstrapMetrics(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, register a `MeterProvider` whose `Resource` is the shared `Resource` instance exported by `frontend/src/observability/resource.ts` (carrying at minimum `service.name="frontend"` and `service.version`);
- register a `PeriodicExportingMetricReader` whose exporter is an `OTLPMetricExporter` whose URL defaults to `http://localhost:4318/v1/metrics` and is overridable via `import.meta.env.VITE_OTEL_METRICS_ENDPOINT`;
- set the reader's export interval from `import.meta.env.VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` if defined as a positive integer, otherwise default to `15000` (15 s, matching Prometheus's `scrape_interval`);
- write exactly one console line of the form `OTel telemetry enabled: metrics → <endpoint>` when boot succeeds.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapMetrics()` synchronously after `bootstrapTelemetry()` and before `createRoot(...)`.

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapMetrics()` runs
- **THEN** no OTel `MeterProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled: metrics →` is written
- **AND** no outbound POST to `/v1/metrics` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the meter provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: metrics → <endpoint>`
- **AND** at least one POST to `<endpoint>` is observed within `2 * exportIntervalMillis` (i.e. within 30 s at the default).

#### Scenario: Bootstrap runs after `bootstrapTelemetry()` and before `createRoot(...)`

- **WHEN** a reader inspects `frontend/src/main.tsx`
- **THEN** the call to `bootstrapTelemetry()` precedes the call to `bootstrapMetrics()`
- **AND** both calls precede the call to `createRoot(...)`.

### Requirement: Frontend traces and metrics share one OTel `Resource` instance

The frontend SHALL declare a module `frontend/src/observability/resource.ts` exporting exactly one `Resource` instance carrying at minimum `service.name="frontend"` and `service.version=<value of import.meta.env.VITE_APP_VERSION>` (defaulting to the string `unknown` when the env var is absent). Both `frontend/src/observability/tracer.ts` and `frontend/src/observability/meter.ts` SHALL import that shared `Resource` rather than construct their own.

#### Scenario: `tracer.ts` imports the shared resource

- **WHEN** a reader inspects `frontend/src/observability/tracer.ts`
- **THEN** the file imports the shared `Resource` instance from `./resource`
- **AND** the file does NOT call `resourceFromAttributes(...)` directly with `service.name` or `service.version`.

#### Scenario: `meter.ts` imports the shared resource

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** the file imports the shared `Resource` instance from `./resource`
- **AND** the file does NOT call `resourceFromAttributes(...)` directly with `service.name` or `service.version`.

### Requirement: Web Vitals are recorded as histograms via the official `web-vitals` library

When metrics are enabled, `bootstrapMetrics()` SHALL register handlers `onLCP`, `onCLS`, `onINP`, `onFCP`, and `onTTFB` from the `web-vitals` package. Each handler's callback SHALL record the metric's `value` into a Histogram instrument whose name follows the pattern `web_vitals_<lowercase metric name>` (so: `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp`, `web_vitals_fcp`, `web_vitals_ttfb`). The instruments SHALL NOT declare any per-event attributes; only the meter's shared `Resource` attributes apply.

The Web Vitals reporter SHALL be called in `reportAllChanges: false` mode (one final value per metric per page load), matching the Google-published default.

#### Scenario: LCP observation lands as a histogram bucket increment

- **GIVEN** the frontend is loaded with metrics enabled
- **AND** the OTel metrics exporter has flushed at least once after a page load
- **WHEN** a reader inspects the Collector's `/metrics` scrape body
- **THEN** at least one line whose name starts with `web_vitals_lcp_bucket` is present
- **AND** the line carries the label `service_name="frontend"`.

#### Scenario: Web Vitals instruments carry no per-event attributes

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** no call to `histogram.record(...)` for a Web Vitals histogram passes a non-empty attributes object
- **AND** the only resource attributes on the data points are `service.name` and `service.version` (and OTel SDK defaults).

### Requirement: Route-transition duration is recorded with a route-template label

The frontend SHALL declare a component `frontend/src/observability/route-timing.tsx` exporting `<RouteTimingObserver />`. The component SHALL subscribe to React Router's `useLocation()` and, on every pathname change after the initial render, SHALL record the duration from `performance.now()` at the previous transition (or from `performance.timeOrigin`-relative navigation start on the first transition) into a Histogram instrument named `route_change_duration_ms`. The instrument SHALL be labelled by exactly one attribute `route` whose value is the matched React Router `path` template (e.g. `/home`, `/users/:userId`, `/login`), NOT the resolved pathname. When no matching route is found, the label value SHALL be the literal string `unknown`.

The component SHALL be rendered exactly once inside `<BrowserRouter>` in `frontend/src/App.tsx`, and SHALL render `null`.

#### Scenario: Navigation increments the route-timing histogram with a route-template label

- **GIVEN** the frontend is loaded with metrics enabled
- **AND** a user is on `/home`
- **WHEN** the user navigates to `/users/abc-123`
- **AND** the OTel metrics exporter flushes
- **THEN** the Collector's `/metrics` body contains at least one line for `route_change_duration_ms_bucket` carrying the label `route="/users/:userId"`
- **AND** no line carries the label `route="/users/abc-123"`.

#### Scenario: Observer renders nothing visible

- **WHEN** a reader inspects the DOM after `<RouteTimingObserver />` mounts
- **THEN** the component contributes no rendered nodes.

#### Scenario: Observer lives inside `<BrowserRouter>`

- **WHEN** a reader inspects `frontend/src/App.tsx`
- **THEN** `<RouteTimingObserver />` is rendered as a descendant of `<BrowserRouter>`.

### Requirement: Long-task durations are recorded via the Performance Observer

When metrics are enabled, `bootstrapMetrics()` SHALL register a `PerformanceObserver` of type `longtask` with `buffered: true`. Each entry's `duration` SHALL be recorded into a Histogram instrument named `long_task_duration_ms`. The instrument SHALL declare no per-entry attributes; only the meter's shared `Resource` attributes apply. If the `longtask` performance entry type is unsupported in the current browser (`PerformanceObserver.supportedEntryTypes` does not include `longtask`), `bootstrapMetrics()` SHALL skip registration silently and continue with the rest of the bootstrap.

#### Scenario: A long task records into the histogram

- **GIVEN** the frontend is loaded with metrics enabled in a browser that supports `longtask`
- **AND** a synthetic main-thread block of at least 60 ms is forced (e.g. a busy-wait loop in a click handler)
- **WHEN** the OTel metrics exporter flushes
- **THEN** the Collector's `/metrics` body contains at least one line for `long_task_duration_ms_bucket` whose `service_name` label equals `frontend`.

#### Scenario: Unsupported browser silently skips registration

- **GIVEN** a browser whose `PerformanceObserver.supportedEntryTypes` does not include `longtask`
- **WHEN** the frontend boots with metrics enabled
- **THEN** no exception is thrown
- **AND** the rest of `bootstrapMetrics()` (Web Vitals, route timing) registers successfully.

### Requirement: OTel Collector exposes FE metrics via a `prometheus` exporter on `:8889`

The OTel Collector configuration at `infra/observability/collector/collector-config.yaml` SHALL declare a new pipeline `metrics` with:

- the existing `otlp` receiver (no CORS change required — slice 5's allowlist on `:4318` already covers the metrics endpoint at `/v1/metrics`);
- the `batch` processor (existing);
- a new `prometheus` exporter listening on `0.0.0.0:8889` with `add_metric_suffixes: false` and `namespace: ""` so emitted metric names are preserved verbatim.

The Collector compose entry in `docker-compose.yml` SHALL publish container port `8889` to host port `8889` so the Prometheus container (and `curl` on the developer's loopback) can reach the exporter.

#### Scenario: Collector exposes a Prometheus scrape endpoint on `:8889`

- **GIVEN** the observability docker-compose profile is up
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response status is 200
- **AND** the `Content-Type` header starts with `text/plain` (Prometheus text-exposition format).

#### Scenario: Emitted metric names carry no Collector-added prefix

- **GIVEN** a browser has flushed at least one OTLP metrics export to the Collector
- **WHEN** a reader inspects the body of `GET http://localhost:8889/metrics`
- **THEN** at least one line begins with `web_vitals_lcp_bucket`
- **AND** no line begins with `otelcol_web_vitals_` or any other Collector-injected prefix.

### Requirement: Collector drops FE metric data points with high-cardinality route labels

The Collector configuration SHALL declare a `filter/drop_high_cardinality` processor in the `metrics` pipeline (between `batch` and `prometheus` exporter) that drops any data point whose `route` attribute matches an unredacted-id pattern: `[0-9a-f]{8,}`, `/[0-9]{4,}/`, or a UUID v4. This guard is defense-in-depth; the primary cardinality control is in `route-timing.tsx` (Requirement: "Route-transition duration is recorded with a route-template label").

#### Scenario: A leaked id-bearing route attribute is dropped at the Collector

- **GIVEN** the Collector configuration declares the `filter/drop_high_cardinality` processor
- **AND** a (hypothetical) data point with `route="/users/abc-123-def-456-7890"` is received via OTLP
- **WHEN** the Collector evaluates the processor
- **THEN** the data point is dropped before reaching the `prometheus` exporter
- **AND** no Prometheus query returns a sample carrying `route="/users/abc-123-def-456-7890"`.

#### Scenario: A clean route-template attribute passes through

- **GIVEN** a data point with `route="/users/:userId"` is received via OTLP
- **WHEN** the Collector evaluates the processor
- **THEN** the data point is forwarded to the `prometheus` exporter unchanged.

### Requirement: Prometheus scrapes the Collector as a new `collector` job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL declare a second scrape job named `collector` with `metrics_path: /metrics`, `scrape_interval: 15s`, and `static_configs.targets: ["collector:8889"]`. The existing `backend` job SHALL remain unchanged.

#### Scenario: Prometheus reports the collector target as up

- **GIVEN** the observability profile is up and the Collector is running
- **WHEN** a reader issues `GET http://localhost:9090/api/v1/targets`
- **THEN** the response body contains a target whose `labels.job` is `collector`
- **AND** that target's `health` is `up`.

#### Scenario: Prometheus query returns FE Web Vitals samples after browser traffic

- **GIVEN** at least one browser has loaded the app with metrics enabled and the page has been visible long enough for `web-vitals` to finalise the LCP metric (typically < 5 s after first paint)
- **AND** at least one Collector → Prometheus scrape cycle has completed
- **WHEN** a reader queries `GET http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}`
- **THEN** the response's `data.result` array is non-empty.

### Requirement: Grafana provisions a `Frontend overview` dashboard

The repository SHALL include a Grafana dashboard JSON file at `infra/observability/grafana/dashboards/frontend-overview.json` picked up by the existing provisioning provider in `infra/observability/grafana/provisioning/dashboards/dashboards.yaml`. The dashboard SHALL contain at minimum four rows of panels:

- **Web Vitals**: time-series or stat panels for `web_vitals_lcp` p75, `web_vitals_cls` p75, `web_vitals_inp` p75, `web_vitals_fcp` p75, and `web_vitals_ttfb` p75 — each filtered to `service_name="frontend"`.
- **Route timing**: a time-series panel for `route_change_duration_ms` p50/p95/p99, grouped by the `route` label.
- **Long tasks**: a time-series panel for the rate of `long_task_duration_ms_count` and a time-series panel for the rate-of-sum of `long_task_duration_ms_sum`.
- **Browser request volume**: a time-series panel for the rate of `web_vitals_lcp_count` per minute, used as a session-rate proxy.

The dashboard SHALL declare its data source as the existing provisioned Prometheus datasource, NOT a hard-coded datasource UID.

#### Scenario: Provisioning surface exposes the new dashboard

- **GIVEN** the observability profile is up
- **WHEN** a reader issues `GET http://localhost:3000/api/search?query=Frontend%20overview`
- **THEN** the response body contains an entry whose `title` is `Frontend overview`.

#### Scenario: Dashboard JSON references the Prometheus datasource by name, not by hard-coded UID

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** every panel's `datasource` block either omits the `uid` field or uses the templated form `${DS_PROMETHEUS}` resolved by provisioning.

### Requirement: End-to-end test proves the FE → Collector → Prometheus metrics pipeline

The repository SHALL include a Playwright spec at `e2e/tests/observability.frontend-rum-metrics.spec.ts` that drives one authenticated session through the home page and at least one route transition, then asserts the full metrics chain. The spec SHALL be skipped (via `test.skip(...)`) when either of `http://localhost:8889/metrics` or `http://localhost:9090/-/healthy` is unreachable, mirroring the slice-5 pattern that allows the suite to stay green when the observability profile is not running.

#### Scenario: Collector scrape endpoint carries FE-emitted series

- **GIVEN** the observability profile is up
- **AND** the spec has driven one authenticated session through `/home` and at least one navigation to `/users/{id}`
- **WHEN** the spec polls `http://localhost:8889/metrics` after the Collector's batch flush interval has elapsed
- **THEN** the response body contains at least one line beginning with `web_vitals_lcp_bucket` carrying `service_name="frontend"`
- **AND** the response body contains at least one line beginning with `route_change_duration_ms_bucket` carrying both `service_name="frontend"` and a `route` label whose value is a route template (no resolved id).

#### Scenario: Prometheus query returns the FE-emitted series

- **GIVEN** the spec has driven the same authenticated traffic
- **AND** at least 30 s have elapsed since the first observation (one export interval plus one scrape interval)
- **WHEN** the spec queries `GET http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}`
- **THEN** `data.result` is a non-empty array.

#### Scenario: Spec is skipped cleanly when observability is not running

- **GIVEN** the docker-compose `observability` profile is NOT up
- **AND** either `http://localhost:8889/metrics` or `http://localhost:9090/-/healthy` returns a network error
- **WHEN** the spec runs
- **THEN** every test case in the file reports as `skipped`, not `failed`.

### Requirement: README documents the local frontend RUM run loop

The repository's root `README.md` SHALL contain a subsection `### Frontend RUM metrics` under the existing `## Local observability` section. The subsection SHALL document at minimum:

- the `VITE_OTEL_ENABLED=true pnpm dev` opt-in;
- that browser metrics post to `http://localhost:4318/v1/metrics` (the OTel Collector's OTLP/HTTP endpoint, same port as slice 5 traces);
- that the Collector exposes the FE metrics on `http://localhost:8889/metrics`;
- the URL of the provisioned dashboard: `http://localhost:3000/d/frontend-overview` (or via Grafana search for the title `Frontend overview`);
- the expectation that panels are empty until a browser session has loaded the app with the gate enabled.

#### Scenario: README has a Frontend RUM subsection under Local observability

- **WHEN** a reader greps `README.md` for `### Frontend RUM metrics`
- **THEN** exactly one match is returned
- **AND** that match's nearest enclosing `##` header is `## Local observability` (or an equivalent existing observability section).

#### Scenario: README cites the new Collector scrape port

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text mentions the literal string `localhost:8889/metrics` at least once.
