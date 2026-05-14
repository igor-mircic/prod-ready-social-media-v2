# add-frontend-traces

## Why

Slices 1 (metrics), 2 (logs), 3 (traces), and 4 (log shipping) of observability
are landed. The backend now emits the three pillars to a single OTel Collector,
Grafana provisions bidirectional log↔trace pivots, and the same `trace.id`
flows from a Spring controller through Tempo, Loki, and Prometheus exemplars.
Everything is in place — **except the browser is dark**. The practical
consequences today:

- The trace waterfall in Tempo starts at the Spring controller. Every "why
  was that request slow?" question implicitly blames the backend, because
  the time between "user clicked the button" and "the controller received
  the request" is invisible. In real production this gap is typically
  dominated by client-side concerns (bundle parse, React render, blocked
  main thread) that the backend cannot see.
- The four `@Timed` business hot paths report server-side p99 latency, but
  a user-perceived "posting feels slow" answer requires also knowing what
  happened on the user's device before the fetch even fired. The slice-1
  dashboard cannot answer "is this latency in our code or in the network?"
- The frontend produces zero telemetry — no spans, no errors, no metrics —
  so the slice-4 Grafana data-link pivots only ever surface backend-emitted
  signals. The `service` label in Tempo is always `backend`.

This change introduces the fifth observability slice — **frontend traces** —
by adding the OpenTelemetry browser SDK to the frontend, propagating the W3C
`traceparent` header on every backend API request, and shipping browser-emitted
spans to the existing OTel Collector. After this change, the Tempo trace
waterfall for one user action (e.g. clicking "Post") starts at the click,
includes the auto-instrumented `fetch` span, and continues seamlessly into
the backend spans — one `trace.id`, one tree, two `service` values
(`frontend` and `backend`).

**Why introduce the browser SDK now and not after RUM / errors / Web Vitals?**
The three frontend pillars layer on top of traces, not alongside them. Browser
errors are most useful when attached as span events to the trace that produced
them (slice-4 collector already supports event-on-span). Web Vitals (LCP, INP,
CLS) need a `service.name=frontend` resource to be queryable from the same
Grafana selector. Trace propagation is the *structural* piece — once
`traceparent` flows browser→backend, the FE and BE telemetry stops being
two silos. Doing traces first means every later FE slice gets correlation
for free. Recorded in `design.md` Decision 1.

**Why ship directly from the browser to the Collector at `:4318` and not
via the Vite dev proxy?** The Vite proxy would let the browser POST to a
same-origin path that Vite forwards to `host:4318` — no CORS, no preflight.
That convenience is dev-only. In any non-dev deploy the browser will hit the
Collector cross-origin and the wire path will need real CORS. Going direct
in dev validates the same CORS handshake every production hop will use,
keeps the proxy config in `vite.config.ts` narrow (only `/api/v1` and
`/actuator`, both backend), and surfaces a misconfigured `Access-Control-
Allow-Origin` immediately rather than at the first cloud deploy. The CORS
config on the Collector's OTLP/HTTP receiver is six lines of YAML.
Recorded in `design.md` Decision 2.

**Why redact path-segment PII at the Collector rather than in the
application?** The frontend has no equivalent of Spring's `http.route`
template — an outgoing `fetch('/api/v1/users/abc-123/follow')` is a string,
not a parameterised route. Doing redaction in TypeScript means duplicating
route patterns next to the routing code (which lives elsewhere) and the
discipline of "every new route also adds a redaction rule" silently rots.
Doing it at the Collector means one `transform` processor with one regex
set redacts both FE and BE spans — defense in depth, single source of
truth, and the rule survives application refactors. Recorded in
`design.md` Decision 3.

**Why head-sample 100% and defer tail sampling?** Local dev has no real
traffic; head-sampling 100% means every click produces a usable trace and
demos do not require lucky timing. Tail sampling (drop boring traces, keep
errors and the slow tail) is a real production decision but introduces a
new collector pipeline (`tail_sampling` processor with policy YAML) that
deserves a slice of its own — ideally one that unifies FE + BE sampling
policy. Bundling it here would balloon scope and force a sampling-rate
choice no real traffic justifies. Recorded in `design.md` Decision 4.

**Why `service.name=frontend` and not the package name (`prod-ready-social-
media-frontend`)?** Slice 1 set the backend's common Micrometer tag
`service=backend`. Mirroring that with `service=frontend` keeps the Grafana
service selector binary and tidy (`{service="frontend"}` /
`{service="backend"}`) — clean for both the Tempo service dropdown and
the existing Backend overview dashboard's PromQL `by(service)` style.
Recorded in `design.md` Decision 5.

## What Changes

- **Frontend — pin the OTel browser SDK packages** in `frontend/package.json`:
  `@opentelemetry/sdk-trace-web`, `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/context-zone`, `@opentelemetry/resources`,
  `@opentelemetry/semantic-conventions`, `@opentelemetry/instrumentation`,
  `@opentelemetry/instrumentation-fetch`,
  `@opentelemetry/instrumentation-document-load`,
  `@opentelemetry/instrumentation-user-interaction`. No application-source
  dependency on any package outside `frontend/src/observability/`.
- **Frontend — new `frontend/src/observability/tracer.ts`** exporting one
  function `bootstrapTelemetry()`. The function registers a
  `WebTracerProvider` with a `Resource` carrying `service.name=frontend`,
  `service.version` from `import.meta.env.VITE_APP_VERSION` (Vite-injected
  at build time), a `ZoneContextManager` for cross-async context, a
  `BatchSpanProcessor` exporting via `OTLPTraceExporter` to
  `http://localhost:4318/v1/traces` by default (overridable via
  `VITE_OTEL_TRACES_ENDPOINT`), and registers three auto-instrumentations:
  `DocumentLoadInstrumentation`, `FetchInstrumentation` (with
  `propagateTraceHeaderCorsUrls` restricted to the backend origin), and
  `UserInteractionInstrumentation` (click and submit events only).
- **Frontend — `frontend/src/main.tsx` calls `bootstrapTelemetry()`** at
  the top of the module, before `createRoot(...)`, so the
  `DocumentLoadInstrumentation` captures the navigation timing.
- **Frontend — env-var gating**: `bootstrapTelemetry()` is a no-op when
  `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`. The
  default `pnpm dev` loop is unchanged; an opt-in `VITE_OTEL_ENABLED=true
  pnpm dev` (and the corresponding build flag) turns telemetry on.
- **Frontend — Vite proxy stays unchanged**. Browser → Collector traffic
  goes direct to `http://localhost:4318/v1/traces`. Only `/api/v1` and
  `/actuator` go through the Vite proxy.
- **Infra — Collector OTLP/HTTP receiver gains CORS** in
  `infra/observability/otel-collector-config.yaml`:
  `allowed_origins: ["http://localhost:5173", "http://localhost:4173"]`
  (Vite dev + preview), `allowed_headers: ["*"]`. The gRPC receiver is
  unchanged; the Java agent's path is untouched.
- **Infra — Collector gains a `transform` processor** that redacts
  high-cardinality path segments from `http.url`, `url.full`, and the
  span name on both FE and BE spans. Patterns: UUID v4, opaque ids
  matching `[0-9a-f]{8,}`. Replacement: a literal token like
  `{id}`. Applied in the `traces/default` pipeline before the Tempo
  exporter.
- **Infra — Tempo datasource provisioning gains a `serviceMap` config**
  in `infra/observability/grafana/provisioning/datasources/tempo.yaml`
  so Grafana's Tempo "Service Graph" panel shows the
  `frontend → backend` edge. No code change; one block of YAML.
- **E2E — new Playwright spec
  `e2e/tests/observability.frontend-traces.spec.ts`** that drives one
  authenticated `POST /api/v1/posts` from the browser and asserts:
  (a) the outgoing fetch carries a W3C `traceparent` header,
  (b) Tempo returns a single trace containing one `service.name=frontend`
  span and one `service.name=backend` span, and
  (c) the backend's ECS log line for that request carries the same
  `trace.id` the browser emitted.
- **README — `### Frontend tracing` subsection** added under the
  existing `## Local observability` section. Documents
  `VITE_OTEL_ENABLED=true pnpm dev`, the click→trace pivot in Grafana's
  Tempo datasource, and the one-trace-two-services shape.

## Capabilities

### New Capabilities

(None — this slice extends the existing `observability` capability.)

### Modified Capabilities

- `observability`: New requirements covering frontend OTel browser SDK
  bootstrap, W3C `traceparent` propagation on backend API requests,
  Collector OTLP/HTTP CORS for the browser origin, path-segment
  redaction at the Collector, FE `service.name=frontend` resource
  attribute, and an end-to-end trace-continuity Playwright test.

## Impact

- **Frontend**: new `frontend/src/observability/` directory; nine new
  `@opentelemetry/*` runtime dependencies; one new call in `main.tsx`
  before `createRoot`; no change to `apiFetch` or any feature code
  (fetch auto-instrumentation hooks the global `window.fetch`).
- **Infra**: Collector config gains a CORS block and a `transform`
  processor; Tempo datasource provisioning gains a `serviceMap` block.
  No new containers, no new ports, no new volumes.
- **Backend**: no changes. CORS at the application layer is still
  disabled. The backend continues to read the W3C `traceparent` header
  via the slice-3 OTel Java agent — same code path, just now sometimes
  populated from a browser instead of always from the agent itself.
- **E2E**: one new spec, depends on the existing observability profile
  being up (the spec is skipped via `test.skip(...)` when the Tempo
  HTTP API is not reachable, matching the slice-3 pattern).
- **CI**: no new jobs. The new E2E spec runs under the existing e2e
  job; the observability stack is already started by the e2e
  containerization landed in `2026-05-14-containerize-e2e-job`.
- **Bundle size**: the OTel browser SDK plus auto-instrumentations adds
  roughly 80–100 KB gzipped to the main bundle. Env-var gating means
  the default dev experience is unaffected; the production build
  ships the SDK only when `VITE_OTEL_ENABLED=true` was set at build
  time (a future "FE production bundle" slice may revisit this with
  dynamic import).
