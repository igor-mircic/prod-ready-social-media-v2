## 1. Spike: confirm Spring Boot Actuator exemplar plumbing

- [ ] 1.1 With the backend running under the OTel Java agent, `curl -H 'Accept: application/openmetrics-text; version=1.0.0' http://localhost:8080/actuator/prometheus` and confirm whether the response is OpenMetrics-shaped today and whether any exemplar lines already appear. Capture the observed Spring Boot and Micrometer versions for the design notes.
- [ ] 1.2 Identify the exact Actuator property that toggles exemplar emission for the pinned Spring Boot version (likely `management.prometheus.metrics.export.exemplars-enabled` or `management.observations.tracing.enabled` depending on version) by reading `actuator-autoconfigure` source for the pinned version. Record the chosen property in the design or as a code comment.

## 2. Backend exemplar emission

- [ ] 2.1 Enable the chosen Actuator property in `backend/src/main/resources/application.yml` (or `application.properties`) so `/actuator/prometheus` serves exemplars when accessed with `Accept: application/openmetrics-text`.
- [ ] 2.2 Verify the OTel API is on the runtime classpath at the visibility Micrometer needs (Spring Boot's Actuator already depends on `micrometer-tracing-bridge-otel` in recent versions; if absent for the pinned version, add the smallest dependency that provides the `ExemplarSampler`-OTel bridge).
- [ ] 2.3 Add a backend unit test that hits the Actuator endpoint with an OpenMetrics `Accept` header (inside a `@SpringBootTest` and a synthetic span via the OTel API) and asserts the response body matches `# {trace_id="[0-9a-f]{32}"}` on at least one `http_server_requests_seconds_bucket` line.
- [ ] 2.4 Run `./gradlew :backend:test` and confirm pass.

## 3. Prometheus exemplar storage + scrape

- [ ] 3.1 Add a `command:` array to the `prometheus` service in `docker-compose.yml` that includes `--enable-feature=exemplar-storage` plus the image's default `--config.file=/etc/prometheus/prometheus.yml` and `--storage.tsdb.path=/prometheus` so the existing scrape config and TSDB path keep resolving.
- [ ] 3.2 With the observability profile up, `curl http://localhost:9090/-/ready` to confirm Prometheus reached ready, then drive one backend request and `curl 'http://localhost:9090/api/v1/query_exemplars?query=http_server_requests_seconds_bucket&start=<NOW-5m>&end=<NOW>'` to confirm at least one exemplar surfaces with a `trace_id` label.

## 4. Grafana provisioning + dashboard wiring

- [ ] 4.1 Update `infra/observability/grafana/provisioning/datasources/prometheus.yaml` to add `jsonData.exemplarTraceIdDestinations` with one entry: `{ name: trace_id, datasourceUid: tempo }`. Keep `editable: false` and `isDefault: true` unchanged.
- [ ] 4.2 Restart Grafana (`docker-compose --profile observability restart grafana`) and confirm via `curl -u admin:admin http://localhost:3000/api/datasources/name/Prometheus` that the new `exemplarTraceIdDestinations` is reflected in the live datasource config.
- [ ] 4.3 Edit `infra/observability/grafana/dashboards/backend-overview.json` to set `options.exemplar = true` on the single panel whose primary query is the `http_server_requests_seconds_bucket` latency histogram. Do not change other panels in this slice.
- [ ] 4.4 Open the dashboard in the browser, generate a couple of requests against the running backend, and confirm exemplar diamonds render on the panel. Click one — it SHOULD open a Tempo trace view with the right trace_id.

## 5. End-to-end test

- [ ] 5.1 Create `e2e/tests/observability.metric-exemplars.spec.ts`. Follow the slice-5 Tempo polling helper pattern. The spec SHALL `test.skip` (with a descriptive message) when Prometheus on `:9090` or Tempo on `:3200` is unreachable, so a developer running the default profile is not surprised by a failure.
- [ ] 5.2 In the spec body: authenticate via the `apiClient`, post once via the UI or apiClient (re-login first if the slow setup risks the 2-second access-token TTL), then poll `http://localhost:9090/api/v1/query_exemplars` at 1-second intervals up to 60 seconds for `http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"}`. Extract one `trace_id`.
- [ ] 5.3 Reuse the slice-5 Tempo polling helper to GET `http://localhost:3200/api/traces/<traceId>` until the response contains at least one `resource.service.name=backend` span (30-second budget, 1-second interval).
- [ ] 5.4 Run the spec locally with the full observability profile up and confirm pass.
- [ ] 5.5 Add the spec to the appropriate Playwright shard so CI exercises it (matching how `observability.frontend-traces.spec.ts` is grouped).

## 6. Documentation

- [ ] 6.1 Add a short "Exemplars" subsection under the existing observability section in the project README. Cover: the docker-compose up command, where to click in Grafana to see exemplars, the Grafana-restart caveat on datasource provisioning changes, and the one-sentence FE-exemplars deferral.
- [ ] 6.2 Run `openspec validate add-metric-trace-exemplars --strict` and confirm pass.

## 7. CI and merge

- [ ] 7.1 Commit the change on a branch named `add-metric-trace-exemplars`, push, open a PR. Watch CI through to green (including the new e2e spec).
- [ ] 7.2 Archive the OpenSpec change via `openspec archive add-metric-trace-exemplars` once the PR is approved; re-watch CI on the resulting commit.
- [ ] 7.3 Ask the user before merging the PR.
