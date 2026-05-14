## Context

Seven slices of observability have landed since 2026-05-13: backend metrics, structured logs, traces (OTel Java agent), log shipping (Loki via the OTel Collector), frontend traces, frontend RUM metrics (Web Vitals), and frontend errors. Prometheus, Tempo, Loki, and Grafana are provisioned under the `observability` docker-compose profile. The backend already emits everything an SLI needs: `http_server_requests_seconds_*` for availability and request latency, plus four hand-instrumented business timers (`posts.create.duration`, `feed.read.duration`, `feed.fanout.duration`, `follows.follow.duration`).

What's missing is the consumer side. Nothing fires when the platform misbehaves — an operator has to be looking at a dashboard. This change adds Service Level Indicator / Objective definitions, Prometheus recording and alerting rules that compute them, and an Alertmanager instance that holds and (eventually) routes the firings.

The observability profile already runs five containers (`postgres` excluded by default; `prometheus`, `grafana`, `tempo`, `collector`, `loki` under the profile). Adding `alertmanager` makes six. The default `docker-compose up -d postgres` invocation must continue to start only Postgres — a property the prior slices' specs explicitly preserve.

This slice changes infra and config only. There are no Java or TypeScript code changes.

## Goals / Non-Goals

**Goals:**

- Define three production-shaped backend SLOs (API availability, feed-read p95 latency, post-create p95 latency) as Prometheus recording + alerting rules.
- Use the Google SRE Workbook multi-window multi-burn-rate alerting pattern for the availability SLO — the canonical example, with fast-page / slow-page / ticket-only alerts derived from the same error budget.
- Run a real Alertmanager container so alert state has a single source of truth, queryable over its v2 HTTP API.
- Wire Grafana to Alertmanager as a provisioned datasource so the built-in Alerting left-nav populates without any dashboard changes.
- Make the alerting rules executable-spec-driven via `promtool test rules` — each rule scenario in the spec corresponds to a test entry, mirroring this project's "spec-by-scenario" style.
- Keep the slice tight enough to ship in one PR: infra/config only, no application code changes, no end-to-end UI flow.

**Non-Goals:**

- Real paging integration (no PagerDuty / Opsgenie / Slack webhook). Alertmanager's default `null` receiver is the stub; a real webhook sink is deferred.
- Frontend error-rate alerting. FE errors are already client-side rate-limited (slice 7); alerting on a rate-limited stream is incoherent. Dashboard-only is the right shape there.
- Per-endpoint availability SLOs. Service-level (rolled up across `/api/v1/*`) is the production answer; per-endpoint creates rule sprawl and false alerts on rare endpoints.
- Fault-injection endpoint (`/__dev/fault?type=5xx`) for end-to-end alert-firing tests.
- Grafana alert-list panels on the overview dashboards. (The built-in Alerting nav is the surface this slice ships.)
- Runbook documents linked from alerts.
- Tail-based trace sampling tied to alerting, and any cardinality / cost-control work.

## Decisions

### Decision 1 — Multi-window multi-burn-rate alerts over static thresholds

Static-threshold alerting (`5xx_ratio > 0.05 for 5m`) is easier to author but doesn't speak in terms of error budgets, flaps on transient spikes, and doesn't compose into SLO reporting. The Google SRE Workbook multi-window multi-burn-rate pattern is the modern enterprise standard: alerts fire when the *burn rate* (rate of budget consumption relative to the SLO target) is high simultaneously in both a long evaluation window (the trend) and a short evaluation window (the freshness check). Three pairs of windows give three severities:

```
  severity     long window   short window   burn rate   meaning
  ─────────    ───────────   ────────────   ─────────   ─────────────────────
  fast page      1h             5m            14.4      2% of 30d budget in 1h
  slow page      6h            30m             6        5% of 30d budget in 6h
  ticket         3d             6h             1        10% of 30d budget in 3d
```

Alternative considered: a single "5xx ratio > X% for Y minutes" rule. Rejected — does not match how production teams reason about reliability.

Trade-off: requires recording rules (Decision 2) and is genuinely harder to test. `promtool test rules` mitigates the testing cost (Decision 5).

### Decision 2 — Recording rules underneath the alerting rules

Burn-rate expressions are arithmetic over `rate(...)` over multiple windows. Inlining them in alerting rules makes the YAML unreadable and re-computes the same series for every alert. The standard pattern is to compute the canonical per-SLO error ratio once as a recording rule, then have multiple alerting rules reference it.

```
  recording: job:slo_api_availability:errors_ratio_rate5m
             job:slo_api_availability:errors_ratio_rate1h
             job:slo_api_availability:errors_ratio_rate6h
             job:slo_api_availability:errors_ratio_rate30m
             job:slo_api_availability:errors_ratio_rate3d
             job:slo_api_availability:errors_ratio_rate6h
  alerting:  references the recording series, applies burn-rate threshold
```

Recording-rule names follow the Prometheus convention `level:metric:operation`. Each window of interest gets its own recording rule.

### Decision 3 — Alertmanager (not Grafana Unified Alerting) as the canonical alert store

Grafana 8+ ships unified alerting that can store alert state itself, decoupling from Prometheus rule files. Real production teams overwhelmingly still use Alertmanager: it's the reference implementation, it lives next to the metric source, and `prometheus.yml`'s `alerting:` block is the documented integration point. Grafana then consumes Alertmanager via the Alertmanager datasource and surfaces alerts in its UI for free.

Rejected: Grafana-as-the-alert-store. Reasons — couples alert state to Grafana availability, doesn't match the canonical Prometheus reference architecture, less portable.

### Decision 4 — Webhook sink deferred; assert against Alertmanager's HTTP API

To prove an alert fires end-to-end, two surfaces exist:

1. Alertmanager itself exposes `GET /api/v2/alerts` returning every active alert with labels and annotations.
2. A downstream webhook receiver (a small custom container or `alertmanager-webhook-logger`) records every routed firing.

For this slice, (1) is sufficient: an alert is "fired" when Alertmanager has accepted it from Prometheus. Adding a webhook sink doubles the infrastructure surface and only proves Alertmanager's HTTP client works — which is upstream-tested. Deferred to the follow-up slice that also adds fault injection.

### Decision 5 — `promtool test rules` is the executable spec for alerting rules

Prometheus ships `promtool test rules <file>`, a yaml-driven framework where you feed in synthetic series over a simulated time range and assert which alerts are in which state at which step. This is *exactly* the "spec-by-scenario" shape the project uses elsewhere — each scenario in the spec maps to a stanza in `slo-tests.yml`:

```yaml
- interval: 1m
  input_series:
    - series: http_server_requests_seconds_count{status="500", uri="/api/v1/posts"}
      values: '0+10x60'        # 10 errors/min for 60 minutes
    - series: http_server_requests_seconds_count{status="200", uri="/api/v1/posts"}
      values: '0+10x60'        # 10 successes/min — gives 50% error rate
  alert_rule_test:
    - eval_time: 5m
      alertname: ApiAvailabilityFastBurn
      exp_alerts:
        - exp_labels: { severity: page, slo: api_availability }
```

This makes the alerting logic itself unit-testable, declaratively, and runnable in CI without standing up the full observability stack.

CI invokes `docker run --rm -v ... prom/prometheus:<pinned> promtool test rules /rules/slo-tests.yml`. No host-side Prometheus install needed; the image we already pin for the Prometheus container has `promtool` baked in.

### Decision 6 — Service-level SLOs, not per-endpoint

The availability SLI rolls up across all `/api/v1/*` paths:

```promql
1 - (
  sum(rate(http_server_requests_seconds_count{job="backend", uri=~"/api/v1/.*", status=~"5.."}[5m]))
  /
  sum(rate(http_server_requests_seconds_count{job="backend", uri=~"/api/v1/.*"}[5m]))
)
```

Per-endpoint SLOs were rejected for two reasons: rare endpoints have low volume and false-alert easily, and rule files would balloon as endpoints are added. If a single hot path needs its own SLO, the precedent is the *latency* SLOs — which are scoped to the named business timer (`feed.read.duration`, `posts.create.duration`) deliberately.

`/actuator/*` is excluded from the availability SLI: it's an operational surface, not user-facing.

### Decision 7 — SLO targets and time windows

```
  SLI                                          Target   Window
  ──────────────────────────────────────────   ──────   ──────
  API availability (5xx ratio on /api/v1/*)    99.5%    30d
  Feed read latency (p95)                      < 200ms  rolling 30d
  Post create latency (p95)                    < 500ms  rolling 30d
```

99.5% is the deliberate choice over 99.9%: the platform has no traffic at toy scale, and 99.9% over 30d is 43 minutes of allowed downtime — small enough that a single restart blows the budget. 99.5% (3.6h/30d) keeps the math meaningful for a system where dev loops will sometimes leave the backend stopped.

The latency thresholds (200ms feed read, 500ms post create) align with what the dashboards already display as the implicit "healthy" range; they're chosen so the alert fires under genuine regression, not under the steady-state.

### Decision 8 — Alert labels are the routing contract

Every alert carries two labels for downstream routing:

- `severity` ∈ {`page`, `ticket`} — the urgency. Fast-burn and slow-burn alerts get `page`; the 3d ticket alert gets `ticket`. Alertmanager routes (when configured) match on this.
- `slo` — the SLO identifier (`api_availability`, `feed_read_latency`, `post_create_latency`). Lets multi-burn alerts for the same SLO be grouped/inhibited together.

These labels are part of the spec because future routing depends on them being stable.

## Risks / Trade-offs

- **Burn-rate alerts don't fire at toy traffic.** With near-zero requests in dev, the burn-rate denominator hovers around zero and no alert ever evaluates. → Mitigated by `promtool test rules`, which doesn't need real traffic — synthetic series prove the logic.

- **`docker-compose --profile observability up -d` now starts six containers.** Memory flags that Grafana provisioning requires explicit restart on YAML change; the same applies to Alertmanager. → README documents the run loop; the `Default invocation still starts only postgres` scenario in the spec is preserved.

- **`prom/alertmanager` image version drift.** We pin the version, but Alertmanager occasionally changes config-file schema between minors. → Pin to a specific tag (not `latest`); the integration test (promtool) doesn't actually exercise Alertmanager's config, but the docker-compose health-check / startup will catch a broken config locally before merge.

- **`promtool test rules` doesn't validate Alertmanager routing.** It tests Prometheus's view of alerts only — what gets evaluated, what fires. Whether Alertmanager then routes correctly is unverified in this slice. → Acceptable: this slice has only a stub receiver. When the follow-up slice adds a real webhook, that's the right time to add an end-to-end routing test.

- **Recording-rule naming sets a long-term contract.** Once recording rules ship, downstream dashboards and follow-up alerts will reference the names. Renames later are painful. → Spec freezes the names. The `level:metric:operation` Prometheus convention keeps them disciplined.

- **No fault-injection path exists.** To validate alerts firing on real (not synthetic) data, someone has to manually cause a 5xx storm. → Acceptable for this slice — `promtool` is the gate. A `/__dev/fault` endpoint is scoped into the follow-up slice.

## Migration Plan

This is an infra-only change. There's no rollback concern in the application code sense.

- **Deploy path** (local dev): pull the branch, run `docker-compose --profile observability up -d alertmanager grafana prometheus` (Grafana restart picks up the new datasource; Prometheus restart picks up the new `rule_files` and `alerting` blocks).
- **CI gate**: the new `promtool test rules` step in CI must pass on the PR. If rule tests pass, the rules are correct by construction.
- **Rollback**: revert the merge. No state mutation outside Prometheus's TSDB (which is recreated freely under the `observability` profile, no persistent volume in dev).

## Open Questions

- **Latency burn-rate vs simple threshold for the latency SLOs.** The Workbook pattern translates to latency via a "fraction of requests slower than the threshold" SLI, then the same burn-rate math. This is more correct but doubles rule complexity. Current plan: implement latency SLOs with the same fraction-based SLI as availability, since `histogram_quantile` over the existing buckets is cheap and the symmetry pays off in promtool tests. If the rule file feels noisy, fall back to a single `p95 > target for 5m` alert per latency SLO.

- **Alertmanager UI exposed or not.** Alertmanager has its own web UI on `:9093`. We can expose it on the host or hide it behind Grafana. Current plan: expose it on the host for dev (Grafana's alert nav reads from it, but the Alertmanager UI is useful for routing introspection). README mentions both surfaces.

- **Do we want a "synthetic stability" rule that fires on Prometheus losing the backend target?** A "backend is up" alert (`up{job="backend"} == 0` for 2m) is the simplest possible alert and a useful one. Probably yes — it goes in `slo-alerting.yml` as an explicitly non-SLO alert, labeled `severity=page` but not tied to any SLO label. Tentatively in scope; finalize while writing tasks.md.
