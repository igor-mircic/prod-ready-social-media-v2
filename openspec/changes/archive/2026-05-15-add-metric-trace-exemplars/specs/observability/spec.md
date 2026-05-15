## ADDED Requirements

### Requirement: Backend `/actuator/prometheus` endpoint emits OpenMetrics exemplars on the `http.server.requests` histogram

The Spring Boot backend SHALL be configured so that its `/actuator/prometheus` endpoint can serve responses in OpenMetrics text format (`application/openmetrics-text`) and SHALL include exemplar lines on each histogram bucket of `http_server_requests_seconds_bucket` whenever a sample was recorded while an OTel span was active.

Each exemplar line SHALL carry a label named `trace_id` whose value is the 32-lowercase-hex W3C trace id of the active span at sample time. Exemplar lines SHALL also include a `span_id` label (16-lowercase-hex) when the active span context provides one.

The exemplar emission SHALL rely on the Spring Boot Actuator's built-in path: `PrometheusMetricsExportAutoConfiguration` constructs `PrometheusMeterRegistry` with an `ObjectProvider<io.prometheus.metrics.tracer.common.SpanContext>` and queries the bean (when present) on every observation. No bespoke per-meter instrumentation code SHALL be required at recording sites.

The exemplar emission SHALL be enabled by either an Actuator property under `management.*` or by a `@Configuration`-class-registered `SpanContext` bean — whichever the pinned Spring Boot version requires. Under Spring Boot 4.0.6 (the pinned version) no exemplar property exists; emission triggers on bean presence. The smallest dependency providing an OTel-agent-aware `SpanContext` (`io.prometheus:prometheus-metrics-tracer-otel-agent`, shaded against the agent's bootstrap OTel API) MAY be added to the runtime classpath — it is not transitively present via `micrometer-registry-prometheus`.

#### Scenario: OpenMetrics scrape against a running backend returns exemplar lines
- **GIVEN** the backend is running with the OTel Java agent attached and at least one HTTP request has been served while a span was active
- **WHEN** an operator issues `curl -H 'Accept: application/openmetrics-text; version=1.0.0' http://localhost:8080/actuator/prometheus`
- **THEN** the response body contains at least one line of the form `http_server_requests_seconds_bucket{...,le="..."} <count> # {trace_id="<32-hex>"} <value> <timestamp>` for the served request

#### Scenario: Plain Prometheus exposition still works for non-OpenMetrics consumers
- **GIVEN** the backend is running
- **WHEN** an operator issues `curl -H 'Accept: text/plain; version=0.0.4' http://localhost:8080/actuator/prometheus`
- **THEN** the response is valid Prometheus text exposition with no `#` exemplar lines and is accepted by `promtool check metrics`

#### Scenario: Samples recorded outside any active span carry no exemplar
- **GIVEN** the backend records a histogram observation with no OTel span on the current thread
- **WHEN** Prometheus next scrapes the endpoint
- **THEN** the corresponding bucket line in the response carries no exemplar suffix


### Requirement: Prometheus container has exemplar storage enabled and scrapes the backend in OpenMetrics format

The `prometheus` service in `docker-compose.yml` SHALL launch with `--enable-feature=exemplar-storage` in its `command:` array, preserving the image's default config and storage flags (so scrape config and TSDB path continue to resolve).

Prometheus SHALL store at least the default exemplar storage capacity (100,000 exemplars) in memory. No additional retention tuning is required by this slice.

The `backend` scrape job in `infra/observability/prometheus/prometheus.yml` SHALL be configured so that it negotiates the OpenMetrics content type from the Actuator endpoint (i.e. exemplars are not stripped by the scrape).

#### Scenario: Prometheus exposes exemplars via the query_exemplars API
- **GIVEN** Prometheus has been running for at least one scrape interval after the backend has served a request under an active span
- **WHEN** an operator issues `curl 'http://localhost:9090/api/v1/query_exemplars?query=http_server_requests_seconds_bucket&start=<NOW-5m>&end=<NOW>'`
- **THEN** the response JSON has `status=success` and `data` contains at least one exemplar object whose `labels` map includes a `trace_id` key with a 32-hex value

#### Scenario: Prometheus restart with the feature flag present yields no startup error
- **GIVEN** the docker-compose file has `--enable-feature=exemplar-storage` in the `prometheus` service `command:`
- **WHEN** `docker-compose --profile observability up -d prometheus` is run from a clean state
- **THEN** the container reaches a running state and `curl http://localhost:9090/-/ready` returns HTTP 200 within 30 seconds


### Requirement: Grafana Prometheus datasource provisioning links exemplars to the Tempo datasource

The provisioned datasource file `infra/observability/grafana/provisioning/datasources/prometheus.yaml` SHALL declare `jsonData.exemplarTraceIdDestinations` with at minimum one entry whose `name` is `trace_id` and whose `datasourceUid` is `tempo` (the UID under which the Tempo datasource is provisioned per slice 5).

The datasource entry SHALL retain `editable: false` so a Grafana UI edit cannot drift the wiring.

The Grafana container SHALL be restarted to pick up the provisioning change; this requirement SHALL be documented in the slice README delta.

#### Scenario: Grafana datasource API reports the exemplar link
- **GIVEN** Grafana has been (re)started after the provisioning change
- **WHEN** an operator issues `curl -u admin:admin http://localhost:3000/api/datasources/name/Prometheus`
- **THEN** the response JSON contains `jsonData.exemplarTraceIdDestinations` whose entries include `{ "name": "trace_id", "datasourceUid": "tempo" }`


### Requirement: `backend-overview` dashboard enables exemplars on the request-latency panel

The dashboard JSON at `infra/observability/grafana/dashboards/backend-overview.json` SHALL set `options.exemplar = true` (or the panel-schema-current key for "show exemplars") on exactly one panel — the panel whose primary query is the `http_server_requests_seconds_bucket` latency histogram for backend HTTP requests.

Enabling exemplars on other panels is out of scope for this slice and SHALL NOT be done as part of this change.

#### Scenario: Grafana dashboard loads with exemplars enabled on the latency panel
- **GIVEN** Grafana has been (re)started with the updated dashboard JSON
- **WHEN** an operator opens the `Backend overview` dashboard
- **THEN** the request-latency histogram panel renders with exemplar diamonds when at least one matching exemplar exists in the visible time window
- **AND** clicking a diamond opens a panel pivot UI offering "Query with Tempo" using the exemplar's `trace_id`


### Requirement: End-to-end test proves the request → exemplar → trace pivot

A Playwright spec at `e2e/tests/observability.metric-exemplars.spec.ts` SHALL drive a single authenticated `POST /api/v1/posts` request from a real browser session and SHALL assert the metric→trace pivot end-to-end.

The test SHALL:
- authenticate, then issue the post-create call (re-authenticating if the slow setup risks the 2-second access-token TTL),
- poll the Prometheus exemplar API `http://localhost:9090/api/v1/query_exemplars` for `http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"}` within a 60-second budget at 1-second intervals,
- on success, extract a `trace_id` from a returned exemplar,
- GET `http://localhost:3200/api/traces/<traceId>` and assert the returned trace contains at least one span whose `resource.service.name` equals `backend`.

The test SHALL be skipped (not failed) when the observability profile is not running; the slice README delta SHALL document the run loop.

#### Scenario: Posting once yields an exemplar that resolves in Tempo
- **GIVEN** the observability profile is up (Prometheus, Tempo, Collector, Grafana) and the backend is running under the OTel Java agent
- **WHEN** the test issues one authenticated `POST /api/v1/posts`
- **THEN** within 60 seconds the Prometheus exemplar API returns at least one exemplar whose `trace_id` label is a 32-hex string
- **AND** within a further 30 seconds the Tempo trace at that id contains at least one `resource.service.name=backend` span

#### Scenario: Observability profile down → test is skipped
- **GIVEN** the docker-compose observability profile is not running (Prometheus or Tempo is unreachable)
- **WHEN** the spec runs
- **THEN** the spec is marked skipped with a message naming the unreachable service, and the test run does not fail


### Requirement: README documents the local exemplar run loop and known constraints

The slice's contribution to the project README (or its observability subsection) SHALL document:
- the `docker-compose --profile observability` run loop required to exercise exemplars locally,
- the Grafana restart requirement when the Prometheus datasource provisioning changes,
- the click-path: `Backend overview → request latency panel → click an exemplar diamond → Tempo trace view`,
- the FE-exemplars deferral (one sentence is sufficient: the Collector's prometheus exporter does not synthesize exemplars from FE OTLP histograms in this slice).

#### Scenario: README enumerates the click-path and the restart caveat
- **WHEN** a reader follows the README's observability section after this slice lands
- **THEN** the reader is told how to bring the stack up, where to click in Grafana to see exemplars, and that a Grafana restart is required when datasource provisioning changes
- **AND** the FE-exemplars deferral is mentioned in one sentence so the absence is not surprising
