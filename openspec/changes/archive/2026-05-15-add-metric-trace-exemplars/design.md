## Context

Slices 1–8 built the three observability pillars (logs, metrics, traces) and stitched FE→BE traces via W3C `traceparent`. Today the metrics and traces pillars are queried independently: the slice-8 SLO dashboards and alerts fire on `http_server_requests_seconds_bucket` aggregates, but there is no first-class jump from a high-latency bucket to a slow trace. Operators have to copy a rough timestamp range from Grafana into Tempo's search and guess.

Prometheus has supported exemplars (Pre 2.x: behind a feature flag) since 2.27 (2021). Micrometer 1.9+ wires an `ExemplarSampler` that pulls the active OTel trace_id at recording time, and the OTel Java agent (already running on the backend per slice 3) provides that context. Grafana renders exemplars as diamonds on histogram panels with a one-click pivot to a configured tracing datasource. Every piece needed is already on the right side of the version line — this slice is wiring, not new infrastructure.

## Goals / Non-Goals

**Goals:**
- One exemplar per scrape interval per histogram bucket on `http.server.requests` (the slice-8 SLO carrier metric), carrying the active OTel `trace_id`.
- Clicking the exemplar diamond in Grafana opens the corresponding trace in Tempo with no manual copy/paste.
- The slice-5 e2e wiring stitches FE and BE spans into one trace, so the pivot lands on a trace that already shows both services.
- An e2e test asserts the metric→trace pivot end-to-end: drive a request, scrape Prometheus, parse out an exemplar, GET that trace_id from Tempo, assert the trace contains a `backend` span.

**Non-Goals:**
- **FE exemplars.** The Collector's `prometheus` exporter does not synthesize exemplars from OTLP histogram data points. Even if it did, FE Web Vitals samples are not recorded under an active HTTP server span, so an attached trace_id would not identify "the trace that produced this metric" the way the BE pattern does. Document and defer.
- **Alert payload exemplars.** Prometheus alerts evaluate over aggregated series; Alertmanager payloads do not carry exemplars. The slice-8 SLO alerts remain unchanged.
- **Counter exemplars** beyond what Micrometer wires automatically. Histograms are the high-value carrier; we don't manually instrument counters.
- **Continuous profiling, source maps.** Separate slices.

## Decisions

### Decision: Backend uses Micrometer's built-in `OpenTelemetryExemplarSampler` over a custom recorder
Spring Boot Actuator 3.2+ auto-wires an `ExemplarSampler` bean from Micrometer when the OTel API is on the classpath and the agent is active. The agent is already present (slice 3). We enable the path by:
1. Setting `management.prometheus.metrics.export.exemplars-enabled=true` (or whatever the property name resolves to under the configured Spring Boot version — design will confirm during apply).
2. Ensuring the Actuator endpoint negotiates OpenMetrics: Prometheus must send `Accept: application/openmetrics-text` (the scrape job picks the right `version` parameter when configured).

**Alternative considered:** hand-roll a `MeterFilter` that pulls `Span.current().getSpanContext().getTraceId()` from the OTel API on every observation. Rejected — Micrometer's sampler already handles "no active span" gracefully (emits the sample with no exemplar) and rate-limits exemplar emission per series; rebuilding both is unnecessary.

### Decision: Prometheus stores exemplars in-memory, sized by `--storage.tsdb.exemplars.exemplars-limit`
Prometheus 2.55 (the pinned image) supports exemplar storage behind `--enable-feature=exemplar-storage`. Storage is in-memory only — no on-disk persistence — and bounded by `--storage.tsdb.exemplars.exemplars-limit` (default 100,000). For a local-dev stack with one backend and modest traffic, the default is generous; we will not tune it in this slice.

**Alternative considered:** remote-write to a long-term store with exemplar support (e.g. Mimir). Out of scope; the local stack does not have one and the slice does not justify adding it.

### Decision: Grafana provisioning links the Prometheus datasource to the Tempo datasource via `exemplarTraceIdDestinations`
Add this to `infra/observability/grafana/provisioning/datasources/prometheus.yaml`:
```yaml
jsonData:
  exemplarTraceIdDestinations:
    - name: trace_id
      datasourceUid: tempo
```
The label name `trace_id` is the Micrometer/Prom convention for exemplar labels and is what Spring Boot Actuator emits.

`editable: false` is preserved, so a Grafana UI edit cannot drift the wiring. **The Grafana container must be restarted to pick up the provisioning change** (see project memory `project_grafana_provisioning_restart.md`). The slice's README delta will call this out.

### Decision: Smoke-test panel lives on `backend-overview.json`, one panel only
The slice-3 / slice-8 `backend-overview.json` already has an `http.server.requests` latency panel. We flip `options.exemplars = true` on that single panel. Adding the option to every histogram panel is out of scope — one panel proves the wiring; later slices or operator preference can expand coverage.

### Decision: E2E uses the slice-5 Tempo polling helper, queries Prometheus directly
The e2e test:
1. Authenticates and POSTs `/api/v1/posts` via the apiClient.
2. Polls Prometheus `/api/v1/query_exemplars` (note: distinct endpoint from `/api/v1/query`) for exemplars on `http_server_requests_seconds_bucket{uri="/api/v1/posts"}` within a 60-second window.
3. Extracts the `trace_id` label from at least one returned exemplar.
4. Reuses the slice-5 Tempo polling pattern to GET `http://localhost:3200/api/traces/<traceId>` and asserts the trace contains at least one span with `resource.service.name=backend`.

The 2-second e2e token TTL (project memory `project_e2e_token_ttl.md`) applies: the test re-logs before the post if there's a slow setup step.

## Risks / Trade-offs

- **[Risk] Spring Boot Actuator may not expose the exemplar property under the property name we expect.** → Mitigation: design step 1 of tasks.md is "confirm the exact property name and Actuator behavior in a 30-line spike before changing application.yml". If the property does not exist in the pinned Spring Boot version, fall back to a Micrometer `MeterFilter` that registers an `ExemplarSampler` via configuration class.

- **[Risk] OpenMetrics negotiation: Prometheus may scrape with `Accept: text/plain` if not asked to do otherwise, and exemplars will silently drop on the wire.** → Mitigation: explicitly set the scrape format in `prometheus.yml`. Prometheus's `scrape_config` has no per-job content-type override; the negotiation is automatic when the `--enable-feature=exemplar-storage` flag is set, but we verify with a curl against `/api/v1/query_exemplars` after wiring.

- **[Risk] Exemplar storage is bounded; high-throughput services lose exemplars to retention pressure.** → Acceptable at this scale. Document the limit in README so an operator hitting it knows where to look.

- **[Trade-off] Sampling vs coverage.** Micrometer's default sampler is "1 exemplar per series per scrape interval" — not every request gets one. This is correct (exemplars are pointers, not a log) but means an operator searching for "the trace behind that one spike" may need to widen the window. Document the expectation; do not tune the sampler.

- **[Risk] If Tempo retention is shorter than the visible time range on the Grafana panel, exemplar diamonds will point at traces that 404.** → Out of scope for this slice. Local dev uses Tempo's default retention (generous for a single-developer stack). Production deploy will need a retention review — call out in design for future slices.

- **[Trade-off] FE exemplars deferred.** The metric→trace story on the FE side stays "look up the trace by route + timestamp" until a future slice. Acceptable because slice-5 already proved FE→BE traces stitch, and slice-6 RUM metrics are mostly for aggregate Web Vitals, not request-level debugging.
