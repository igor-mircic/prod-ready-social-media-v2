## 1. Recording rules — the canonical SLO ratios

- [ ] 1.1 Create `infra/observability/prometheus/rules/` directory.
- [ ] 1.2 Write `infra/observability/prometheus/rules/slo-recording.yml` with five recording rules for `job:slo_api_availability:errors_ratio_rate{5m,30m,1h,6h,3d}`, computed as `sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*", status=~"5.."}[<W>])) / sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*"}[<W>]))`.
- [ ] 1.3 Add five recording rules for `job:slo_feed_read_latency:slow_ratio_rate{5m,30m,1h,6h,3d}` using the `feed_read_duration_seconds_bucket{le="0.2"}` vs `feed_read_duration_seconds_count` ratio.
- [ ] 1.4 Add five recording rules for `job:slo_post_create_latency:slow_ratio_rate{5m,30m,1h,6h,3d}` using the `posts_create_duration_seconds_bucket{le="0.5"}` vs `posts_create_duration_seconds_count` ratio.
- [ ] 1.5 Verify every rule name matches the `<level>:<metric>:<operation>` Prometheus convention.

## 2. Alerting rules — the burn-rate firings

- [ ] 2.1 Write `infra/observability/prometheus/rules/slo-alerting.yml` with the API-availability fast-burn alert (`ApiAvailabilityFastBurn`): 1h burn × 5m burn both > `14.4 * (1 - 0.995)`, `severity="page"`, `slo="api_availability"`, short `for:` (2m).
- [ ] 2.2 Add the API-availability slow-burn alert (`ApiAvailabilitySlowBurn`): 6h × 30m > `6 * 0.005`, `severity="page"`, `slo="api_availability"`, `for: 15m`.
- [ ] 2.3 Add the API-availability budget-burn ticket alert (`ApiAvailabilityBudgetBurn`): 3d × 6h > `1 * 0.005`, `severity="ticket"`, `slo="api_availability"`, `for: 1h`.
- [ ] 2.4 Add the feed-read latency fast-burn alert (`FeedReadLatencyFastBurn`): same burn ratios against `slow_ratio_rate1h` × `slow_ratio_rate5m`, target derived from `(1 - 0.95)`, `severity="page"`, `slo="feed_read_latency"`.
- [ ] 2.5 Add the feed-read latency slow-burn alert (`FeedReadLatencySlowBurn`): 6h × 30m, `severity="page"`, `slo="feed_read_latency"`.
- [ ] 2.6 Add the post-create latency fast-burn alert (`PostCreateLatencyFastBurn`).
- [ ] 2.7 Add the post-create latency slow-burn alert (`PostCreateLatencySlowBurn`).
- [ ] 2.8 Add the `BackendDown` operational alert: `up{job="backend"} == 0 for: 2m`, `severity="page"`, no `slo` label.
- [ ] 2.9 Sanity-check the rule files by running `docker run --rm -v $PWD/infra/observability/prometheus/rules:/rules prom/prometheus:<pinned> promtool check rules /rules/*.yml`.

## 3. promtool test fixture — the executable spec for alerts

- [ ] 3.1 Write `infra/observability/prometheus/rules/slo-tests.yml` with the test framework header (`rule_files:`, `evaluation_interval:`, `tests:`).
- [ ] 3.2 Add a fast-burn-firing test for `ApiAvailabilityFastBurn` that feeds synthetic 5xx and 2xx series at a ratio that pushes the 5m and 1h rates above the threshold, and asserts the alert fires at the right `eval_time`.
- [ ] 3.3 Add a slow-burn-firing test for `ApiAvailabilitySlowBurn`.
- [ ] 3.4 Add a budget-burn-firing test for `ApiAvailabilityBudgetBurn`.
- [ ] 3.5 Add a steady-state test that feeds successful traffic for 24 simulated hours and asserts that none of the three availability alerts fire.
- [ ] 3.6 Add fast-burn-firing and slow-burn-firing tests for `FeedReadLatencyFastBurn` / `FeedReadLatencySlowBurn` using `feed_read_duration_seconds_bucket` series.
- [ ] 3.7 Add fast-burn-firing and slow-burn-firing tests for `PostCreateLatencyFastBurn` / `PostCreateLatencySlowBurn`.
- [ ] 3.8 Add a `BackendDown`-firing test that drops `up{job="backend"}` to 0 for 3 minutes and asserts the alert fires; add a stable-up companion test that asserts it does not fire.
- [ ] 3.9 Run `docker run --rm -v $PWD/infra/observability/prometheus/rules:/rules prom/prometheus:<pinned> promtool test rules /rules/slo-tests.yml` locally and confirm all tests pass.

## 4. Alertmanager service + Prometheus wiring

- [ ] 4.1 Create `infra/observability/alertmanager/alertmanager.yml` with a top-level `route:` block pointing at a default receiver and a single `receivers:` entry of the stub `null` receiver.
- [ ] 4.2 Add an `alertmanager` service to `docker-compose.yml` under the `observability` profile: image `prom/alertmanager:<pinned-version>`, container `social-alertmanager`, port `9093:9093`, volume mount of the config file, on the shared docker network.
- [ ] 4.3 Update `infra/observability/prometheus/prometheus.yml` to add a `rule_files:` block referencing `rules/slo-recording.yml` and `rules/slo-alerting.yml`, and an `alerting: alertmanagers: [{static_configs: [{targets: ["alertmanager:9093"]}]}]` block.
- [ ] 4.4 Update the `prometheus` service in `docker-compose.yml` to mount `infra/observability/prometheus/rules/` read-only at the path referenced by `rule_files:` in `prometheus.yml`.
- [ ] 4.5 Start the stack (`docker-compose --profile observability up -d`), confirm `social-alertmanager` is healthy, and confirm Prometheus's `/api/v1/rules` lists every rule loaded.

## 5. Grafana Alertmanager datasource

- [ ] 5.1 Write `infra/observability/grafana/provisioning/datasources/alertmanager.yaml` declaring an Alertmanager datasource targeting `http://alertmanager:9093` with `type: alertmanager`, `isDefault: false`, and `implementation: prometheus` (the Alertmanager flavor Grafana expects).
- [ ] 5.2 Restart the `social-grafana` container so the datasource provisioning is picked up (memory: Grafana provisioning requires explicit container restart on YAML change).
- [ ] 5.3 Open Grafana → Alerting and confirm the new Alertmanager datasource shows up as a source of alerts.

## 6. CI gate — promtool test rules

- [ ] 6.1 Add a `promtool-test-rules` step (or job) to the existing CI workflow that mounts `infra/observability/prometheus/rules/` and runs `promtool test rules slo-tests.yml` inside the pinned `prom/prometheus` image.
- [ ] 6.2 Trigger the workflow on the branch and confirm the new step runs and passes.
- [ ] 6.3 Deliberately break one of the alert thresholds in a throwaway commit; confirm the step fails; revert.

## 7. README — the local alerting run loop

- [ ] 7.1 Add an "Alerting" subsection to the observability section of the project README.
- [ ] 7.2 Document the URL `http://localhost:9093` for the Alertmanager UI, and note that Grafana's Alerting left-nav also surfaces alerts via the provisioned datasource.
- [ ] 7.3 Document the one-liner that runs `promtool test rules` locally.
- [ ] 7.4 Document that editing rule files requires a Prometheus restart (`docker-compose --profile observability restart prometheus`) for changes to take effect.

## 8. Spec validation + branch + commit

- [ ] 8.1 Run `openspec validate --strict add-backend-alerting-slos` and resolve any findings.
- [ ] 8.2 Create branch `add-backend-alerting-slos`, commit the proposal artifacts, and push (per the memory rule that proposals get branched and committed before `/clear`).
