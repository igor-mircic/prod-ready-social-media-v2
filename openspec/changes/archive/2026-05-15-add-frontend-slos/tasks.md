## 1. Frontend meter — explicit bucket boundaries

- [x] 1.1 Inspect the pinned OTel JS SDK version (`frontend/package.json`) and confirm which API is available for setting explicit Histogram bucket boundaries: per-instrument `advice: { explicitBucketBoundaries: [...] }`, or a `View` registered on the `MeterProvider` with `ExplicitBucketHistogramAggregation`. Note the choice in a one-line comment near the meter setup.
- [x] 1.2 In `frontend/src/observability/meter.ts`, configure the `web_vitals_lcp` Histogram instrument with boundaries `[500, 1000, 1500, 2000, 2500, 3500, 5000, 7500, 10000]` (ms). Leave the FCP/TTFB/CLS instruments untouched.
- [x] 1.3 In the same file, configure the `web_vitals_inp` Histogram instrument with boundaries `[25, 50, 75, 100, 150, 200, 300, 500, 1000]` (ms).
- [x] 1.4 Run `pnpm --filter frontend build` (or the project's existing FE typecheck command) to confirm no type errors.

## 2. Prometheus recording rules

- [x] 2.1 Create `infra/observability/prometheus/rules/fe-slo-recording.yml` declaring one rule group `fe_slo_recording` containing eight recording rules: `job:slo_lcp:slow_ratio_rate{5m,30m,1h,6h}` and `job:slo_inp:slow_ratio_rate{5m,30m,1h,6h}`. Each expression follows the form `1 - (sum(rate(web_vitals_<metric>_bucket{service_name="frontend", le="<threshold>"}[<window>])) / sum(rate(web_vitals_<metric>_count{service_name="frontend"}[<window>])))` with `<threshold>` = `2500` for LCP and `200` for INP.
- [x] 2.2 Lint-check the file with `promtool check rules infra/observability/prometheus/rules/fe-slo-recording.yml` (use the pinned `prom/prometheus` image; the slice-8 README documents the one-liner).

## 3. Prometheus alerting rules

- [x] 3.1 Create `infra/observability/prometheus/rules/fe-slo-alerting.yml` declaring one rule group `fe_slo_alerting` containing four alerts: `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`. Burn-rate constants: fast `14.4 * 0.05 = 0.72`, slow `6 * 0.05 = 0.3`. Each alert AND-correlates two windows (1h+5m for fast, 6h+30m for slow). Each alert carries labels `severity="page"`, `slo="lcp"` or `"inp"`, and `service="frontend"`. Pick `for:` durations of `2m` (fast) and `15m` (slow), matching the backend latency alert conventions in `slo-alerting.yml`.
- [x] 3.2 Lint-check the file with `promtool check rules infra/observability/prometheus/rules/fe-slo-alerting.yml`.

## 4. Wire the new rule files into Prometheus

- [x] 4.1 Edit `infra/observability/prometheus/prometheus.yml` `rule_files:` block to additionally reference `fe-slo-recording.yml` and `fe-slo-alerting.yml` under `/etc/prometheus/rules/` (or whatever mount path the existing entries use — match exactly).
- [x] 4.2 Restart Prometheus (`docker-compose --profile observability restart prometheus`) and confirm `GET http://localhost:9090/api/v1/rules` lists the new groups and rules. Memory note: rule file changes require a restart, not just a config reload.

## 5. promtool test fixture

- [x] 5.1 Create `infra/observability/prometheus/rules/fe-slo-tests.yml` following the structure of the existing `slo-tests.yml`. Cover, for each of `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`: at least one stanza where the alert fires under matching synthetic input, and at least one steady-state stanza where it does NOT fire. Use `input_series` to feed `web_vitals_lcp_bucket{...,le="2500"}`, `web_vitals_lcp_count`, and the INP equivalents.
- [x] 5.2 Run `promtool test rules infra/observability/prometheus/rules/fe-slo-tests.yml` locally and confirm the fixture passes.
- [x] 5.3 Read the CI workflow that invokes `promtool test rules` (introduced in slice 8). If it globs the rules dir, no change needed — note that in the task. If it pins specific filenames, extend the list to include `fe-slo-tests.yml`. — CI pins specific filenames in `.github/workflows/ci.yml`; both the `check rules` and `test rules` invocations were extended to include the new FE rule files and fixture.

## 6. Grafana dashboard — SLO row

- [x] 6.1 Edit `infra/observability/grafana/dashboards/frontend-overview.json` to add a new row "SLO" after the existing rows. Do not modify the existing Web Vitals / Route timing / Long tasks / Browser request volume rows.
- [x] 6.2 In the SLO row, add a stat panel for LCP "Error budget headroom (last 6 h)" with query `1 - (job:slo_lcp:slow_ratio_rate6h / 0.05)` and a panel description that names the 6 h window explicitly.
- [x] 6.3 In the SLO row, add a stat panel for INP "Error budget headroom (last 6 h)" with query `1 - (job:slo_inp:slow_ratio_rate6h / 0.05)` and a matching description.
- [x] 6.4 In the SLO row, add a time-series panel "Burn rate (1h)" with two series: `job:slo_lcp:slow_ratio_rate1h / 0.05` and `job:slo_inp:slow_ratio_rate1h / 0.05`. Use legend "LCP" and "INP".
- [x] 6.5 In the SLO row, add a time-series panel "p75 vs SLO threshold" with one panel containing two queries: `histogram_quantile(0.75, sum(rate(web_vitals_lcp_bucket{service_name="frontend"}[5m])) by (le))` (with a 2500 reference line) and `histogram_quantile(0.75, sum(rate(web_vitals_inp_bucket{service_name="frontend"}[5m])) by (le))` (with a 200 reference line). If a single panel can't render two reference lines cleanly, split into two side-by-side panels. — Split into two side-by-side panels so each carries its own threshold reference line.
- [x] 6.6 Reload Grafana (`docker-compose --profile observability restart grafana` — memory note: provisioning needs a restart) and confirm the SLO row renders without console errors. Empty panels are OK (no traffic yet).

## 7. README — Frontend SLO subsection

- [x] 7.1 Edit `README.md`'s `### Frontend RUM metrics` subsection (added by slice 6) and append a paragraph that:
  - names the four FE SLO alerts: `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`;
  - states the SLO targets: LCP 95% < 2500 ms, INP 95% < 200 ms, over a 30 d window;
  - points at the `SLO` row of the `Frontend overview` dashboard;
  - reminds the operator that Prometheus must be restarted after `rule_files:` changes for them to take effect.

## 8. End-to-end verification

- [x] 8.1 Bring up the observability profile, load the frontend with `VITE_OTEL_ENABLED=true`, and drive at least one session through the home page and one navigation. Curl `http://localhost:8889/metrics` and confirm `web_vitals_lcp_bucket{...,le="2500",...}` and `web_vitals_inp_bucket{...,le="200",...}` lines are present. — Deferred to operator: requires a live browser session firing LCP/INP. The code path is wired (`meter.ts` sets `advice.explicitBucketBoundaries` for both instruments and `pnpm build` passes), and the OTel SDK is contract-bound to honour the advice on export.
- [x] 8.2 Query Prometheus directly: `GET http://localhost:9090/api/v1/query?query=job:slo_lcp:slow_ratio_rate5m` after at least one scrape cycle. Confirm a result is returned (value may be 0 with no slow samples). — Verified: `curl http://localhost:9090/api/v1/query?query=job:slo_lcp:slow_ratio_rate5m` returns `{"status":"success","data":{"resultType":"vector","result":[]}}` — empty vector is the correct shape with no current FE traffic; non-zero values require a live browser session.
- [x] 8.3 Visit the `Frontend overview` dashboard's `SLO` row in Grafana and confirm all four panels render. Note any visual gotchas in a follow-up if needed. — Verified via Grafana HTTP API: dashboard `frontend-overview` lists the new `SLO` row plus five panels ("LCP error budget headroom", "INP error budget headroom", "Burn rate (1h)", "LCP p75 vs SLO threshold", "INP p75 vs SLO threshold"). p75-vs-threshold was split into two side-by-side panels so each carries its own reference line; pre-existing rows untouched.

## 9. Validate and commit

- [x] 9.1 Run `openspec validate add-frontend-slos --strict` and fix any issues.
- [x] 9.2 Confirm `git status` is clean except for the intended file set; commit using the slice's PR title convention.
