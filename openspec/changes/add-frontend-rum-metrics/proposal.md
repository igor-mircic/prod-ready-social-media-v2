# add-frontend-rum-metrics

## Why

Slice 5 (`add-frontend-traces`) wired the browser into the existing OTel
Collector so every user action produces a one-tree, two-service trace
that spans the click → fetch → Spring controller → JDBC tree. The browser
is no longer dark for *traces*, but it is still dark for *metrics*. The
practical consequences today:

- The Backend overview dashboard answers "is the server slow?" via the
  four `@Timed` hot paths and the auto-instrumented
  `http_server_requests_seconds_*` histograms. There is no equivalent
  pane that answers "is the **browser** slow?" — LCP, CLS, INP and route
  transition latency are unmeasured, so a "the app feels janky"
  complaint has nothing to compare against.
- The four backend timers report server-side p99, and slice-5 trace
  waterfalls show per-request browser → backend timing — but neither
  surface exposes a **time-series** view of user-perceived performance.
  A trace is one user, one action; a metric is the distribution over
  every user, every action, every release. RUM lives in the latter.
- Slice-5's design.md explicitly enumerates this gap under "Open
  Follow-ups": *"Frontend RUM metrics slice (Web Vitals, route timing,
  long tasks) shipping browser-emitted metrics through the same
  Collector."* This change is that slice.

This change introduces the sixth observability slice — **frontend RUM
metrics** — by adding the OpenTelemetry browser metrics SDK to the
frontend, capturing Web Vitals (LCP, CLS, INP, FCP, TTFB) via the
official `web-vitals` library, capturing route-transition latency via a
React Router listener, capturing main-thread `longtask` events via the
Performance Observer, and exporting all of them as OTLP metrics to the
existing Collector. The Collector gains a metrics pipeline that exposes
the FE-emitted series on its `/metrics` scrape endpoint; Prometheus
gains one scrape target. Grafana gains a new provisioned **Frontend
overview** dashboard.

**Why Web Vitals + route timing + long tasks, and not the full RUM
surface (network info, device class, geo, custom marks)?** The three
chosen signals are the canonical industry answer to "is the browser
healthy?" Web Vitals (LCP, CLS, INP) are the Google-standardised
user-perceived performance signals and the only browser metrics that
correlate with revenue and search ranking in published studies; route
timing fills the SPA gap that Web Vitals do not cover (Vitals only
report once per page load, not per route transition); long tasks
expose the single most common SPA pathology (main-thread jank from
unsplit work). Everything else — network info, device class, custom
business marks — is breadth-without-depth at this stage and overlaps
with what a hosted RUM vendor would later cost-justify. Recorded in
`design.md` Decision 1.

**Why ship FE metrics via the existing OTel Collector and not direct
to Prometheus from the browser?** Prometheus is pull-based; a browser
cannot be scraped (no stable URL, no lifecycle the scraper can rely
on). The Collector already accepts FE OTLP from the browser at
`:4318` with the slice-5 CORS allowlist; adding a second
`metrics` pipeline reuses the same receiver, the same CORS, the same
origin-validation pass, and the same path that traces already take.
The browser SDK speaks OTLP/HTTP for metrics with the same `traceparent`-
shaped HTTP semantics; no new wire path appears. The Collector is the
canonical FE telemetry hop in any production-shape OTel deployment.
Recorded in `design.md` Decision 2.

**Why expose Collector metrics via the `prometheus` exporter (pull-
scrape) and not push to Prometheus via `prometheusremotewrite`?**
Slice 1 chose Prometheus's pull-scrape model for the backend
(`/actuator/prometheus`). Mirroring that on the Collector keeps both
metrics surfaces uniform: Prometheus is the system of record, every
target is a scrape target, the failure mode is "did the scrape work?"
not "did the push succeed?" and the cardinality cap lives in one
place (Prometheus relabel_config + a Collector-side filter). The
`prometheusremotewrite` exporter is the right call when the metrics
store is far from the Collector and the network is unreliable; in
local dev they share a docker network. Recorded in `design.md`
Decision 3.

**Why a single "Frontend overview" dashboard and not split into
Web-Vitals / Route-timing / Long-tasks panels?** The Backend overview
is a single dashboard with RED, DB-pool, JVM, and business-timer
panels. Mirroring the same one-dashboard-per-service shape on the FE
side keeps Grafana's left rail tidy, makes the implicit FE↔BE
comparison obvious (open two tabs, same shape), and avoids the
maintenance cost of provisioning N near-empty dashboards. The four
sections (Web Vitals, route timing, long tasks, request volume) become
four rows on one dashboard, matching the backend overview's row
structure. Recorded in `design.md` Decision 4.

**Why head-sample 100% and emit aggregates at the SDK?** Same answer
as slice 5 traces: local dev has no real traffic; sampling makes
demos require lucky timing. The browser metrics SDK already
aggregates at the histogram level on the client (one OTLP export every
N seconds carries the histogram bucket counters since last export, not
one POST per Web Vital event), so the byte-rate is already small.
Tail sampling at the Collector — a real production concern — is
recorded as a future slice that should also unify the FE+BE policy.
Recorded in `design.md` Decision 5.

**Why long tasks via the `PerformanceObserver('longtask')` API and
not Long Animation Frames (LoAF) or the newer `event-timing` API?**
The Long Tasks API ships in every evergreen browser since 2017;
LoAF requires Chrome 123+. The Long Tasks signal is "main thread
blocked > 50 ms" — coarse but universally available, and matches
what an INP regression actually feels like to a user. LoAF is a
sharper instrument for the same wound and is worth revisiting in a
future slice; today the universal-support story wins. Recorded in
`design.md` Decision 6.

**Why use the official `web-vitals` npm package and not measure
LCP/CLS/INP directly from `PerformanceObserver`?** The Google
`web-vitals` library is the canonical source: it handles the
non-obvious edge cases (LCP candidates being replaced before they
become final, CLS sessions, INP event-timing buffering across
interactions) that hand-rolling gets wrong. Wrapping it with an
OTel-metrics adapter is ~40 lines and isolates the version pin so
future Web Vitals revisions land via `pnpm up web-vitals` rather
than a code rewrite. Recorded in `design.md` Decision 7.

## What Changes

- **Frontend — pin three new packages** in `frontend/package.json`:
  - `web-vitals` (Google's official Web Vitals library, peer-dep-free,
    ~2 KB gzipped).
  - `@opentelemetry/sdk-metrics` (browser-compatible MeterProvider +
    PeriodicExportingMetricReader).
  - `@opentelemetry/exporter-metrics-otlp-http` (OTLP/HTTP exporter
    for metrics, mirrors the trace exporter package already on
    `package.json`).
- **Frontend — new `frontend/src/observability/meter.ts`** exporting
  one function `bootstrapMetrics()`. The function (a) constructs a
  `MeterProvider` sharing the same `Resource` as `tracer.ts`
  (`service.name=frontend`, `service.version` from
  `import.meta.env.VITE_APP_VERSION`), (b) registers one
  `PeriodicExportingMetricReader` exporting via
  `OTLPMetricExporter` to `http://localhost:4318/v1/metrics` by
  default (overridable via `VITE_OTEL_METRICS_ENDPOINT`,
  `exportIntervalMillis` configurable via
  `VITE_OTEL_METRICS_EXPORT_INTERVAL_MS`), (c) wires the
  `web-vitals` library so each finalised metric (`onLCP`, `onCLS`,
  `onINP`, `onFCP`, `onTTFB`) records into a Histogram named
  `web_vitals_<metric>`, (d) wires a React Router `useLocation`
  listener that records into a Histogram named
  `route_change_duration_ms` keyed by the matched route template
  (`/home`, `/users/{userId}`, etc. — the route template, NOT the
  resolved path; ids are stripped at the source for the same
  cardinality reason slice 5 redacts at the Collector), and (e) wires
  a `PerformanceObserver({type: 'longtask', buffered: true})` that
  records into a Histogram named `long_task_duration_ms`.
- **Frontend — `bootstrapMetrics()` is called from `main.tsx`** right
  after `bootstrapTelemetry()` and before `createRoot`, so the
  `web-vitals` observers attach before React paints anything.
  Both bootstrap functions share the same `VITE_OTEL_ENABLED` gate
  (the metrics half is a no-op when the gate is off, same as
  tracer.ts).
- **Frontend — new `frontend/src/observability/route-timing.tsx`**
  exporting a `<RouteTimingObserver />` component that subscribes to
  React Router's `useLocation` and calls into `meter.ts` whenever the
  pathname changes. Rendered inside `<BrowserRouter>` in `App.tsx`
  so it has router context. The component renders nothing.
- **Frontend — `service.name=frontend` and `service.version` resource
  attributes are extracted into a shared
  `frontend/src/observability/resource.ts`** so `tracer.ts` and
  `meter.ts` both import the exact same `Resource` instance. The
  slice-5 inline construction in `tracer.ts` moves to this shared
  module; no behaviour change for traces.
- **Infra — Collector OTLP/HTTP receiver already allows `:4318`**;
  no CORS change. The new pipeline adds a `metrics` block to
  `infra/observability/collector/collector-config.yaml`:
  - Receiver: `otlp` (existing).
  - Processors: `batch` (existing); `filter/drop_high_cardinality`
    (new) — drops any metric data point whose `http.route` or
    `route.template` attribute looks unredacted (matches `[0-9a-f]{8,}`
    or `/[0-9]{4,}/`), as a defence-in-depth guard mirroring the
    slice-5 redaction processor.
  - Exporter: `prometheus` (new) — exposes the FE metrics on
    `0.0.0.0:8889/metrics` inside the Collector container, mirroring
    the slice-1 pull-scrape pattern.
- **Infra — Collector compose entry exposes port 8889**.
  `docker-compose.yml` adds `"8889:8889"` to the `collector`
  service so Prometheus (running on the same docker network) can
  reach the Collector's `prometheus` exporter via its container DNS
  name `collector:8889` and so a developer can `curl
  localhost:8889/metrics` directly.
- **Infra — Prometheus scrape config gains a `collector` job** in
  `infra/observability/prometheus/prometheus.yml`:
  - `job_name: collector`
  - `metrics_path: /metrics`
  - `targets: ["collector:8889"]`
  - `scrape_interval: 15s` (same as backend).
- **Infra — new Grafana dashboard
  `infra/observability/grafana/dashboards/frontend-overview.json`**
  provisioned by the existing `dashboards.yaml`. Four rows of panels:
  - **Web Vitals**: LCP p75, INP p75, CLS p75 (the three Web Vitals
    that Google's [Core Web Vitals](https://web.dev/vitals/) report
    uses), plus FCP and TTFB as time-series.
  - **Route timing**: `route_change_duration_ms` p50/p95/p99,
    grouped by `route` label.
  - **Long tasks**: `long_task_duration_ms` count over time and
    sum-of-duration over time.
  - **Request volume from the browser**: count of `web_vitals_lcp`
    observations per minute (proxy for sessions, matching the BE
    overview's `http_server_requests_seconds_count` rate row).
- **E2E — new Playwright spec
  `e2e/tests/observability.frontend-rum-metrics.spec.ts`** that
  drives one authenticated session through the home page and at
  least one route transition, then asserts:
  - The Collector's `/metrics` endpoint
    (`http://localhost:8889/metrics`) contains lines for
    `web_vitals_lcp_bucket` and `route_change_duration_ms_bucket`
    carrying the label `service_name="frontend"`.
  - Prometheus's `/api/v1/query` reports at least one sample for
    `web_vitals_lcp_bucket{service_name="frontend"}` (proves the
    full FE → Collector → Prometheus path, not just the Collector
    surface).
  - Mirrors the slice-5 skip-on-unreachable pattern: the spec calls
    `test.skip(...)` when `http://localhost:8889/metrics` or the
    Prometheus API is not reachable so the spec stays green when
    the observability profile is not running.
- **README — `### Frontend RUM metrics` subsection** added under
  the existing `## Local observability` section. Documents the
  `VITE_OTEL_ENABLED=true pnpm dev` run loop, the new Collector
  scrape port (8889), the Prometheus job name (`collector`), and
  the Frontend overview dashboard URL
  (`http://localhost:3000/d/frontend-overview`).

## Capabilities

### New Capabilities

(None — this slice extends the existing `observability` capability.)

### Modified Capabilities

- `observability`: New requirements covering the frontend OTel
  metrics SDK bootstrap, the `web-vitals` adapter, the React Router
  route-timing observer, the `PerformanceObserver` long-task
  observer, the Collector metrics pipeline with high-cardinality
  filter and `prometheus` exporter, the new Collector scrape target
  in Prometheus, the provisioned Frontend overview dashboard, the
  Playwright end-to-end test, and the README run loop. No existing
  requirement is removed; the slice-5 FE bootstrap requirements
  remain unchanged in shape.

## Impact

- **Frontend**: three new runtime dependencies (`web-vitals`,
  `@opentelemetry/sdk-metrics`,
  `@opentelemetry/exporter-metrics-otlp-http`); new files
  `frontend/src/observability/meter.ts`,
  `frontend/src/observability/route-timing.tsx`,
  `frontend/src/observability/resource.ts`; one new
  `bootstrapMetrics()` call in `main.tsx`; one new
  `<RouteTimingObserver />` element inside `<BrowserRouter>` in
  `App.tsx`; the slice-5 `bootstrapTelemetry()` is refactored to
  import the shared `Resource` (no behaviour change).
- **Infra — Collector**: one new pipeline (`metrics`), one new
  processor (`filter/drop_high_cardinality`), one new exporter
  (`prometheus` on `:8889`). One new published port on the
  collector compose entry. No new containers.
- **Infra — Prometheus**: one new scrape job. No new containers.
- **Infra — Grafana**: one new provisioned dashboard JSON. The
  existing `dashboards.yaml` provider picks it up automatically;
  no provisioning change.
- **Backend**: no changes.
- **E2E**: one new spec; no new dependencies. Runs under the
  existing e2e job; the observability profile is already started
  by the slice-4 e2e containerization landed in
  `2026-05-14-containerize-e2e-job`.
- **CI**: no new jobs.
- **Bundle size**: `web-vitals` is ~2 KB gzipped;
  `@opentelemetry/sdk-metrics` + `exporter-metrics-otlp-http` adds
  roughly 30–40 KB gzipped. The `VITE_OTEL_ENABLED` gate keeps the
  default dev/build bundle unchanged, mirroring slice 5. A future
  "FE production bundle" slice may move both `bootstrapTelemetry`
  and `bootstrapMetrics` behind a dynamic `await import()`.
- **Cardinality**: the FE route-timing histogram is labelled by
  matched route template only (the React Router `path` string from
  the `<Route path>` definition, not the URL). The
  Collector-side `filter/drop_high_cardinality` processor is a
  defence-in-depth guard, not the primary control. Web Vitals
  histograms have no per-request labels; long-task histograms have
  no per-request labels. Per-page-load cardinality is bounded by
  the number of routes defined in `App.tsx` (currently 5).
