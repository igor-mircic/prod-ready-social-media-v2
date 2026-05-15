## Why

Slice 8 (`add-backend-alerting-slos`) gave the backend SLO-driven, multi-window burn-rate alerts wired through Alertmanager. The frontend has had Web Vitals histograms since slice 6 but no SLO targets and no alerts on them — so a regression in Largest Contentful Paint or Interaction to Next Paint is invisible until a user complains. This slice mirrors the backend SLO/alerting muscle for the two timing-based Core Web Vitals (LCP and INP), reusing the same Prometheus rule-files / promtool-tests / Alertmanager pipeline installed in slice 8.

## What Changes

- Frontend OTel histograms for `web_vitals_lcp` and `web_vitals_inp` gain explicit bucket boundaries that include the SLO thresholds (LCP `le=2500`, INP `le=200`), so the recording rules have buckets to read.
- Two new SLOs are declared: LCP 95% < 2500 ms over 30d, INP 95% < 200 ms over 30d. Burn-rate constants follow Google SRE workbook (fast burn 14.4× over 1h+5m; slow burn 6× over 6h+30m). Latency-style: no 3d ticket alert, matching backend latency SLOs.
- New Prometheus rule files `fe-slo-recording.yml` and `fe-slo-alerting.yml` add the recording rules (`job:slo_lcp:slow_ratio_rate{5m,30m,1h,6h}`, `job:slo_inp:slow_ratio_rate{5m,30m,1h,6h}`) and the four alerts (`LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`), each labelled `severity=page`, `slo=lcp|inp`, `service=frontend`.
- `prometheus.yml` `rule_files:` block is extended to load the two new files alongside the existing backend rule files.
- New `fe-slo-tests.yml` covers fires-and-doesn't-fire for each alert; CI's existing `promtool test rules` step picks it up.
- Existing `frontend-overview.json` Grafana dashboard gains a new SLO row (error budget remaining, current 1h burn rate, p75 vs threshold) — existing rows unchanged.
- README's Frontend RUM subsection gains an FE-SLO blurb so an operator pulling the branch can find the new alert surfaces.

Out of scope (explicit non-goals): CLS SLO, FE error-rate SLO, per-route latency SLOs, Alertmanager receiver/routing changes, backend rule changes.

## Capabilities

### New Capabilities
<!-- None — this slice extends the existing observability capability. -->

### Modified Capabilities
- `observability`: add four new requirements (FE Vitals explicit bucket boundaries, FE SLO recording rules, FE SLO alerting rules, FE SLO promtool tests); modify two existing requirements (Prometheus rule-files loader, Frontend overview dashboard); add one new requirement for README guidance on the FE SLO surface.

## Impact

- **Frontend code**: `frontend/src/observability/meter.ts` — set explicit bucket boundaries on the LCP and INP histogram instruments via the OTel JS SDK's per-instrument advice / view API. No other FE source changes.
- **Infra**: new files under `infra/observability/prometheus/rules/` (`fe-slo-recording.yml`, `fe-slo-alerting.yml`, `fe-slo-tests.yml`); modified `infra/observability/prometheus/prometheus.yml` `rule_files:` block; modified `infra/observability/grafana/dashboards/frontend-overview.json` (added SLO row only).
- **CI**: existing `promtool test rules` step in CI extends to cover the new fixture; no new CI jobs.
- **Docs**: `README.md` Frontend RUM subsection gains a paragraph naming the four new alerts and pointing at the dashboard row.
- **Dependencies**: no new packages. The OTel JS SDK API for explicit bucket boundaries (advice or view) is already shipped in the version pinned by slice 6.
- **No data migration. No breaking API changes. No runtime config changes for default `docker-compose up postgres`.**
