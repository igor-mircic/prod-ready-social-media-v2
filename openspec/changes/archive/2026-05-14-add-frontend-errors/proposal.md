# add-frontend-errors

## Why

Slice 5 (`add-frontend-traces`) made every browser fetch part of a
two-service trace tree, and slice 6 (`add-frontend-rum-metrics`) gave
the Frontend overview dashboard answers to "is the browser slow?". The
browser is no longer dark for *traces* or *metrics*, but it is still
dark for *errors*. The practical consequences today:

- A `useMutation` failure or a render-time exception shows up as a
  span with `status=ERROR` and no record of the underlying
  JavaScript exception. The trace says "this request failed" but
  not "because `TypeError: Cannot read property 'id' of undefined`
  was thrown at `posts.tsx:42`." Drill-down stops at the network
  boundary.
- A `window.onerror` from a third-party script, an
  `unhandledrejection` from a fire-and-forget promise, or a
  `securitypolicyviolation` from a misconfigured CSP — none of
  these are visible anywhere today. They emit to the developer's
  console and nowhere else; in production they will silently
  affect users.
- Slice 5's design.md and slice 6's design.md both record the
  follow-up: *"Frontend errors slice (React error boundary,
  window error / unhandledrejection capture) hanging errors off
  the trace spans this slice emits."* This change is that slice.
- The Frontend overview dashboard (slice 6) has rows for Web
  Vitals, route timing, long tasks, and request volume. It has
  no row for **error rate** — the single most actionable browser
  signal. A "the app is broken" complaint has no time-series
  evidence to compare against.

This change introduces the seventh observability slice — **frontend
errors** — by capturing all four canonical browser error surfaces
(React error boundary, `window.onerror`, `unhandledrejection`,
`securitypolicyviolation`), routing each captured error to three
sinks via the existing OTel Collector: (1) as a span exception event
on the active OTel span via `span.recordException()` (slice-5 path),
(2) as a structured ECS log line via the new `@opentelemetry/api-logs`
+ `@opentelemetry/sdk-logs` OTel logs pipeline through the Collector
to Loki (mirroring the slice-2/slice-4 backend log shape under
`event.dataset=frontend.error`), and (3) as a `frontend_errors_total`
counter increment on the slice-6 metrics pipeline. The Collector
gains a logs pipeline for FE telemetry and an attribute processor
that redacts PII patterns as last-line defence. The Frontend overview
dashboard gains an **Errors** row.

**Why capture errors as span events on the existing trace AND as a
parallel ECS log line?** The two surfaces answer different
questions. A span event is the right shape when you have a trace
in hand and want to know what blew up inside it — Tempo renders
exceptions inline on the span waterfall. A log line is the right
shape when you want to text-search ("any `TypeError` from
`posts.tsx`?") or aggregate ("top 10 fingerprints across all
sessions in the last 24h"). Pure span-event answers the
trace-first workflow; pure log-line answers the search-first
workflow. Production tools (Sentry + Datadog Browser RUM, Honeycomb
+ Splunk) always run both. The backend already does both — every
HTTP request has an access log line *and* a trace; the frontend
should match. Recorded in `design.md` Decision 1.

**Why the OTel logs SDK and not a custom HTTP POST to a Collector
endpoint?** `@opentelemetry/api-logs` and `@opentelemetry/sdk-logs`
are the canonical OTel browser path for log records and ship with
an OTLP/HTTP exporter that targets the same Collector receiver
slice 5 wired (port 4318). No new CORS rule, no new wire path,
no new receiver. The Collector accepts logs over OTLP and the
existing `loki` exporter from slice 4 routes them to Loki with
ECS-shaped attributes. Custom HTTP would require a parallel
authentication path, a parallel batching/retry layer, and a
parallel serialisation contract — all of which the OTel SDK
already provides. Recorded in `design.md` Decision 2.

**Why fingerprint-based SDK-side dedup and rate-limit?** A render
loop or a `setInterval` firing into a broken handler can produce
thousands of identical exceptions per minute. Without dedup, each
becomes a span event, a log line, a counter increment — saturating
the Collector, blowing the Loki ingestion budget, and burying the
single signal in noise. Production tools (Sentry, Bugsnag) all
fingerprint by `error.type + first stackframe path:line` and drop
duplicates within a short window (5s default), plus enforce a
hard per-session cap (30 events/min default). The **counter
always increments** even on drops, preserving aggregate accuracy;
only the event-shaped surfaces (span event, log line) are gated.
Recorded in `design.md` Decision 3.

**Why defence-in-depth PII scrubbing at SDK + Collector and not
one or the other?** SDK-side scrubbing is the design decision the
frontend developer thinks about — an allowlist of known-safe
attribute names, regex passes over `error.message` and
`error.stack` for token/email/JWT shapes. It catches the 99% case.
The Collector-side pass is for the 1% the developer never thought
about — a third-party library's exception message that dumps a
raw response body containing a session token, a `JSON.parse(...)`
failure dumping the malformed input, an HTTP-client error whose
`.message` is the URL with a `?token=...` query param. One layer
is "if I forgot"; the other is "if a library I import forgot."
Mirrors the slice-5 path-segment-redaction-at-Collector pattern.
Recorded in `design.md` Decision 4.

**Why attach `user.id` (when authenticated) to error events?** A
production error tool's most-asked question is "is this error
affecting one user or every user?" Without a user attribute, the
answer requires correlating client IPs in nginx logs against
session timestamps — slow, lossy, and impossible in a session-
based auth model. With it, the answer is a single Grafana group-
by. The user ID attached is the opaque UUID already in the
backend's MDC (slice 2); never the email or handle. PII risk is
bounded to "an attacker who already has Loki access can correlate
a UUID with an account" — the same exposure the backend access
log already accepts. Recorded in `design.md` Decision 5.

**Why no breadcrumb buffer (Sentry-style last-N user actions)?**
Slice 5 already emits a span per click, per form submit, per
route change. When an error fires, the *parent trace* already
contains every user interaction that led to it — opening the
error's trace in Tempo IS the breadcrumb trail. A parallel ring
buffer would duplicate state the trace context graph already
holds, with weaker guarantees (the buffer doesn't survive a hard
crash; the trace context, exported in real time, does). Recorded
in `design.md` Decision 6.

**Why defer source-map symbolication?** A stack frame like
`Object.<anonymous> (app-Bz7Lq.js:1:842)` is useless without the
matching source map to resolve back to `posts.tsx:42`. The full
production-shape answer is uploading source maps to a
symbolicator at build time and resolving on the read side
(Sentry's model). That is a meaningful slice in its own right —
build-pipeline changes, a symbol store, a Collector/Grafana
plugin or a separate symbolication service. For local-dev and
the current CI shape, Vite serves unminified bundles and stack
frames are already human-readable; production-built bundles in
this repo today are minified but not yet deployed to any real
server. Source-map symbolication is **deferred** to its own
slice, with an explicit pre-deploy reminder so the gap closes
before any real-server build serves errors to real users.
Recorded in `design.md` Decision 7.

## What Changes

- **Frontend — pin two new packages** in `frontend/package.json`:
  - `@opentelemetry/api-logs` (browser logs API surface).
  - `@opentelemetry/sdk-logs` (browser-compatible
    `LoggerProvider` + `BatchLogRecordProcessor`).
  - `@opentelemetry/exporter-logs-otlp-http` (OTLP/HTTP exporter
    for logs, mirrors the trace and metrics exporters already
    on `package.json`).
- **Frontend — new `frontend/src/observability/error-sink.ts`**
  exporting one function `recordFrontendError(err, kind, ctx?)`.
  The function (a) computes a fingerprint as
  `<error.constructor.name>:<first stackframe path>:<line>`,
  (b) consults an in-memory dedup map: drops the event-shaped
  surfaces (span event, log record) if the same fingerprint
  fired in the last `5000ms` (configurable via
  `VITE_FE_ERROR_DEDUP_WINDOW_MS`), (c) consults an in-memory
  rate-limit counter: drops the event-shaped surfaces if more
  than `30` events have been emitted in the current 60-second
  window (configurable via `VITE_FE_ERROR_RATE_LIMIT`), (d) runs
  the SDK-side PII scrub (regex strip JWT-shaped, email-shaped,
  and long-base64-shaped substrings from `error.message`; keep
  stack frame `path:line:col` but drop any source-snippet
  context), (e) calls `trace.getActiveSpan()?.recordException(err)`
  to attach the exception to the active span, (f) calls the OTel
  logger to emit a log record with severity `ERROR`,
  `event.dataset=frontend.error`, ECS fields (`error.type`,
  `error.message` scrubbed, `error.stack_trace` scrubbed,
  `error.fingerprint`, `kind`, `route` resolved from React
  Router, `user.id` from the slice-5/slice-6 user context shim
  if authenticated), and (g) calls
  `meter.getCounter('frontend_errors_total').add(1, {kind, route})`
  (this increment is **NOT** gated by dedup or rate-limit —
  every error increments the counter).
- **Frontend — new `frontend/src/observability/error-handlers.ts`**
  exporting `installFrontendErrorHandlers()` which (a) attaches a
  `window.addEventListener('error', ev => recordFrontendError(ev.error,
  'error', {filename: ev.filename, lineno: ev.lineno}))` listener,
  (b) attaches a `window.addEventListener('unhandledrejection',
  ev => recordFrontendError(ev.reason, 'rejection'))` listener, and
  (c) attaches a `window.addEventListener('securitypolicyviolation',
  ev => recordFrontendError(new Error(ev.violatedDirective), 'csp',
  {blockedURI: ev.blockedURI}))` listener.
- **Frontend — new `frontend/src/observability/ErrorBoundary.tsx`**
  exporting a `<FrontendErrorBoundary>` class component implementing
  `componentDidCatch(err, info)` which calls
  `recordFrontendError(err, 'boundary', {componentStack: info.componentStack})`
  then renders a minimal fallback UI ("Something went wrong. Refresh
  to retry."). Used to wrap `<App />` in `main.tsx`.
- **Frontend — `bootstrapErrorReporting()`** added to a new
  `frontend/src/observability/errors.ts` (top-level), which (a)
  constructs a `LoggerProvider` sharing the slice-6
  `frontend/src/observability/resource.ts` `Resource` instance,
  (b) registers a `BatchLogRecordProcessor` exporting via
  `OTLPLogExporter` to `http://localhost:4318/v1/logs` by
  default (overridable via `VITE_OTEL_LOGS_ENDPOINT`), (c) calls
  `installFrontendErrorHandlers()`. Called from `main.tsx` after
  `bootstrapTelemetry()` and `bootstrapMetrics()`, gated by the
  same `VITE_OTEL_ENABLED` env var as the prior slices.
- **Frontend — `main.tsx` wraps `<App />` in
  `<FrontendErrorBoundary>`** as the outermost component below
  `<BrowserRouter>` so that boundary catches survive routing.
- **Infra — Collector gains a `logs` pipeline** in
  `infra/observability/collector/collector-config.yaml`:
  - Receiver: `otlp` (existing — same `:4318` HTTP receiver).
  - Processors: `batch` (existing); `attributes/pii_scrub` (new) —
    runs three `update` actions over the `error.message`,
    `error.stack_trace`, and `body` fields applying regex
    `replace` rules: redact JWT-shaped tokens (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`),
    email addresses (`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`),
    and bearer-token-shaped substrings (`\b[A-Za-z0-9+/=]{40,}\b`),
    replacing each match with `[REDACTED]`.
  - Exporter: `loki` (existing — already wired in slice 4).
- **Infra — Collector logs pipeline routes only FE logs to Loki**;
  backend logs continue to ship via Filebeat per slice 4. Routing
  is by `service.name=frontend` resource attribute; a
  `filter/frontend_only` processor on the logs pipeline drops any
  log record whose `resource.service.name != "frontend"` (defence-in-
  depth — BE logs never reach the Collector logs pipeline today,
  but the filter makes the boundary explicit and survives a future
  BE-via-OTLP migration).
- **Infra — Loki receives FE log records under
  `event.dataset=frontend.error`**, mirroring the BE
  `backend.access` dataset shape. No new Loki index, no new
  datasource — the existing slice-4 Loki datasource handles both.
- **Infra — Grafana Frontend overview dashboard gains an Errors
  row** (`infra/observability/grafana/dashboards/frontend-overview.json`):
  - **Error rate**: `sum(rate(frontend_errors_total[5m])) by (kind)`
    — one series per kind (`boundary`, `error`, `rejection`,
    `csp`).
  - **Top fingerprints**: Loki logs panel with query
    `{event_dataset="frontend.error"} | logfmt | line_format "{{.error_fingerprint}} {{.error_message}}"`
    limited to the top 10 by count over the dashboard's time
    range.
  - **CSP violations**: time-series panel of
    `rate(frontend_errors_total{kind="csp"}[5m])`.
- **E2E — new Playwright spec
  `e2e/tests/observability.frontend-errors.spec.ts`** that drives
  one authenticated session, navigates to a dedicated dev-only
  test route `/__dev/throw` (added under `import.meta.env.DEV`
  guard in `App.tsx`) which renders a component that throws on
  mount, then asserts:
  - The Collector's `/metrics` endpoint
    (`http://localhost:8889/metrics`) contains
    `frontend_errors_total{kind="boundary"}` with a value `>= 1`.
  - The Loki API
    (`http://localhost:3100/loki/api/v1/query_range?query=
    {event_dataset="frontend.error"}`) returns at least one log
    line whose `error.type` is the thrown error's class name.
  - Tempo's `/api/search?tags=service.name%3Dfrontend` returns
    at least one trace whose span carries an `exception` event
    with a `exception.type` attribute matching the thrown class.
  - PII assertion: the spec throws an error whose message
    contains a JWT-shaped string; the asserted log line and span
    event must NOT contain the original token (must contain
    `[REDACTED]`).
  - Mirrors the slice-5/slice-6 skip-on-unreachable pattern:
    `test.skip(...)` when the Collector, Loki, or Tempo APIs are
    unreachable.
- **README — `### Frontend errors` subsection** added under the
  existing `## Local observability` section. Documents the four
  capture surfaces, the dedup + rate-limit defaults, the new
  Collector logs pipeline, the new Grafana row, and the
  symbolication gap with a forward pointer to the deferred
  source-maps slice.

## Capabilities

### New Capabilities

(None — this slice extends the existing `observability` capability.)

### Modified Capabilities

- `observability`: New requirements covering the frontend OTel
  logs SDK bootstrap, the four error-capture surfaces (React
  boundary, `window.onerror`, `unhandledrejection`,
  `securitypolicyviolation`), the fingerprint-based dedup and
  rate-limit, the SDK-side PII scrub, the dual-sink routing
  (span event + log record + counter), the Collector logs
  pipeline with attribute-based PII redaction and frontend-only
  filter, the Grafana Errors row, the Playwright end-to-end
  test, and the README run loop. No existing requirement is
  removed; the slice-5 trace requirements and slice-6 metric
  requirements remain unchanged in shape.

## Impact

- **Frontend**: three new runtime dependencies
  (`@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`,
  `@opentelemetry/exporter-logs-otlp-http`); new files
  `frontend/src/observability/errors.ts`,
  `frontend/src/observability/error-sink.ts`,
  `frontend/src/observability/error-handlers.ts`,
  `frontend/src/observability/ErrorBoundary.tsx`; one new
  `bootstrapErrorReporting()` call in `main.tsx`; one new
  `<FrontendErrorBoundary>` wrapper in `main.tsx`; one
  dev-only `/__dev/throw` route in `App.tsx` gated by
  `import.meta.env.DEV`. The slice-6 shared `Resource` is
  reused unchanged.
- **Infra — Collector**: one new pipeline (`logs`), two new
  processors (`attributes/pii_scrub`, `filter/frontend_only`),
  reuse of the existing `loki` exporter. No new container, no
  new published port.
- **Infra — Loki**: receives a second dataset
  (`frontend.error`). No configuration change; Loki indexes by
  label automatically. Storage impact bounded by the SDK-side
  rate cap (30 events/session/minute).
- **Infra — Grafana**: one new row on the existing Frontend
  overview dashboard JSON. No new dashboard, no provisioning
  change.
- **Backend**: no changes.
- **E2E**: one new spec; no new dependencies. Runs under the
  existing e2e job; the observability profile is already
  started by the slice-4 e2e containerization landed in
  `2026-05-14-containerize-e2e-job`.
- **CI**: no new jobs.
- **Bundle size**: `@opentelemetry/sdk-logs` +
  `exporter-logs-otlp-http` adds roughly 25–35 KB gzipped.
  The `VITE_OTEL_ENABLED` gate keeps the default dev/build
  bundle unchanged, mirroring slices 5 and 6. The deferred
  "FE production bundle" slice should move all three
  bootstrap calls behind a dynamic `await import()`.
- **Source-map symbolication**: explicitly **out of scope**.
  Built bundles produce minified stack frames. A separate
  pre-deploy reminder ensures this gap is closed before any
  real-server deploy. See project memory
  `project_source_maps_pre_deploy.md`.
- **Cardinality**: `frontend_errors_total` is labelled by `kind`
  (4 fixed values) × `route` (bounded by React Router template
  list, ~5 today) = 20 series max per session, capped by the
  slice-6 Collector high-cardinality filter as defence-in-depth.
  Loki labels are bounded similarly. No per-fingerprint label
  on the metric (fingerprints live on log lines only —
  unbounded cardinality belongs in the log store, not the
  metric store).
- **PII**: defence-in-depth scrubbing (SDK allowlist + regex,
  Collector regex). `user.id` attached as opaque UUID only —
  same exposure shape the backend access log already accepts.
