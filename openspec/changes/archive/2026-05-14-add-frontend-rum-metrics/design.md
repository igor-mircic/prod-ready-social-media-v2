# add-frontend-rum-metrics — Design

## Context

Slices 1–5 of observability shipped:

- **Slice 1 (metrics):** Prometheus + Grafana, four `@Timed` business
  hot paths, `http_server_requests_seconds_*` auto-instrumentation,
  Backend overview dashboard, pull-scrape via `/actuator/prometheus`.
- **Slice 2 (logs):** ECS-format JSON on stdout, `request.id` /
  `user.id` MDC fields, one `backend.access` line per request.
- **Slice 3 (traces):** OTel Java agent → OTLP/HTTP → Tempo (later
  re-pointed at the Collector in slice 4); `trace.id` / `span.id` flow
  into the ECS log lines.
- **Slice 4 (log shipping):** OTel Collector as the new single
  shipping point; two pipelines (`traces` → Tempo, `logs` →
  filelog → Loki); Grafana log↔trace correlation provisioned.
- **Slice 5 (frontend traces):** Browser OTel SDK with
  `service.name=frontend`, W3C `traceparent` on every backend fetch,
  Collector CORS allowing `:5173` / `:4173`, path-segment redaction
  in the `traces` pipeline, Tempo service-graph datasource. Gated by
  `VITE_OTEL_ENABLED`.

Slice 5's design.md explicitly lists this slice as the next open
follow-up: *"Frontend RUM metrics slice (Web Vitals, route timing,
long tasks) shipping browser-emitted metrics through the same
Collector."* It also lists the future "Frontend overview dashboard"
that this slice ships.

The state immediately before this change:

- The Collector listens on `:4318` (OTLP/HTTP) and `:4317`
  (OTLP/gRPC). The HTTP listener accepts traces from the browser and
  logs from the filelog receiver but has **no metrics pipeline** —
  the OTel agent on the backend was explicitly disabled from
  emitting metrics over OTLP (slice 3 Decision: agent ships spans
  only; metrics travel via the slice-1 Prometheus scrape).
- Prometheus has one scrape target: `host.docker.internal:8080`
  (the backend's `/actuator/prometheus`). There is no second target.
- The Collector's compose entry publishes `:4317` and `:4318` to the
  host. It does NOT publish a metrics surface; there is nothing
  Prometheus could scrape it for.
- `frontend/src/observability/tracer.ts` constructs a `Resource`
  inline with `service.name=frontend` and `service.version=` the
  Vite-injected `VITE_APP_VERSION`. The construction is duplicated
  in a way that a sibling metrics module would have to repeat.
- `frontend/src/main.tsx` calls `bootstrapTelemetry()` exactly once
  before `createRoot`, gated by `VITE_OTEL_ENABLED=true`.
- React Router is in use (`react-router-dom@7.x`) with five routes
  defined in `App.tsx`: `/login`, `/signup`, `/home`, `/users/:userId`,
  `/` (redirect), `*` (404). Route templates are static strings on
  `<Route path>`.
- `infra/observability/grafana/dashboards/backend-overview.json` is
  the only provisioned dashboard. The provisioning provider in
  `dashboards.yaml` watches the directory and auto-picks new JSON
  files.

Constraints carried from prior slices, honoured by this slice:

- **No high-cardinality labels.** Slice 1 banned per-user / per-post
  ids from Prometheus labels; slice 5 banned them from span
  attributes that drive trace search. We extend that to FE metric
  attributes: route-timing is keyed by route template, never by
  resolved path.
- **Default `docker-compose up` starts only `postgres`.** The
  observability profile gate is unchanged.
- **The `VITE_OTEL_ENABLED` gate is the single FE telemetry
  switch.** A developer who has not opted into telemetry sees no
  behaviour change.
- **No backend source changes.** Slice 5 promised this; this slice
  inherits the promise.
- **No new containers.** The Collector and Prometheus already exist;
  the slice extends their configuration but does not introduce a new
  service.

## Goals / Non-Goals

**Goals:**

- When `VITE_OTEL_ENABLED=true`, the frontend exports Web Vitals
  (LCP, CLS, INP, FCP, TTFB), route-transition durations, and
  long-task durations as OTLP metrics to the existing Collector at
  `http://localhost:4318/v1/metrics`.
- Every exported metric data point carries
  `service.name=frontend` and `service.version` as resource
  attributes, matching the slice-5 trace resource exactly.
- The Collector exposes the FE-emitted metrics on a Prometheus
  scrape endpoint at `:8889/metrics` inside the docker network.
- Prometheus scrapes that endpoint as a new `collector` job.
- A reader querying Prometheus for `web_vitals_lcp_bucket{
  service_name="frontend"}` sees data after one page load in a
  browser with the gate enabled.
- Grafana provisions a `Frontend overview` dashboard with four
  rows: Web Vitals, route timing, long tasks, session-rate proxy.
- One Playwright spec proves the chain end-to-end: drive a
  browser through one route transition, then assert that
  Prometheus's `/api/v1/query` reports samples for the
  FE-emitted histograms.
- Route-timing labels are bounded by the route-template set
  declared in `App.tsx` (currently 5). No per-id labels reach
  Prometheus.
- The slice-5 `Resource` construction in `tracer.ts` is refactored
  into a shared `resource.ts` so `tracer.ts` and `meter.ts`
  cannot drift on `service.name` / `service.version`.

**Non-Goals:**

- **Frontend error capture.** Errors, unhandled rejections, React
  error boundaries remain out of scope (slice 7 per slice-5's
  follow-up list). When that slice lands, errors will hang off the
  trace spans slice 5 emits — independent of this slice's metrics.
- **Frontend log shipping.** Browser `console.error` does not flow
  to Loki. Off scope, no current consumer.
- **Alerting / SLOs / error-budget burn-rate.** Every prior slice
  has deferred this and this slice continues that deferral. The
  Frontend overview dashboard is for human eyeballs only.
- **Tail sampling.** Local default is 100% head sampling for traces
  (slice 5) and OTLP histogram aggregation at the SDK
  (`PeriodicExportingMetricReader`'s default delta-temporality
  aggregation, every 15 s) for metrics. A future slice unifies
  FE+BE policy.
- **Backend metric ingestion via OTLP.** The backend metric path
  remains pull-scrape on `/actuator/prometheus`. This slice does
  NOT collapse the BE and FE metrics paths into one shape; that
  is a future refactor and orthogonal to this slice's goal.
- **Web Vitals attribution data.** The `web-vitals` library can
  attach attribution data (e.g. which element drove the LCP
  candidate) via the `attribution` build. We use the standard
  build only — attribution adds bytes and a TBD-cardinality
  attribute story that does not fit one dashboard.
- **`web-vitals` v4 INP "soft navigation" support.** SPA route
  transitions are measured by the route-timing observer, not by
  the experimental Soft Navigations API.
- **Per-user-session correlation between FE metrics and FE
  traces.** A trace carries a `trace.id`; a metric data point
  carries resource attributes only (`service.name` and
  `service.version`). The two are not joined in Prometheus.
  Joining would require exemplars on the FE side and is a
  future enhancement.
- **CI assertion that the FE metrics surface is healthy.** The
  Playwright spec runs only when the observability profile is
  reachable; otherwise it `test.skip`s, matching slice 5's
  pattern. There is no unit test that runs the metrics SDK in
  jsdom (vitest's `happy-dom`/`jsdom` cannot run the OTel
  metrics SDK's timer-based exporter cleanly — see Decision 8).

## Decisions

### Decision 1: Three FE metric families — Web Vitals, route timing, long tasks

**Choice:** Ship exactly three families of FE metrics:

- **Web Vitals**: `web_vitals_lcp_ms`, `web_vitals_cls`,
  `web_vitals_inp_ms`, `web_vitals_fcp_ms`, `web_vitals_ttfb_ms`,
  each as a histogram. CLS is dimensionless; the others are ms.
- **Route timing**: `route_change_duration_ms`, histogram,
  labelled by the React Router `path` template of the destination.
- **Long tasks**: `long_task_duration_ms`, histogram, no per-task
  attributes (only the `service.name` resource).

**Rationale:** These three are the industry-canonical "is the browser
healthy?" surface. Web Vitals are the only browser metrics with
documented user-impact correlation (Google's Core Web Vitals SEO
signal and web.dev publications). Route timing fills the SPA gap that
Web Vitals do not cover (Vitals only fire once per *page load*; a
client-rendered transition fires nothing). Long tasks expose
main-thread jank — the most common cause of INP regression — and ship
with `PerformanceObserver` natively.

**Alternatives considered:**

- *Full RUM surface (network info, device class, geo, custom marks).*
  Breadth without depth; overlaps with hosted RUM vendor offerings;
  not justified at the current scale.
- *Just Web Vitals.* The most minimal answer, but it leaves SPA route
  transitions invisible — and the app is an SPA. Half-measure.
- *Custom React-render-time marks via the Profiler API.* Powerful but
  bespoke; nothing standardised for the dashboard to inherit; better
  done in a later slice once we have a concrete "this render is slow"
  question to answer.

### Decision 2: Ship FE metrics via the existing OTel Collector

**Choice:** The browser SDK posts OTLP metrics to
`http://localhost:4318/v1/metrics`. The Collector adds a `metrics`
pipeline that receives via the same `otlp` receiver slice 5 already
CORS-allows.

**Rationale:** The Collector is the production-shape FE telemetry
hop. Reusing the OTLP receiver means: same CORS allowlist, same
origin-validation pass, same wire path, same auth story (none, in
local dev). The metrics SDK's OTLP/HTTP exporter takes a URL and
nothing else — no new wire concept appears. In any future production
deploy, the Collector will already be the FE → metrics-store hop;
this slice does not invent a path that has to be migrated away from.

**Alternatives considered:**

- *Direct browser → Prometheus via the `remote_write` API.* Prometheus
  accepts `remote_write` from clients in theory but the auth story
  is "no auth or basic auth," the wire format is protobuf
  (a browser-side protobuf encoder is non-trivial), and CORS is
  bypassed but only because Prometheus doesn't ship CORS at all.
  Production deploys never push browser metrics straight to
  Prometheus; rejected as a path that does not generalise.
- *Direct browser → Grafana Cloud RUM (or similar SaaS).* Conflicts
  with the "all telemetry through one Collector" architecture
  slice 4 codified.
- *In-process aggregation only, no export.* The whole point of RUM
  is to make the data queryable; this would be cosmetic.

### Decision 3: Collector → Prometheus via the `prometheus` exporter (pull-scrape)

**Choice:** The Collector runs the `prometheus` exporter on
`0.0.0.0:8889/metrics` and Prometheus adds a `collector` scrape job.

**Rationale:** Slice 1 chose Prometheus's pull model for the backend.
Mirroring that on the Collector side keeps the scrape topology
uniform — every metric target is a scrape target, every failure
mode is "did the scrape work?", every relabel rule lives in
`prometheus.yml`. The Collector's `prometheus` exporter is the
inverse of the OTLP receiver: OTLP comes in, Prometheus-format
goes out. The OTLP histogram → Prometheus histogram conversion
is automatic.

**Alternatives considered:**

- *`prometheusremotewrite` exporter (Collector pushes to
  Prometheus).* The right call when the metrics store is far from
  the Collector and the network is unreliable. In local dev they
  share a docker network — push has no failure mode the pull model
  doesn't already cover, and it splits the "where does Prometheus
  get its data?" question between two configs.
- *Mimir / Cortex / VictoriaMetrics ingestion.* Out of scope. The
  metrics store remains stock Prometheus.

### Decision 4: One "Frontend overview" dashboard

**Choice:** Provision one JSON dashboard
`infra/observability/grafana/dashboards/frontend-overview.json` with
four rows: Web Vitals, route timing, long tasks, session-rate proxy.

**Rationale:** Mirrors the slice-1 Backend overview's
one-dashboard-per-service shape. A reader can open one tab on FE,
one on BE, and the visual structure is comparable (RED → request
volume rate / latency / errors). One dashboard is also one
provisioning concern.

**Alternatives considered:**

- *Three dashboards (Web Vitals / Routes / Long tasks).* Adds
  Grafana left-rail clutter; nothing benefits from the split. Real
  RUM SaaS UIs use a single dashboard per service.
- *Folding into the Backend overview.* Two services, two
  responsibilities; users mentally separate "the server" and
  "the browser." Folding would mix the lenses.

### Decision 5: Head-sample 100%, OTLP histogram aggregation at the SDK

**Choice:** The browser SDK uses the OTel `PeriodicExportingMetricReader`
with `exportIntervalMillis=15000` (matching Prometheus's
`scrape_interval`) and the SDK-default delta-temporality histogram
aggregation. No sampling; every observation contributes to a bucket
counter.

**Rationale:** Same justification as slice 5 traces. Local dev has
no real traffic; sampling makes a one-user-clicks-a-button demo a
gamble. Histogram aggregation at the SDK means the byte rate per
browser is bounded — one POST every 15 s carries N histogram bucket
counters since the previous export, not one POST per Web Vital event.

**Alternatives considered:**

- *Head-sampling 10% of sessions.* Right shape for production, wrong
  call for dev. Bundled into the future tail-sampling slice.
- *Aggregate temporality = cumulative.* Cumulative is the Prometheus
  default for histograms-as-counters, but the Collector's OTLP →
  Prometheus exporter handles temporality conversion. Defaulting
  to delta keeps the SDK simple and the Collector does the work.
- *Push raw events, aggregate at the Collector via
  `metricstransform`.* Loses the SDK-side aggregation benefit
  (every Web Vital event becomes a network call); no advantage in
  exchange.

### Decision 6: Long tasks via `PerformanceObserver('longtask')`, not Long Animation Frames (LoAF)

**Choice:** The long-task observer uses the Long Tasks API
(`PerformanceObserver({type: 'longtask', buffered: true})`).

**Rationale:** Long Tasks ships in every evergreen browser since
2017 — Chrome, Firefox, Safari. LoAF (Long Animation Frames) is a
sharper instrument but ships only in Chromium 123+. The Long Tasks
signal — "main thread blocked > 50 ms" — is exactly what an INP
regression feels like to a user. Universal availability wins for
slice 6; LoAF is worth revisiting once the cross-browser
availability story improves.

**Alternatives considered:**

- *LoAF as the only source.* Misses Firefox and Safari entirely.
- *LoAF if available, fall back to Long Tasks.* Two code paths,
  two histograms (LoAF carries richer attribution; Long Tasks
  doesn't), one comparison story to maintain. Not worth it at
  this stage.
- *No long-task observer.* Loses the main-thread-jank signal that
  pairs with INP. INP without long tasks is "the symptom without
  the cause."

### Decision 7: `web-vitals` library, not hand-rolled `PerformanceObserver`

**Choice:** Use Google's `web-vitals` npm package and wrap its
`onLCP`, `onCLS`, `onINP`, `onFCP`, `onTTFB` callbacks in a thin
OTel-Histogram adapter.

**Rationale:** The non-obvious cases in Web Vitals measurement (LCP
candidates replaced before final, CLS sessions and recovery
behaviour, INP event-timing buffering across user interactions) are
encoded in the library. Hand-rolling these from
`PerformanceObserver({type: 'largest-contentful-paint'})` gets the
happy path right and the edges wrong. The package is 2 KB gzipped,
zero peer dependencies, and the version pin isolates future Web
Vitals revisions to a single dependency bump.

**Alternatives considered:**

- *Hand-rolled `PerformanceObserver` for each Vital.* Less code on
  the dependency manifest, much more code in the application —
  net negative.
- *`@opentelemetry/instrumentation-web-vitals` (if available).* As
  of the SDK version pinned in slice 5, no such auto-instrumentation
  package exists in `@opentelemetry/contrib-instrumentations` for
  browsers. Even if it did, the same `web-vitals` package would be
  the underlying dependency.

### Decision 8: No unit test for `meter.ts`; coverage via Playwright

**Choice:** Skip a vitest unit test for the metrics bootstrap module.
The slice-5 `tracer.test.ts` exists, but the metrics SDK's
`PeriodicExportingMetricReader` is timer-based and uses `setInterval`
in a way that fights the test environment (`happy-dom` / `jsdom`).

**Rationale:** The OTel browser metrics SDK is timer-driven; a unit
test would have to stub `globalThis.setInterval` to deterministically
flush exports, then stub the OTLP HTTP exporter, then assert the
serialised export shape. That test asserts the SDK's behaviour more
than ours. The application code is the resource construction,
the `web-vitals` wiring, and the route-timing listener — each is
small enough to be covered by the existing `tracer.test.ts` pattern
extended to the shared `resource.ts`, plus the Playwright e2e
spec that proves the full chain.

**Alternatives considered:**

- *Full unit-test parity with `tracer.test.ts`.* High cost,
  low value, fragile against SDK internal changes.
- *Component test for `<RouteTimingObserver />` only.* The
  observer is six lines (`useEffect` on `useLocation`); the bug
  surface is in the integration, not in the component.

### Decision 9: Route-timing label is the React Router `path` template

**Choice:** When the route-timing observer fires, the histogram
label `route` is set to the matched route template
(`/users/:userId`, `/home`, etc.) — not the resolved pathname
(`/users/abc-123`).

**Rationale:** Cardinality control at the source. React Router 7
exposes the matched route via `useMatches()` or by walking the
route config and matching against `useLocation().pathname`. The
slice-5 Collector-side `transform/redact-path-ids` processor is the
defence-in-depth backstop; this slice's `filter/drop_high_cardinality`
processor is the second line. Source-side route-templating is the
first line and the only one that's cheap.

**Alternatives considered:**

- *Resolved pathname.* Per-userId metric cardinality, unacceptable.
- *Domain-only (`/users/*`).* Loses the route distinction for
  Grafana grouping.
- *Skip the route label entirely.* Loses the per-route latency
  comparison that is the whole point.

### Decision 10: Refactor slice-5 `Resource` into a shared module

**Choice:** Extract the inline `Resource` construction from
`tracer.ts` into `frontend/src/observability/resource.ts` and have
both `tracer.ts` and `meter.ts` import the same instance.

**Rationale:** Drift between FE traces' `service.name` and FE
metrics' `service.name` would silently split Grafana queries —
half the data tagged `frontend`, half tagged `prod-ready-social-
media-frontend`. The slice-5 inline construction is a foot-gun for
future modules. Centralising it means one decision in one file.

**Alternatives considered:**

- *Duplicate the inline construction in `meter.ts`.* Cheap today,
  expensive in three months when one half gets renamed.
- *Construct a `ResourceBuilder` factory and call it twice.* Same
  outcome with more ceremony; the singleton is fine for a browser
  module.

## Risks / Trade-offs

- **[Risk: bundle-size creep when `VITE_OTEL_ENABLED=false`]** The
  three new packages (`web-vitals`, `@opentelemetry/sdk-metrics`,
  `@opentelemetry/exporter-metrics-otlp-http`) are statically
  imported from `meter.ts`, which is statically imported from
  `main.tsx`. Even when the gate is off, the SDK code is in the
  bundle.
  → **Mitigation:** Matches the slice-5 trade-off exactly. The
  `bootstrapMetrics()` function early-returns when the gate is off,
  so no runtime cost. The "FE production bundle" future slice will
  move both telemetry modules to dynamic `await import(...)`. We
  accept the temporary bundle bloat to keep slice 6 surgical.

- **[Risk: route-timing observer runs before route config is
  available]** The `<RouteTimingObserver />` component depends on
  React Router context. Rendering it outside `<BrowserRouter>`
  silently fails (no `useLocation` context). Easy footgun.
  → **Mitigation:** Component lives inside `<BrowserRouter>` in
  `App.tsx`. The Playwright spec asserts at least one
  `route_change_duration_ms` sample appears after a navigation,
  which catches a misplaced observer.

- **[Risk: long-task observer captures development-only React
  StrictMode noise]** React 19 in StrictMode renders some
  components twice, which can show up as long tasks if the
  developer machine is slow.
  → **Mitigation:** Long tasks are emitted by both
  `pnpm dev` and `pnpm build` previews; the metric semantics are
  honest. The Frontend overview dashboard is for human eyeballs
  in dev, not for alerting. If false positives become a problem
  in CI, the e2e Playwright spec can run against `pnpm preview`
  (StrictMode-free) instead of `pnpm dev`.

- **[Risk: Prometheus scrapes the Collector before it has any
  series]** A fresh observability stack with no browser traffic
  yet means `:8889/metrics` returns an empty body. Prometheus's
  Grafana panels will show "no data" instead of zero, which
  reads as broken.
  → **Mitigation:** Same as slice 1 — the Backend overview was
  flat for the first hour of dev too. Documented in the README's
  Frontend RUM section: "expect empty panels until you load the
  app with the gate enabled."

- **[Risk: histogram bucket choice locks in the dashboard]** The
  OTel SDK ships default histogram bucket boundaries that are
  reasonable for ms-scale metrics. Tweaking buckets after the
  dashboard ships means recomputing every panel.
  → **Mitigation:** Accept the SDK defaults for slice 6. CLS is
  dimensionless and the default buckets are tuned for ms; this
  produces a histogram with most observations in the small
  buckets. We accept the visual oddness for slice 6 and revisit
  bucket overrides if the dashboard becomes hard to read.

- **[Risk: the Collector's `prometheus` exporter sets metric names
  with prefixes that conflict with the Backend overview]** The
  exporter prefixes metric names by default with the receiver
  source. Browser-emitted `web_vitals_lcp_ms` could land as
  `otelcol_web_vitals_lcp_ms` if the wrong exporter option is
  picked.
  → **Mitigation:** Explicitly set `add_metric_suffixes: false`
  and `namespace: ""` (no prefix) on the `prometheus` exporter
  block. The Playwright spec's Prometheus query for
  `web_vitals_lcp_bucket{...}` catches a prefix regression.

- **[Risk: Web Vitals INP can arrive after `beforeunload`]** INP
  is finalised on visibility change or `pagehide`, which can fire
  during a navigation that the export reader hasn't flushed for.
  → **Mitigation:** The `web-vitals` library calls
  `addEventListener('visibilitychange', ...)` itself; the OTel
  SDK's `PeriodicExportingMetricReader` flushes on
  `forceFlush()`. We call `meterProvider.forceFlush()` from a
  `visibilitychange` listener as part of `bootstrapMetrics()`,
  same hook the library uses.

## Migration Plan

This is an additive slice. No data model changes, no API changes, no
behavioural changes when `VITE_OTEL_ENABLED` is unset (the default
in CI and most local dev).

Deploy order does not matter — the Collector accepts metrics
regardless of whether Prometheus is scraping yet, and Prometheus
scrapes regardless of whether the Collector has any series. A fresh
checkout that pulls this slice gets the new dashboard JSON, the new
Prometheus job, and the new Collector pipeline at the same time;
docker compose picks them up on the next `--profile observability up`.

**Rollback:** revert the change. There is no persisted state to
clean up.

## Open Questions

- **CLS bucket boundaries.** The OTel SDK histogram defaults are
  tuned for ms; CLS is dimensionless and typically in the
  0.001–0.5 range. The dashboard may show an effectively single-
  bucket histogram for CLS. We accept the trade-off for slice 6
  but note it for a future "histogram tuning" pass.
- **Session-id correlation.** Should each FE-emitted metric data
  point carry a `session.id` resource attribute so Grafana can
  filter by session? Skipped for slice 6 (no session-id machinery
  exists yet on the frontend) but worth recording as a follow-up
  if/when a session-id slice lands.

## Open Follow-ups

These are explicitly NOT in scope for this slice but are recorded
for the next observability slice's "Why" section:

- **Frontend errors slice (formerly "slice 7" per slice-5 design).**
  React error boundary, window error / unhandledrejection capture,
  hung off the trace spans slice 5 emits.
- **Alerting / SLO slice.** Wires Alertmanager and defines SLIs/SLOs
  for the BE hot paths and the FE Web Vitals (e.g. LCP p75 < 2.5 s
  is the "good" Core Web Vital threshold).
- **Tail-sampling slice unifying FE + BE policy.** Carried forward
  from slice 5.
- **Dynamic-import code splitting for `tracer.ts` and `meter.ts`.**
  Carried forward from slice 5; this slice grows the static
  telemetry footprint, making the deferral slightly more costly.
- **Histogram bucket tuning** for CLS specifically, and a
  cross-Vitals bucket audit.
- **OTel Collector exemplars** to join FE metric data points back
  to FE trace IDs in Grafana.
- **Service-graph rendering** as a panel on the Frontend overview
  dashboard (the datasource was provisioned in slice 5; no panel
  exists yet).
