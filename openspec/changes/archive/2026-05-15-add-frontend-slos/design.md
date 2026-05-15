## Context

Slice 6 (`add-frontend-rum-metrics`) installed an OTel `MeterProvider` on the frontend that emits Web Vitals as histograms (`web_vitals_lcp`, `web_vitals_inp`, `web_vitals_cls`, `web_vitals_fcp`, `web_vitals_ttfb`) via OTLP/HTTP to the OTel Collector. The Collector exposes them on `:8889/metrics`; Prometheus scrapes them under `job="collector"`; Grafana provisions a `Frontend overview` dashboard.

Slice 8 (`add-backend-alerting-slos`) installed Alertmanager, the `rule_files:` loading pattern, `infra/observability/prometheus/rules/`, and a `promtool test rules` fixture pattern for backend SLOs (`ApiAvailability`, `FeedReadLatency`, `PostCreateLatency`). Alertmanager has a single `null` receiver — alerts fire to "the void" — but that's deliberate scope for slice 8; receiver routing is a separate future slice.

Slice 6 left bucket boundaries on the Web Vitals histograms at the OTel SDK defaults. Defaults are `[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`. Those defaults happen to include `2500` (good for LCP) but **not** `200` (bad for INP — nearest is `250`). So out of the box the recording rules can compute LCP's slow-fraction at the SLO threshold but **cannot** do the same for INP without re-bucketing.

This slice closes that gap and adds the SLO/alerting layer on top.

## Goals / Non-Goals

**Goals:**
- Ship FE SLOs for the two timing-based Core Web Vitals (LCP, INP) with multi-window burn-rate alerts, structurally identical to backend latency SLOs.
- Reuse slice 8's `rule_files` / promtool / Alertmanager infrastructure without re-architecting it.
- Make the FE meter expose bucket boundaries that match the SLO thresholds exactly (`le="2500"` for LCP, `le="200"` for INP) so the recording rules are precise, not approximate.
- Extend the existing `Frontend overview` Grafana dashboard with an SLO row (error budget, burn rate, p75 vs threshold) — leave existing rows alone.
- Cover every new alert with at least one fires-and-one-no-fires stanza in `fe-slo-tests.yml`.

**Non-Goals:**
- CLS SLO. CLS is unitless and very small (target `<0.1`); its math is different and its bucket grid would need a completely different boundary set. Defer.
- FE error-rate SLO. The denominator question (session count? page-view count?) is unresolved — `web_vitals_lcp_count` is a reasonable proxy but commits us to "every page must paint" semantics. Defer.
- Per-route latency SLOs. Cardinality risk plus the matched-template route label is best-effort; not a sound foundation for paging alerts.
- Alertmanager receivers, routing trees, notification policies. Still the slice-8 null receiver after this slice.
- Backend SLO changes.
- Source-map symbolication for FE errors (separate, memory-flagged deferred work).

## Decisions

### Decision 1: SLO targets are 95%, not Google's 75%

Google publishes Web Vitals "Good" thresholds (LCP < 2.5 s, INP < 200 ms, CLS < 0.1) with the convention that 75% of page loads should be in the "Good" range. Translating that as `SLO = 75%` breaks the burn-rate math: with a 25% error budget the 14.4× fast-burn threshold is `14.4 × 0.25 = 3.6`, but the slow-ratio is bounded at `1.0`, so the alert can never fire.

Picking 95% gives a 5% error budget, a 72% fast-burn threshold, and a 30% slow-burn threshold — meaningful values bounded inside `[0, 1]`. 95% is also symmetric to the backend latency SLOs which already use a 95% target, so the same alerting muscle (`14.4`, `6`, `1` burn multipliers; `5m`/`30m`/`1h`/`6h` windows) carries over without code-path divergence.

Alternative considered: pick 90% (10% budget). Cleaner round numbers, but breaks the BE/FE symmetry. Rejected.

### Decision 2: SLOs only for LCP and INP

LCP and INP are the two Core Web Vitals with clear "user-perceived outcome" semantics (page paint perceived speed; interaction responsiveness). FCP/TTFB are diagnostic ("why is LCP slow?") not outcomes. CLS is unitless visual-stability and needs a different SLI shape. Long tasks are a hint, not an outcome.

Keep dashboards rich (slice 6 already covers all five Vitals). SLO/alert scope stays tight.

### Decision 3: Explicit bucket boundaries only on LCP and INP

LCP needs `le=2500` (already in defaults) and INP needs `le=200` (not in defaults). To keep the change minimal and avoid destabilizing existing dashboard panels that depend on default buckets, set explicit boundaries **only** on the two instruments that need them:

- LCP: `[500, 1000, 1500, 2000, 2500, 3500, 5000, 7500, 10000]` ms
- INP: `[25, 50, 75, 100, 150, 200, 300, 500, 1000]` ms

The CLS/FCP/TTFB instruments keep SDK defaults — `histogram_quantile` works regardless of the grid, so existing p75 panels in the `Frontend overview` dashboard keep working unchanged.

Alternative considered: re-bucket all five Vitals for consistency. Rejected for blast radius: every dashboard / future SLI built on the existing buckets becomes a regression risk.

### Decision 4: SLO recording rule names keep the `job:` prefix

The Prometheus convention `<level>:<metric>:<operation>` uses `level=job` when the result aggregates a job. The FE Vitals come in under `job="collector"` (because Prometheus scrapes the Collector exporter, not the frontend directly). So `job:slo_lcp:...` is not literally filtering on `job="lcp"`; the prefix is a naming convention, and the actual filter is `service_name="frontend"` inside the rule expression.

We keep the `job:` prefix anyway, so the rule name format is symmetric to backend SLO recording rules (`job:slo_api_availability:...`, `job:slo_feed_read_latency:...`). Symmetry > literal correctness here.

### Decision 5: No 3d ticket alert

Backend's API-availability SLO has a 3d burn-rate ticket alert (slow-trickle budget burn). The backend latency SLOs (feed-read, post-create) omit it because long-window slow-burn at toy traffic is rarely actionable. FE latency SLOs inherit the same reasoning: only `*FastBurn` (1h+5m) and `*SlowBurn` (6h+30m) alerts, no 3d ticket.

### Decision 6: Error budget panel uses 6h window as the dashboard proxy

Computing a true 30d error budget remaining requires either a 30d-window recording rule (expensive to compute, slow to update) or a query-time `rate(...[30d])` (expensive at query time, slow to load). For the dashboard we use `1 - (slow_ratio_rate6h / 0.05)` as a "recent budget headroom" gauge — fast, accurate over the last 6 h, and good enough for an at-a-glance dashboard. The 30d framing is captured in the alert names and the README; if precise 30d tracking is needed later, a separate slice can add a `slow_ratio_rate30d` recording rule.

### Decision 7: Filter on `service_name="frontend"`, not `job="..."`

The Vitals samples arrive in Prometheus with `job="collector"`, `service_name="frontend"`. The `service_name` label is the durable identity (set on the OTel `Resource`, shared with FE traces and logs); `job` is an artifact of the scrape pipeline. Rule expressions filter on `service_name="frontend"` so they continue to work even if the scrape topology changes (e.g., if the FE later starts scraping directly).

## Risks / Trade-offs

- **Risk**: At toy traffic (a handful of dev sessions per hour), burn-rate denominators are tiny and ratios are noisy. Alerts may fire on a single slow LCP. → **Mitigation**: This is a learning project. The same flapping happens to backend SLOs at toy scale (see slice 8). Documented as expected; we keep the alerts pinned to the SRE-canonical burn rates anyway so the math is honest.
- **Risk**: The OTel JS SDK's API for setting explicit bucket boundaries has shifted across versions (instrument-level `advice` is newer; older versions need `view` with `ExplicitBucketHistogramAggregation`). The pinned SDK version (from slice 6) determines which API we have. → **Mitigation**: First task in the apply phase is to verify which API the pinned version exposes and use that; if neither works cleanly, bump the SDK pin within the slice and call it out in the slice's apply.
- **Risk**: Adding two new rule files to Prometheus `rule_files:` could miss a glob/include pattern and silently fail to load. → **Mitigation**: The rule-files-loaded scenario in the spec asserts they appear in `/api/v1/rules`; e2e or container restart verifies. Promtool test failures in CI catch logic errors.
- **Trade-off**: The 6h-window error-budget panel is a proxy, not the true 30d budget. Operators reading the dashboard need to understand it as "headroom over the last 6 h". → **Mitigation**: panel title and description make this explicit ("LCP error budget — last 6 h").
- **Trade-off**: Re-bucketing only LCP/INP creates an inconsistent grid across Web Vitals. → **Mitigation**: Dashboards use `histogram_quantile` and rate-of-bucket, neither of which assumes a specific grid; existing FCP/CLS/TTFB panels are untouched.

## Migration Plan

No data migration. No downtime. Steps:

1. Merge the FE meter change first (sets explicit boundaries on LCP and INP). Existing dashboards keep working — `histogram_quantile` ignores grid changes.
2. Merge the rule files. Prometheus needs a restart for `rule_files:` changes to take effect (memory note: same gotcha as Grafana provisioning). README guidance reminds the operator.
3. Merge the dashboard JSON change. Grafana picks it up via existing provisioning provider.
4. CI's `promtool test rules` invocation must already pick up the new fixture if it globs the rules dir — first apply task is to verify and extend if it pins specific filenames.

Rollback: revert the merge. No state to clean up. Prometheus rule files have no persistent state — removing them from `rule_files:` and restarting Prometheus removes the rules and any firing alerts they generated.

## Open Questions

- None blocking. The OTel JS SDK API choice (advice vs view) is a "first apply task" investigation, not a design-time decision.
