## Why

The seven-slice observability arc that landed before this change made the backend and frontend fully *visible* — metrics, logs, traces, and errors all flow into Prometheus, Loki, Tempo, and Grafana. But the stack is read-only: nothing automatically reacts when the system misbehaves. An operator has to open a dashboard at the right moment. This change closes the loop by defining Service Level Indicators / Objectives for the backend's hot paths, evaluating them in Prometheus as recording and alerting rules, and routing firings through Alertmanager — turning the existing telemetry into something that can wake a person up.

It also picks the production-grade pattern at a real architectural fork: multi-window multi-burn-rate alerts (the Google SRE Workbook standard) rather than static thresholds. Static thresholds flap, don't speak in terms of error budgets, and don't compose into SLO reporting. Burn-rate alerts are slightly more involved to author and test, but they're the shape an enterprise team actually ships — and `promtool test rules` makes them declaratively testable, which fits the project's "spec-by-scenario" style.

## What Changes

- **Alertmanager service** added to `docker-compose.yml` under the `observability` profile, on the same shared network as Prometheus and Grafana.
- **Prometheus rule files** under `infra/observability/prometheus/rules/`:
  - `slo-recording.yml` — recording rules that compute per-SLO error/success ratios over short and long windows. Required so alerting expressions stay readable and Prometheus evaluation stays cheap.
  - `slo-alerting.yml` — multi-window multi-burn-rate alerting rules, plus the latency burn-rate alerts. Each alert carries `severity` and `slo` labels so Alertmanager can route on them later.
- **`prometheus.yml`** updated to load the rule files and to declare the Alertmanager target.
- **Alertmanager config** at `infra/observability/alertmanager/alertmanager.yml` with route + receiver structure in place. Receivers are stubs (default `null` receiver) — a real webhook sink is explicitly deferred to a follow-up slice. The Alertmanager HTTP API (`/api/v2/alerts`) is the assertion surface for end-to-end tests.
- **Three SLO definitions** for the backend:
  - **API availability**: `1 - (rate of 5xx) / (rate of all)` across `/api/v1/*`, target 99.5% over a 30-day window. Alerts at three burn-rates (fast page / slow page / ticket).
  - **Feed read latency**: p95 of `feed.read.duration` < 200 ms. Fast-burn alert only.
  - **Post create latency**: p95 of `posts.create.duration` < 500 ms. Fast-burn alert only.
- **`promtool test rules` fixture** at `infra/observability/prometheus/rules/slo-tests.yml` that feeds crafted time series into the rules and asserts which alerts fire at which step. This is the executable spec for the alerting rules — each scenario in the spec corresponds to an entry in this file.
- **Grafana** gains the **Alertmanager datasource** (provisioned, non-default) so the built-in Alerting left-nav populates automatically from Alertmanager state. No new dashboard panels in this slice.
- **README** updated with the alerting run loop: how to start Alertmanager, where to view active alerts (Alertmanager UI + Grafana Alerting nav), and how to run `promtool test rules` locally.
- **Integration / e2e test** for alert firing is **not** in this slice — fault injection (e.g. a dev-profile `/__dev/fault` endpoint), webhook sinks, runbook links, and Grafana alert-list panels are all deferred to a follow-up slice. This slice proves correctness declaratively through `promtool` instead.

Out of scope (explicitly): FE error-rate alerting (FE errors are already client-side rate-limited; alerting on a rate-limited stream is incoherent), per-endpoint availability SLOs (rule sprawl, false alerts on rare endpoints), runbook documents, paging integrations beyond a stub receiver, and tail-based trace sampling.

## Capabilities

### New Capabilities
<!-- none — this extends the existing observability capability rather than introducing a new one -->

### Modified Capabilities
- `observability`: adds requirements for SLO/burn-rate recording and alerting rules, the Alertmanager service and its provisioning, Grafana's Alertmanager datasource, the `promtool` test fixture, and the README run-loop section.

## Impact

- **Affected code/config**:
  - `docker-compose.yml` — new `alertmanager` service under the `observability` profile.
  - `infra/observability/prometheus/prometheus.yml` — `rule_files:` and `alerting:` blocks.
  - `infra/observability/prometheus/rules/` (new directory) — `slo-recording.yml`, `slo-alerting.yml`, `slo-tests.yml`.
  - `infra/observability/alertmanager/alertmanager.yml` (new).
  - `infra/observability/grafana/provisioning/datasources/alertmanager.yaml` (new).
  - `README.md` — alerting run-loop section.
- **No application-code changes** in `backend/` or `frontend/`. SLIs are computed from already-emitted metrics.
- **Dependencies**: `prom/alertmanager` Docker image (pinned). `promtool` (ships inside `prom/prometheus` — invoked via `docker run` for tests, no host install needed).
- **CI**: a new job (or step in the existing observability job) runs `promtool test rules` against the rule files. This is the gate that the alerting logic does what the spec says.
- **Memory follow-ups touched**: none reopened. The async-MDC and source-maps memory items remain deferred.
