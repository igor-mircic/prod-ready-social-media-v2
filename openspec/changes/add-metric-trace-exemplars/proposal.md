## Why

Slices 1–8 stood up the three observability pillars and stitched FE→BE traces. The metrics and traces pillars are still parallel rails: a latency spike in a Prometheus histogram requires the operator to manually guess which trace was slow. Exemplars close that gap — every histogram bucket carries one trace_id, so the Grafana latency panel becomes one click away from the offending Tempo trace. Without this, the slice-8 SLO alerts point at a number, not a request.

## What Changes

- Enable OpenMetrics exposition on the backend `/actuator/prometheus` endpoint so Micrometer can emit exemplar lines alongside histogram buckets.
- Configure Micrometer to record the active OTel trace_id/span_id as the exemplar when a sample is observed under an active span (Java agent already populates the OTel context).
- Enable exemplar storage in Prometheus (`--enable-feature=exemplar-storage`) and set the scrape job to request OpenMetrics content type so exemplars survive ingestion.
- Add `exemplarTraceIdDestinations` to the provisioned Prometheus datasource pointing at the Tempo datasource (UID `tempo`).
- Enable the exemplars panel option on the `http.server.requests` latency panel in `backend-overview.json` as a smoke test.
- Add an e2e test that drives one backend request, scrapes Prometheus for an exemplar carrying the expected trace_id, and confirms the trace_id resolves in Tempo.
- Document FE exemplars as deferred (see Impact) — the Collector's `prometheus` exporter does not synthesize exemplars from OTLP-shipped histograms, and FE Web Vitals samples are not recorded inside an HTTP server span, so the value is marginal.

## Capabilities

### New Capabilities
<!-- None — this slice extends the existing observability capability. -->

### Modified Capabilities
- `observability`: add exemplar emission to the BE metrics pipeline, exemplar storage and scrape configuration to Prometheus, the Prometheus→Tempo exemplar link in Grafana provisioning, an exemplar-enabled latency panel, and an e2e proving metric→trace one-click pivot end-to-end.

## Impact

- **Backend**: Spring Boot Actuator config (`application.yml`) — add OpenMetrics support and Micrometer exemplar producer. No code changes expected to recording sites — Spring's auto-instrumented `http.server.requests` histogram is the carrier.
- **Prometheus**: `infra/observability/prometheus/prometheus.yml` and the container's `--enable-feature=exemplar-storage` flag. Scrape job for backend switches Accept header to `application/openmetrics-text`.
- **Grafana**: `infra/observability/grafana/provisioning/datasources/prometheus.yaml` gains `exemplarTraceIdDestinations`; `backend-overview.json` flips the exemplars panel option on one panel. Provisioning change requires a Grafana container restart (per project memory).
- **E2E**: new spec at `e2e/tests/observability.metric-exemplars.spec.ts`, using the same Tempo polling pattern slice 5 introduced.
- **Out of scope (call out in design)**:
  - FE exemplars (Collector `prometheus` exporter limitation; document, defer).
  - Alert payload exemplars (Prom alerts don't carry exemplars; slice 8 alerts stay as-is).
  - Continuous profiling, source maps.
