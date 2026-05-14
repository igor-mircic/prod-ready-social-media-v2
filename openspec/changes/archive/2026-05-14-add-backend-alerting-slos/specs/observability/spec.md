## ADDED Requirements

### Requirement: Alertmanager is provisioned under the `observability` docker-compose profile and as a Grafana datasource

A single `alertmanager` service runs alongside the existing Prometheus, Tempo, Loki, OTel Collector, and Grafana containers when (and only when) the `observability` profile is selected. Its HTTP API on port `9093` is the canonical alert store: queryable for active alerts and consumed by Grafana via a provisioned datasource. The default `docker-compose up -d postgres` invocation MUST continue to start only Postgres.

#### Scenario: Default invocation still starts only postgres (preserved across slice 8)
- **WHEN** an operator runs `docker-compose up -d postgres` from the repository root
- **THEN** only the `social-postgres` container is started
- **AND** no `social-alertmanager`, `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, or `social-loki` container is started

#### Scenario: Observability profile starts alertmanager alongside the other observability services
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `social-alertmanager` container is started in addition to `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, and `social-loki`
- **AND** the `social-alertmanager` container exposes Alertmanager's HTTP API on host port `9093`

#### Scenario: Alertmanager image tag is pinned
- **WHEN** the docker-compose `alertmanager` service definition is read
- **THEN** the `image:` field is `prom/alertmanager:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: Alertmanager configuration declares a route and a stub receiver
- **WHEN** `infra/observability/alertmanager/alertmanager.yml` is loaded by Alertmanager at startup
- **THEN** the file declares at least one `receivers:` entry (the stub `null` receiver is acceptable for this slice)
- **AND** the top-level `route:` block names a default receiver from that `receivers:` list

#### Scenario: Grafana datasource provisioning declares Alertmanager as non-default
- **WHEN** Grafana provisioning is loaded
- **THEN** `infra/observability/grafana/provisioning/datasources/alertmanager.yaml` declares an Alertmanager datasource targeting `http://alertmanager:9093`
- **AND** the datasource is marked `isDefault: false`
- **AND** the datasource implementation is `alertmanager` (so Grafana's built-in Alerting nav reads from it)

### Requirement: Prometheus rule files live in `infra/observability/prometheus/rules/` and are loaded at startup

Recording and alerting rules SHALL be version-controlled under a dedicated directory next to the existing Prometheus configuration. The Prometheus configuration MUST load them via the `rule_files:` block and MUST declare the Alertmanager target via the `alerting:` block, so rule evaluation and alert routing both happen from a Prometheus restart with no further wiring.

#### Scenario: Prometheus configuration loads the rule files
- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has a `rule_files:` block that references at least `slo-recording.yml` and `slo-alerting.yml` under `infra/observability/prometheus/rules/`

#### Scenario: Prometheus configuration declares the Alertmanager target
- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has an `alerting:` block with `alertmanagers:` containing a `static_configs:` target of `alertmanager:9093` on the shared docker network

#### Scenario: Rule files are mounted into the Prometheus container
- **WHEN** the docker-compose `prometheus` service starts under the `observability` profile
- **THEN** `infra/observability/prometheus/rules/` is mounted read-only into the container at the path referenced by `rule_files:` in `prometheus.yml`

### Requirement: Recording rules compute per-SLO error-budget ratios over canonical windows

Burn-rate alerts are arithmetic on per-window error ratios. A canonical recording rule MUST be emitted for each SLO at each window the alerts need, named following Prometheus's `level:metric:operation` convention. Recording-rule names SHALL be considered part of the public contract because follow-up dashboards and alerts will reference them.

#### Scenario: API availability error ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** the following series exist (one sample per evaluation interval) with the labels `job="backend"`:
  - `job:slo_api_availability:errors_ratio_rate5m`
  - `job:slo_api_availability:errors_ratio_rate30m`
  - `job:slo_api_availability:errors_ratio_rate1h`
  - `job:slo_api_availability:errors_ratio_rate6h`
  - `job:slo_api_availability:errors_ratio_rate3d`
- **AND** each series is defined as `sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*", status=~"5.."}[<window>])) / sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*"}[<window>]))`

#### Scenario: Feed-read latency slow-request ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** series `job:slo_feed_read_latency:slow_ratio_rate<W>` exist for `W` in {`5m`, `30m`, `1h`, `6h`, `3d`}
- **AND** each series is the ratio of `feed_read_duration_seconds_bucket{le="0.2"}` request count to the total `feed_read_duration_seconds_count`, expressed as `1 - good / total` over the window

#### Scenario: Post-create latency slow-request ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** series `job:slo_post_create_latency:slow_ratio_rate<W>` exist for `W` in {`5m`, `30m`, `1h`, `6h`, `3d`}
- **AND** each series is the ratio of `posts_create_duration_seconds_bucket{le="0.5"}` request count to the total `posts_create_duration_seconds_count`, expressed as `1 - good / total` over the window

#### Scenario: Recording-rule names follow the Prometheus convention
- **WHEN** any rule name in `slo-recording.yml` is inspected
- **THEN** the name matches the pattern `<level>:<metric>:<operation>` where `<level>` is `job`, `<metric>` is the slo identifier in snake_case, and `<operation>` describes the aggregation (e.g. `errors_ratio_rate1h`)

### Requirement: Multi-window multi-burn-rate alerts cover the API availability SLO

The API availability SLO is `99.5%` over a `30d` window. Three alert rules MUST fire from the same SLO, each correlating a long-window burn rate with a short-window burn rate so that both the trend and the freshness condition hold. Every alert SHALL carry `severity` and `slo` labels for downstream routing and grouping.

#### Scenario: Fast-burn page fires when 1h and 5m burn rates both exceed 14.4
- **WHEN** `job:slo_api_availability:errors_ratio_rate1h` exceeds `14.4 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate5m` exceeds `14.4 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilityFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="api_availability"`

#### Scenario: Slow-burn page fires when 6h and 30m burn rates both exceed 6
- **WHEN** `job:slo_api_availability:errors_ratio_rate6h` exceeds `6 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate30m` exceeds `6 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilitySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="api_availability"`

#### Scenario: Ticket alert fires when 3d and 6h burn rates both exceed 1
- **WHEN** `job:slo_api_availability:errors_ratio_rate3d` exceeds `1 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate6h` exceeds `1 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilityBudgetBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="ticket"` and `slo="api_availability"`

#### Scenario: No availability alert fires under steady-state synthetic traffic
- **WHEN** synthetic series feed `slo-tests.yml` with constant successful traffic and zero 5xx for 24 simulated hours
- **THEN** none of `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, or `ApiAvailabilityBudgetBurn` enter `firing` state

### Requirement: Multi-window burn-rate alerts cover the feed-read latency SLO

The feed-read latency SLO is `p95 < 200ms` over a `30d` window, modelled as a "fraction of requests slower than 200ms" SLI so the burn-rate math is symmetric to availability. Fast-page and slow-page rules MUST apply; the 3d ticket alert SHALL be omitted for latency SLOs because long-window latency slow-burn is rarely actionable at toy traffic.

#### Scenario: Fast-burn page fires for feed-read latency
- **WHEN** `job:slo_feed_read_latency:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_feed_read_latency:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `FeedReadLatencyFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="feed_read_latency"`

#### Scenario: Slow-burn page fires for feed-read latency
- **WHEN** `job:slo_feed_read_latency:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_feed_read_latency:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `FeedReadLatencySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="feed_read_latency"`

### Requirement: Multi-window burn-rate alerts cover the post-create latency SLO

The post-create latency SLO is `p95 < 500ms` over a `30d` window, modelled identically to feed-read. Fast-page and slow-page rules MUST apply; the 3d ticket alert SHALL be omitted.

#### Scenario: Fast-burn page fires for post-create latency
- **WHEN** `job:slo_post_create_latency:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_post_create_latency:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `PostCreateLatencyFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="post_create_latency"`

#### Scenario: Slow-burn page fires for post-create latency
- **WHEN** `job:slo_post_create_latency:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_post_create_latency:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `PostCreateLatencySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="post_create_latency"`

### Requirement: A non-SLO backend liveness alert covers the scrape target itself

Burn-rate alerts cannot fire when the backend is offline (no samples, no ratios). A dedicated alert MUST cover the "Prometheus has lost the backend target" failure mode. This alert SHALL NOT carry an `slo` label — it is operational, not budget-based.

#### Scenario: BackendDown page fires when the scrape target is unreachable for 2 minutes
- **WHEN** `up{job="backend"} == 0` continuously for 2 minutes in Prometheus
- **THEN** the alert `BackendDown` is in `firing` state
- **AND** the alert carries `severity="page"`
- **AND** the alert does NOT carry an `slo` label

#### Scenario: BackendDown does not fire when the target reports up
- **WHEN** `up{job="backend"} == 1` continuously
- **THEN** the alert `BackendDown` is not in `firing` state

### Requirement: `promtool test rules` proves the alerting logic against synthetic series

A test fixture at `infra/observability/prometheus/rules/slo-tests.yml` MUST feed crafted time series into the recording and alerting rules and assert which alerts are in which state at which simulated time. Every alerting-rule scenario in this spec SHALL correspond to at least one stanza in the fixture. CI MUST invoke `promtool test rules` (via the pinned Prometheus image) and SHALL fail the build on any test failure.

#### Scenario: The fixture lives next to the rule files
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `slo-tests.yml` alongside `slo-recording.yml` and `slo-alerting.yml`

#### Scenario: Every spec-level alerting scenario is covered by a test stanza
- **WHEN** the fixture is read
- **THEN** for each of `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, and `BackendDown` there is at least one test that asserts the alert fires under matching synthetic input
- **AND** for `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, and `ApiAvailabilityBudgetBurn` there is at least one test that asserts no firing under steady-state successful traffic

#### Scenario: CI runs the rule tests and fails on a regression
- **WHEN** CI runs against a branch where any alert no longer fires (or fires spuriously) for its covered scenario
- **THEN** the `promtool test rules` step exits non-zero and the build fails
- **AND** the failure points at the specific test stanza that regressed

### Requirement: README documents the local alerting run loop

The repository README's observability section MUST gain an "Alerting" subsection that names the new surfaces and the command to run rule tests locally — so an operator who pulls the branch can verify the slice without reading the spec.

#### Scenario: README documents the alerting run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9093` as the Alertmanager UI and notes that Grafana's Alerting left-nav also surfaces alerts (via the provisioned Alertmanager datasource)
- **AND** the README documents the one-liner that runs `promtool test rules` against the rule files using the pinned `prom/prometheus` image
- **AND** the README mentions that a Prometheus restart is required after editing rule files for changes to take effect
