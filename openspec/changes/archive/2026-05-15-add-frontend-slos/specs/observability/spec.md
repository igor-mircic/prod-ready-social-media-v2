## ADDED Requirements

### Requirement: Frontend Web Vitals histograms carry explicit bucket boundaries aligned with SLO thresholds

The `frontend/src/observability/meter.ts` module SHALL configure the OTel `web_vitals_lcp` and `web_vitals_inp` Histogram instruments with explicit bucket boundaries that include the slice's SLO thresholds (2500 ms for LCP, 200 ms for INP), so that the Prometheus recording rules can read precise slow-fraction series via the `le="2500"` and `le="200"` buckets. The boundaries SHALL be set via the OTel JS SDK's instrument-level explicit-bucket mechanism (per-instrument `advice.explicitBucketBoundaries`, or an equivalent `view` registered on the `MeterProvider` configured with `ExplicitBucketHistogramAggregation`).

The bucket boundaries SHALL be:

- `web_vitals_lcp`: `[500, 1000, 1500, 2000, 2500, 3500, 5000, 7500, 10000]` (milliseconds)
- `web_vitals_inp`: `[25, 50, 75, 100, 150, 200, 300, 500, 1000]` (milliseconds)

The `web_vitals_cls`, `web_vitals_fcp`, and `web_vitals_ttfb` instruments SHALL keep the OTel SDK default boundaries — this slice does not modify their histogram grid.

#### Scenario: LCP histogram exposes a `le="2500"` bucket at the Collector scrape endpoint

- **GIVEN** the observability profile is up and metrics are enabled in the browser
- **AND** at least one browser session has loaded the app and the OTel metrics exporter has flushed
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response body contains at least one line matching `web_vitals_lcp_bucket{...,le="2500",...}` with `service_name="frontend"`

#### Scenario: INP histogram exposes a `le="200"` bucket at the Collector scrape endpoint

- **GIVEN** the observability profile is up and metrics are enabled in the browser
- **AND** at least one interaction has been recorded by the `web-vitals` `onINP` callback
- **AND** the OTel metrics exporter has flushed
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response body contains at least one line matching `web_vitals_inp_bucket{...,le="200",...}` with `service_name="frontend"`

#### Scenario: Bucket boundaries are configured at the instrument or view level, not as a manual histogram-record loop

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** the LCP and INP histograms are configured with explicit boundaries via either an `advice` parameter on the Histogram instrument or a `View` registered on the `MeterProvider` with `ExplicitBucketHistogramAggregation`
- **AND** no per-callback bucket math is performed in user space

#### Scenario: CLS, FCP, TTFB histograms remain unmodified by this slice

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** no explicit bucket boundaries are configured for the `web_vitals_cls`, `web_vitals_fcp`, or `web_vitals_ttfb` instruments

### Requirement: Frontend SLO recording rules compute LCP and INP slow-fractions over canonical windows

A Prometheus rule file at `infra/observability/prometheus/rules/fe-slo-recording.yml` SHALL declare recording rules that compute per-SLO slow-request ratios for the two frontend timing SLOs (LCP, INP) over the canonical windows used by the multi-window burn-rate alerts. Recording-rule names SHALL follow the Prometheus `<level>:<metric>:<operation>` convention and SHALL keep the `job:` prefix for symmetry with backend SLO recording rules, even though the underlying samples carry `job="collector"`. Rule expressions SHALL filter on `service_name="frontend"`.

#### Scenario: LCP slow-fraction is recorded at every required window

- **WHEN** Prometheus evaluates `fe-slo-recording.yml`
- **THEN** series `job:slo_lcp:slow_ratio_rate<W>` exist (one sample per evaluation interval) for `W` in {`5m`, `30m`, `1h`, `6h`}
- **AND** each series is defined as `1 - (sum(rate(web_vitals_lcp_bucket{service_name="frontend", le="2500"}[<window>])) / sum(rate(web_vitals_lcp_count{service_name="frontend"}[<window>])))`

#### Scenario: INP slow-fraction is recorded at every required window

- **WHEN** Prometheus evaluates `fe-slo-recording.yml`
- **THEN** series `job:slo_inp:slow_ratio_rate<W>` exist (one sample per evaluation interval) for `W` in {`5m`, `30m`, `1h`, `6h`}
- **AND** each series is defined as `1 - (sum(rate(web_vitals_inp_bucket{service_name="frontend", le="200"}[<window>])) / sum(rate(web_vitals_inp_count{service_name="frontend"}[<window>])))`

#### Scenario: Recording-rule names follow the Prometheus convention

- **WHEN** any rule name in `fe-slo-recording.yml` is inspected
- **THEN** the name matches the pattern `job:<slo identifier>:slow_ratio_rate<window>` where `<slo identifier>` is `slo_lcp` or `slo_inp`

### Requirement: Multi-window burn-rate alerts cover the LCP SLO

The LCP SLO is `95% of page loads have web_vitals_lcp < 2500 ms` over a `30d` window. Two alert rules SHALL fire from this SLO — a fast-burn and a slow-burn page — each correlating a long-window burn rate with a short-window burn rate. Every alert SHALL carry `severity`, `slo`, and `service` labels for downstream routing and grouping. The 3d ticket alert is omitted, matching the backend latency SLOs.

#### Scenario: Fast-burn page fires when 1h and 5m burn rates both exceed 14.4

- **WHEN** `job:slo_lcp:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_lcp:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `LcpSloFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="lcp"`, and `service="frontend"`

#### Scenario: Slow-burn page fires when 6h and 30m burn rates both exceed 6

- **WHEN** `job:slo_lcp:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_lcp:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `LcpSloSlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="lcp"`, and `service="frontend"`

#### Scenario: No LCP alert fires under steady-state synthetic traffic

- **WHEN** synthetic series feed `fe-slo-tests.yml` with constant fast-LCP traffic (all samples within `le="2500"`) for 24 simulated hours
- **THEN** neither `LcpSloFastBurn` nor `LcpSloSlowBurn` enters `firing` state

### Requirement: Multi-window burn-rate alerts cover the INP SLO

The INP SLO is `95% of interactions have web_vitals_inp < 200 ms` over a `30d` window. Two alert rules SHALL fire from this SLO — a fast-burn and a slow-burn page — using the same burn-rate constants as the LCP SLO. Every alert SHALL carry `severity`, `slo`, and `service` labels. The 3d ticket alert is omitted.

#### Scenario: Fast-burn page fires when 1h and 5m INP burn rates both exceed 14.4

- **WHEN** `job:slo_inp:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_inp:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `InpSloFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="inp"`, and `service="frontend"`

#### Scenario: Slow-burn page fires when 6h and 30m INP burn rates both exceed 6

- **WHEN** `job:slo_inp:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_inp:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `InpSloSlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="inp"`, and `service="frontend"`

#### Scenario: No INP alert fires under steady-state synthetic traffic

- **WHEN** synthetic series feed `fe-slo-tests.yml` with constant fast-INP traffic (all samples within `le="200"`) for 24 simulated hours
- **THEN** neither `InpSloFastBurn` nor `InpSloSlowBurn` enters `firing` state

### Requirement: `promtool test rules` proves the frontend SLO alerting logic against synthetic series

A test fixture at `infra/observability/prometheus/rules/fe-slo-tests.yml` SHALL feed crafted time series into the FE recording and alerting rules and assert which alerts are in which state at which simulated time. Every alerting-rule scenario for the FE SLOs in this spec SHALL correspond to at least one stanza in the fixture. CI SHALL run `promtool test rules` against this fixture (alongside the existing backend `slo-tests.yml`) and SHALL fail the build on any test failure.

#### Scenario: The fixture lives next to the rule files

- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `fe-slo-tests.yml` alongside `fe-slo-recording.yml`, `fe-slo-alerting.yml`, and the existing backend rule files

#### Scenario: Every FE-SLO alerting scenario is covered by a test stanza

- **WHEN** the fixture is read
- **THEN** for each of `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` there is at least one test stanza that asserts the alert fires under matching synthetic input
- **AND** for each of those alerts there is at least one steady-state stanza that asserts no firing

#### Scenario: CI runs the FE rule tests and fails on a regression

- **WHEN** CI runs against a branch where any FE SLO alert no longer fires (or fires spuriously) for its covered scenario
- **THEN** the `promtool test rules` step exits non-zero and the build fails
- **AND** the failure points at the specific test stanza that regressed

### Requirement: README documents the frontend SLO surface

The repository's root `README.md` Frontend RUM subsection (added in slice 6) SHALL gain a paragraph naming the four FE SLO alerts (`LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`), citing their SLO targets (LCP 95% < 2500 ms, INP 95% < 200 ms over 30 d), pointing at the SLO row of the `Frontend overview` dashboard, and reminding the operator that Prometheus needs a restart after editing rule files (mirroring the guidance from the slice 8 alerting subsection).

#### Scenario: README cites the four FE alert names

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text contains the literal strings `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` (each at least once)

#### Scenario: README cites the SLO targets

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text mentions the literal strings `95%`, `2500`, and `200` in the context of the LCP and INP SLOs

#### Scenario: README reminds the operator that Prometheus needs a restart after rule changes

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text states that Prometheus must be restarted for `rule_files:` changes to take effect

## MODIFIED Requirements

### Requirement: Prometheus rule files live in `infra/observability/prometheus/rules/` and are loaded at startup

Recording and alerting rules SHALL be version-controlled under a dedicated directory next to the existing Prometheus configuration. The Prometheus configuration MUST load them via the `rule_files:` block and MUST declare the Alertmanager target via the `alerting:` block, so rule evaluation and alert routing both happen from a Prometheus restart with no further wiring. The `rule_files:` block MUST include the frontend SLO rule files (`fe-slo-recording.yml`, `fe-slo-alerting.yml`) alongside the existing backend rule files (`slo-recording.yml`, `slo-alerting.yml`).

#### Scenario: Prometheus configuration loads the rule files

- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has a `rule_files:` block that references at least `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, and `fe-slo-alerting.yml` under `infra/observability/prometheus/rules/`

#### Scenario: Prometheus configuration declares the Alertmanager target

- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has an `alerting:` block with `alertmanagers:` containing a `static_configs:` target of `alertmanager:9093` on the shared docker network

#### Scenario: Rule files are mounted into the Prometheus container

- **WHEN** the docker-compose `prometheus` service starts under the `observability` profile
- **THEN** `infra/observability/prometheus/rules/` is mounted read-only into the container at the path referenced by `rule_files:` in `prometheus.yml`

#### Scenario: Frontend SLO rule files appear in the Prometheus rules API

- **GIVEN** the observability profile is up and Prometheus has loaded the rule files
- **WHEN** a reader issues `GET http://localhost:9090/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field matches the mounted path for `fe-slo-recording.yml` and `fe-slo-alerting.yml`
- **AND** the groups together declare the recording rules `job:slo_lcp:slow_ratio_rate1h` and `job:slo_inp:slow_ratio_rate1h` and the alerting rules `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`

### Requirement: Grafana provisions a `Frontend overview` dashboard

The repository SHALL include a Grafana dashboard JSON file at `infra/observability/grafana/dashboards/frontend-overview.json` picked up by the existing provisioning provider in `infra/observability/grafana/provisioning/dashboards/dashboards.yaml`. The dashboard SHALL contain at minimum five rows of panels:

- **Web Vitals**: time-series or stat panels for `web_vitals_lcp` p75, `web_vitals_cls` p75, `web_vitals_inp` p75, `web_vitals_fcp` p75, and `web_vitals_ttfb` p75 — each filtered to `service_name="frontend"`.
- **Route timing**: a time-series panel for `route_change_duration_ms` p50/p95/p99, grouped by the `route` label.
- **Long tasks**: a time-series panel for the rate of `long_task_duration_ms_count` and a time-series panel for the rate-of-sum of `long_task_duration_ms_sum`.
- **Browser request volume**: a time-series panel for the rate of `web_vitals_lcp_count` per minute, used as a session-rate proxy.
- **SLO**: at minimum four panels covering the LCP and INP SLOs:
  - A stat panel showing LCP "error budget headroom (last 6 h)" computed as `1 - (job:slo_lcp:slow_ratio_rate6h / (1 - 0.95))`, with the panel title or description making the 6 h window explicit.
  - A stat panel showing INP "error budget headroom (last 6 h)" computed as `1 - (job:slo_inp:slow_ratio_rate6h / (1 - 0.95))`, with the panel title or description making the 6 h window explicit.
  - A time-series panel showing the current 1 h burn rate for LCP and INP — one line per SLO, computed as `job:slo_lcp:slow_ratio_rate1h / (1 - 0.95)` and `job:slo_inp:slow_ratio_rate1h / (1 - 0.95)`.
  - A time-series panel showing `histogram_quantile(0.75, sum(rate(web_vitals_lcp_bucket{service_name="frontend"}[5m])) by (le))` and the matching INP query, with a static reference line at 2500 (LCP) and 200 (INP) drawn as a threshold.

The dashboard SHALL declare its data source as the existing provisioned Prometheus datasource, NOT a hard-coded datasource UID. The existing rows (Web Vitals, Route timing, Long tasks, Browser request volume) SHALL be preserved without behavioral change.

#### Scenario: Provisioning surface exposes the dashboard

- **GIVEN** the observability profile is up
- **WHEN** a reader issues `GET http://localhost:3000/api/search?query=Frontend%20overview`
- **THEN** the response body contains an entry whose `title` is `Frontend overview`

#### Scenario: Dashboard JSON references the Prometheus datasource by name, not by hard-coded UID

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** every panel's `datasource` block either omits the `uid` field or uses the templated form `${DS_PROMETHEUS}` resolved by provisioning

#### Scenario: Dashboard JSON contains the SLO row with panels for LCP and INP

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** the dashboard contains a row whose title (or section header) is `SLO`
- **AND** at least one panel in that row queries `job:slo_lcp:slow_ratio_rate6h` (the LCP budget headroom stat)
- **AND** at least one panel in that row queries `job:slo_inp:slow_ratio_rate6h` (the INP budget headroom stat)
- **AND** at least one panel in that row queries both `job:slo_lcp:slow_ratio_rate1h` and `job:slo_inp:slow_ratio_rate1h` (the burn-rate time-series)
- **AND** at least one panel in that row computes a `histogram_quantile(0.75, ...)` over `web_vitals_lcp_bucket` and another over `web_vitals_inp_bucket`

#### Scenario: Pre-existing rows are preserved

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** the dashboard still contains panels matching each row from the previous version (Web Vitals p75 panels for LCP/CLS/INP/FCP/TTFB, the route-timing p50/p95/p99 panel, the long-tasks rate and rate-of-sum panels, and the browser request-volume panel)
