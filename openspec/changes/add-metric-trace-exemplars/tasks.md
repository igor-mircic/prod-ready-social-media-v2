## 1. Spike: confirm Spring Boot Actuator exemplar plumbing

- [x] 1.1 With the backend running under the OTel Java agent, `curl -H 'Accept: application/openmetrics-text; version=1.0.0' http://localhost:8080/actuator/prometheus` and confirm whether the response is OpenMetrics-shaped today and whether any exemplar lines already appear. Capture the observed Spring Boot and Micrometer versions for the design notes.
  - Spring Boot 4.0.6 (`backend/gradle/libs.versions.toml`), Micrometer 1.16.5, `prometheus-metrics-bom` 1.4.3 (per Spring Boot 4.0.6 BOM). Spring Boot's `PrometheusScrapeEndpoint` already negotiates `application/openmetrics-text` from the `Accept` header — no extra config. No exemplar lines today because no `io.prometheus.metrics.tracer.common.SpanContext` bean is on the context (verified by source reading; live curl deferred to the unit test in 2.3).
- [x] 1.2 Identify the exact Actuator property that toggles exemplar emission for the pinned Spring Boot version (likely `management.prometheus.metrics.export.exemplars-enabled` or `management.observations.tracing.enabled` depending on version) by reading `actuator-autoconfigure` source for the pinned version. Record the chosen property in the design or as a code comment.
  - There is no exemplar property in Spring Boot 4.0.6. `PrometheusMetricsExportAutoConfiguration` injects an `ObjectProvider<SpanContext>` into `PrometheusMeterRegistry`; exemplar emission triggers on bean presence. We register the bean explicitly via `OpenTelemetryAgentSpanContext` (see ExemplarsConfig) — that's the toggle.

## 2. Backend exemplar emission

- [x] 2.1 Enable the chosen Actuator property in `backend/src/main/resources/application.yml` (or `application.properties`) so `/actuator/prometheus` serves exemplars when accessed with `Accept: application/openmetrics-text`.
  - No property exists in Spring Boot 4.0.6 (see 1.2). Configured by registering an `OpenTelemetryAgentSpanContext` bean in `backend/src/main/java/com/prodready/social/observability/ExemplarsConfig.java` instead.
- [x] 2.2 Verify the OTel API is on the runtime classpath at the visibility Micrometer needs (Spring Boot's Actuator already depends on `micrometer-tracing-bridge-otel` in recent versions; if absent for the pinned version, add the smallest dependency that provides the `ExemplarSampler`-OTel bridge).
  - Added `io.prometheus:prometheus-metrics-tracer-otel-agent` (managed by Spring Boot 4.0.6's `prometheus-metrics-bom`). The library is shaded against the OTel Java agent's bootstrap OTel API, so it reads the active span from the agent's own context — the smallest dep that bridges agent → exemplar.
- [x] 2.3 Add a backend unit test that hits the Actuator endpoint with an OpenMetrics `Accept` header (inside a `@SpringBootTest` and a synthetic span via the OTel API) and asserts the response body matches `# {trace_id="[0-9a-f]{32}"}` on at least one `http_server_requests_seconds_bucket` line.
- [x] 2.4 Run `./gradlew :backend:test` and confirm pass.

## 3. Prometheus exemplar storage + scrape

- [x] 3.1 Add a `command:` array to the `prometheus` service in `docker-compose.yml` that includes `--enable-feature=exemplar-storage` plus the image's default `--config.file=/etc/prometheus/prometheus.yml` and `--storage.tsdb.path=/prometheus` so the existing scrape config and TSDB path keep resolving.
- [x] 3.2 With the observability profile up, `curl http://localhost:9090/-/ready` to confirm Prometheus reached ready, then drive one backend request and `curl 'http://localhost:9090/api/v1/query_exemplars?query=http_server_requests_seconds_bucket&start=<NOW-5m>&end=<NOW>'` to confirm at least one exemplar surfaces with a `trace_id` label. Verified: API returned `data[0].exemplars[0].labels.{trace_id,span_id}` for the `/actuator/health` series.

## 4. Grafana provisioning + dashboard wiring

- [x] 4.1 Update `infra/observability/grafana/provisioning/datasources/prometheus.yaml` to add `jsonData.exemplarTraceIdDestinations` with one entry: `{ name: trace_id, datasourceUid: tempo }`. Keep `editable: false` and `isDefault: true` unchanged.
- [x] 4.2 Restart Grafana (`docker-compose --profile observability restart grafana`) and confirm via `curl -u admin:admin http://localhost:3000/api/datasources/name/Prometheus` that the new `exemplarTraceIdDestinations` is reflected in the live datasource config.
- [x] 4.3 Edit `infra/observability/grafana/dashboards/backend-overview.json` to set `options.exemplar = true` on the single panel whose primary query is the `http_server_requests_seconds_bucket` latency histogram. Do not change other panels in this slice.
  - Set per-target `exemplar: true` on each of the three queries on panel id 4 (`p50 / p95 / p99 latency by URI`). Grafana 11's Prometheus datasource accepts this as the "panel-schema-current key for show exemplars" the spec contemplated — the panel-level `options.exemplar` field is not the active toggle for timeseries panels in this version.
- [x] 4.4 Open the dashboard in the browser, generate a couple of requests against the running backend, and confirm exemplar diamonds render on the panel. Click one — it SHOULD open a Tempo trace view with the right trace_id.
  - Verified programmatically (no browser available in autonomous mode): drove 5 backend requests, then queried the same exemplar API Grafana itself uses via the datasource proxy (`/api/datasources/proxy/uid/prometheus/api/v1/query_exemplars`) and got back exemplars with `trace_id`/`span_id` for the bucket series — same data the panel would render as diamonds. The Tempo pivot is wired by the datasource config verified in 4.2.

## 5. End-to-end test

- [x] 5.1 Create `e2e/tests/observability.metric-exemplars.spec.ts`. Follow the slice-5 Tempo polling helper pattern. The spec SHALL `test.skip` (with a descriptive message) when Prometheus on `:9090` or Tempo on `:3200` is unreachable, so a developer running the default profile is not surprised by a failure.
- [x] 5.2 In the spec body: authenticate via the `apiClient`, post once via the UI or apiClient (re-login first if the slow setup risks the 2-second access-token TTL), then poll `http://localhost:9090/api/v1/query_exemplars` at 1-second intervals up to 60 seconds for `http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"}`. Extract one `trace_id`.
  - No re-login needed: signup + login + post all happen in one synchronous burst, well inside the 2-second access-token TTL.
- [x] 5.3 Reuse the slice-5 Tempo polling helper to GET `http://localhost:3200/api/traces/<traceId>` until the response contains at least one `resource.service.name=backend` span (30-second budget, 1-second interval).
- [x] 5.4 Run the spec locally with the full observability profile up and confirm pass. Result: `1 passed (9.7s)` under chromium with the harness backend booted via `bootJar`.
- [x] 5.5 Add the spec to the appropriate Playwright shard so CI exercises it (matching how `observability.frontend-traces.spec.ts` is grouped).
  - There is no shard infrastructure in `playwright.config.ts` — every `tests/*.spec.ts` runs per matrix browser. Dropping the file in `e2e/tests/` is sufficient. The spec self-skips when Prometheus/Tempo are unreachable, matching `observability.frontend-traces.spec.ts`'s "fail quietly when the optional stack is down" behaviour. CI today doesn't bring up the observability profile, so the spec skips in CI.

## 6. Documentation

- [x] 6.1 Add a short "Exemplars" subsection under the existing observability section in the project README. Cover: the docker-compose up command, where to click in Grafana to see exemplars, the Grafana-restart caveat on datasource provisioning changes, and the one-sentence FE-exemplars deferral.
- [x] 6.2 Run `openspec validate add-metric-trace-exemplars --strict` and confirm pass.

## 7. CI and merge

- [ ] 7.1 Commit the change on a branch named `add-metric-trace-exemplars`, push, open a PR. Watch CI through to green (including the new e2e spec).
- [ ] 7.2 Archive the OpenSpec change via `openspec archive add-metric-trace-exemplars` once the PR is approved; re-watch CI on the resulting commit.
- [ ] 7.3 Ask the user before merging the PR.
