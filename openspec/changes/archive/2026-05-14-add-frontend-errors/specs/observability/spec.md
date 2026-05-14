## ADDED Requirements

### Requirement: Frontend bootstraps an OTel `LoggerProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The frontend SHALL bootstrap an OTel `LoggerProvider` before `createRoot` is called in `main.tsx`, gated by the `VITE_OTEL_ENABLED` Vite environment variable.

When `VITE_OTEL_ENABLED` is `true`, the bootstrap SHALL construct
a `LoggerProvider` from `@opentelemetry/sdk-logs`, share the same
`Resource` instance as the slice-5 `tracer.ts` and slice-6
`meter.ts` (via the shared
`frontend/src/observability/resource.ts` module), and register
one `BatchLogRecordProcessor` exporting via `OTLPLogExporter`
from `@opentelemetry/exporter-logs-otlp-http` to
`http://localhost:4318/v1/logs` by default. When
`VITE_OTEL_ENABLED` is unset or `false`, the bootstrap SHALL be a
no-op and SHALL NOT register any provider, listener, or
processor.

The default export endpoint MUST be overridable via
`VITE_OTEL_LOGS_ENDPOINT`. The bootstrap function MUST be named
`bootstrapErrorReporting()` and live in
`frontend/src/observability/errors.ts`.

#### Scenario: Logs provider initialised when telemetry is enabled

- **WHEN** `VITE_OTEL_ENABLED=true` and the app boots
- **THEN** `bootstrapErrorReporting()` constructs a
  `LoggerProvider`, registers a `BatchLogRecordProcessor` with an
  `OTLPLogExporter`, and completes before React mounts the root

#### Scenario: Logs provider remains uninitialised when telemetry is disabled

- **WHEN** `VITE_OTEL_ENABLED` is unset or `false` and the app boots
- **THEN** `bootstrapErrorReporting()` returns immediately without
  side effects and no global logger handler is registered

### Requirement: Frontend captures all four canonical browser error surfaces

The frontend SHALL register listeners that capture errors from
four sources: (1) a React error boundary component
(`<FrontendErrorBoundary>`) wrapping the root `<App />` element;
(2) `window.addEventListener('error', ...)`;
(3) `window.addEventListener('unhandledrejection', ...)`;
(4) `window.addEventListener('securitypolicyviolation', ...)`.
Each listener SHALL invoke the central
`recordFrontendError(err, kind, ctx?)` sink function with a
`kind` discriminator of `boundary`, `error`, `rejection`, or
`csp` respectively.

#### Scenario: React render exception is captured via boundary

- **WHEN** a child component below `<FrontendErrorBoundary>`
  throws during render
- **THEN** `recordFrontendError` is called with `kind="boundary"`
  and the thrown error

#### Scenario: Synchronous window error is captured

- **WHEN** an uncaught synchronous error fires the global
  `error` event
- **THEN** `recordFrontendError` is called with `kind="error"`
  and the underlying error object

#### Scenario: Unhandled promise rejection is captured

- **WHEN** a promise rejects without a handler
- **THEN** `recordFrontendError` is called with
  `kind="rejection"` and the rejection reason

#### Scenario: CSP violation is captured

- **WHEN** a `securitypolicyviolation` event fires
- **THEN** `recordFrontendError` is called with `kind="csp"`
  and a synthetic Error carrying the violated directive

### Requirement: Captured errors are recorded as exception events on the active OTel span

Every error reaching the central sink SHALL invoke
`trace.getActiveSpan()?.recordException(err)` so the exception
attaches to whatever slice-5 span is active at capture time. If
no span is active, the exception SHALL NOT be silently dropped —
the structured log line and the counter increment still fire.

#### Scenario: Exception event attaches to active span

- **WHEN** an error is captured while a slice-5 click or fetch
  span is active
- **THEN** the active span has an `exception` event with
  `exception.type` and `exception.message` attributes

#### Scenario: Capture succeeds when no span is active

- **WHEN** an error is captured outside any active span context
- **THEN** the span-event sink is skipped, but the log record
  and the counter increment still fire

### Requirement: Captured errors are emitted as structured OTel log records

The frontend SHALL emit one OTel log record per captured error (subject to the dedup and rate-cap gates) with severity `ERROR` and the following attributes:

- `event.dataset = "frontend.error"`
- `error.type` — the error's class name (`error.constructor.name`)
- `error.message` — the scrubbed error message
- `error.stack_trace` — the scrubbed stack
- `error.fingerprint` — `<error.type>:<first stackframe path>:<line>`
- `kind` — one of `boundary`, `error`, `rejection`, `csp`
- `route` — the React Router route template active at capture
  time (e.g., `/home`, `/users/{userId}`), or `unknown` if no
  match
- `user.id` — the opaque UUID from auth context when
  authenticated; omitted otherwise

The log record SHALL flow through the slice-5/slice-6 Collector
OTLP/HTTP receiver, NOT a custom HTTP endpoint.

#### Scenario: Log record fields are populated

- **WHEN** an error fires while authenticated on the home route
- **THEN** the emitted log record has severity `ERROR`,
  `event.dataset="frontend.error"`, `error.type`,
  `error.message`, `error.stack_trace`, `error.fingerprint`,
  `kind`, `route="/home"`, and `user.id`

#### Scenario: user.id omitted when unauthenticated

- **WHEN** an error fires before login
- **THEN** the emitted log record does NOT include a `user.id`
  attribute

### Requirement: Captured errors increment `frontend_errors_total` counter unconditionally

Every error reaching the central sink SHALL increment a counter
named `frontend_errors_total` labelled by `kind` and `route`.
**The counter increment is NOT gated by the dedup window or the
rate cap** — it fires on every captured error so aggregate
counts remain accurate. The counter SHALL be registered on the
slice-6 `MeterProvider` and SHALL flow through the existing
slice-6 metrics pipeline to Prometheus via the Collector's
`prometheus` exporter on port 8889.

#### Scenario: Counter increments on every error

- **WHEN** the same fingerprint fires 100 times in 1 second
- **THEN** `frontend_errors_total{kind, route}` has a value
  increase of 100, even though only one log record and one span
  event are emitted

### Requirement: Frontend deduplicates event-shaped error surfaces by fingerprint

The error sink SHALL compute a fingerprint as
`<error.constructor.name>:<first stackframe path>:<line>` and
SHALL suppress the span-event and log-record sinks for any
fingerprint that has already fired within the last 5000 ms.
The counter increment SHALL NOT be suppressed. The window MUST
be overridable via `VITE_FE_ERROR_DEDUP_WINDOW_MS`.

#### Scenario: Repeat fingerprint within window is deduplicated

- **WHEN** the same `TypeError` at `posts.tsx:42` fires twice
  within 100 ms
- **THEN** only one span event and one log record are emitted,
  but the counter increments twice

#### Scenario: Same fingerprint after window emits again

- **WHEN** the same fingerprint fires once, then again 6
  seconds later
- **THEN** two span events and two log records are emitted

### Requirement: Frontend rate-limits event-shaped error surfaces per session

The error sink SHALL enforce a hard cap of 30 captured events
per rolling 60-second window for the span-event and log-record
sinks. Events captured beyond the cap SHALL be dropped from
event-shaped sinks but SHALL still increment the counter. The
cap MUST be overridable via `VITE_FE_ERROR_RATE_LIMIT`.

#### Scenario: Hard cap suppresses event-shaped sinks

- **WHEN** 100 errors with distinct fingerprints fire within
  10 seconds
- **THEN** only 30 span events and 30 log records are emitted,
  but the counter increments 100 times

### Requirement: SDK scrubs PII from error messages and stack traces before export

The SDK-side error sink SHALL apply regex redaction to `error.message` and `error.stack_trace` before emitting any log record or span event, replacing matches with `[REDACTED]`.

The required patterns are:

- JWT-shaped tokens: `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- Email addresses: `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`
- Bearer-token-shaped substrings (base64 alphabet, 40+ chars):
  `\b[A-Za-z0-9+/=]{40,}\b`

Stack frames SHALL be preserved at the `path:line:col`
granularity but SHALL NOT include any source-snippet context.

#### Scenario: JWT is redacted from error message

- **WHEN** an error's message contains
  `eyJhbGciOiJIUzI1NiJ9.eyJzdWIi.signature`
- **THEN** the emitted log record's `error.message` contains
  `[REDACTED]` and does NOT contain the original token

#### Scenario: Email is redacted from stack trace

- **WHEN** an error's stack contains `user@example.com`
- **THEN** the emitted span event's `exception.stacktrace`
  contains `[REDACTED]` and does NOT contain the original
  email

### Requirement: Collector logs pipeline routes FE error logs to Loki with PII regex backstop

The Collector SHALL define a `logs` pipeline at `infra/observability/collector/collector-config.yaml` that routes FE error log records to Loki with a PII regex backstop and a frontend-only filter.

The pipeline structure is:

- Receiver: `otlp` (the existing slice-5 OTLP/HTTP receiver on
  port 4318)
- Processors, in order: `batch`, `filter/frontend_only`,
  `attributes/pii_scrub`
- Exporter: `loki` (the existing slice-4 Loki exporter)

The `filter/frontend_only` processor SHALL drop any log record
whose `resource.service.name != "frontend"`.

The `attributes/pii_scrub` processor SHALL apply the same three
regex patterns the SDK uses (JWT, email, bearer-token) over the
`error.message`, `error.stack_trace`, and `body` fields,
replacing each match with `[REDACTED]`.

#### Scenario: Collector drops non-frontend log records

- **WHEN** a log record with `resource.service.name="backend"`
  reaches the Collector's logs pipeline
- **THEN** the record is dropped before the Loki exporter sees
  it

#### Scenario: Collector redacts PII the SDK missed

- **WHEN** a log record's `body` field contains an unredacted
  JWT-shaped token
- **THEN** the record exported to Loki has `[REDACTED]` in
  place of the token

### Requirement: Loki receives FE error log records under `event.dataset=frontend.error`

FE-emitted log records SHALL be queryable in Loki via the label
selector `{event_dataset="frontend.error"}`. No new Loki index
or datasource SHALL be required; the existing slice-4 Loki
datasource SHALL handle both `backend.access` and
`frontend.error` streams.

#### Scenario: LogQL query returns FE error lines

- **WHEN** a Loki `query_range` request is made with
  `{event_dataset="frontend.error"}`
- **THEN** at least one log line per emitted FE error is
  returned within the configured retention window

### Requirement: Grafana Frontend overview dashboard gains an Errors row

The Frontend overview dashboard JSON at `infra/observability/grafana/dashboards/frontend-overview.json` SHALL gain a new row titled "Errors" containing three panels.

The panels are:

1. **Error rate** — time-series of
   `sum(rate(frontend_errors_total[5m])) by (kind)`, one series
   per `kind` value.
2. **Top fingerprints** — Loki logs panel querying
   `{event_dataset="frontend.error"} | logfmt | line_format
   "{{.error_fingerprint}} {{.error_message}}"` limited to top
   10 by count over the dashboard time range.
3. **CSP violations** — time-series of
   `rate(frontend_errors_total{kind="csp"}[5m])`.

#### Scenario: Errors row renders panels in Grafana

- **WHEN** a developer opens
  `http://localhost:3000/d/frontend-overview` after the
  observability stack is running
- **THEN** an "Errors" row is visible with three panels:
  Error rate, Top fingerprints, CSP violations

### Requirement: Dev-only `/__dev/throw` route exists for end-to-end test triggering

The frontend SHALL register a route at `/__dev/throw` ONLY when
`import.meta.env.DEV` is `true`. The route SHALL render a
component that throws on mount, exercising the React error
boundary path. The route MUST NOT be present in built bundles.

#### Scenario: Route registered in dev mode

- **WHEN** Vite runs with `pnpm dev` (DEV mode)
- **THEN** navigating to `/__dev/throw` triggers a render-time
  exception caught by `<FrontendErrorBoundary>`

#### Scenario: Route absent in production bundle

- **WHEN** `pnpm build` produces `frontend/dist/`
- **THEN** no asset in `frontend/dist/assets/*.js` references
  the `/__dev/throw` route

### Requirement: End-to-end test proves the browser → Collector → {Tempo, Loki, Prometheus} error pipeline

A Playwright spec at `e2e/tests/observability.frontend-errors.spec.ts` SHALL drive one authenticated session through `/__dev/throw` and assert the captured error appears in all three observability backends with PII redacted.

The thrown error's message MUST contain a JWT-shaped substring
used to assert redaction. The spec SHALL assert all of the
following:

- The Collector's `/metrics` endpoint at
  `http://localhost:8889/metrics` contains a line for
  `frontend_errors_total` with `kind="boundary"` and a value
  `>= 1`.
- The Loki API at `http://localhost:3100/loki/api/v1/query_range`
  with selector `{event_dataset="frontend.error"}` returns at
  least one log line whose `error.type` matches the thrown
  class.
- Tempo's `/api/search?tags=service.name%3Dfrontend` returns
  at least one trace whose span carries an `exception` event
  with `exception.type` matching the thrown class.
- The asserted log line and span event MUST contain
  `[REDACTED]` and MUST NOT contain the original JWT
  substring.

The spec SHALL skip via `test.skip(...)` when any of the
Collector, Loki, or Tempo APIs are unreachable, mirroring the
slice-5 and slice-6 patterns.

#### Scenario: All three sinks observe the triggered error

- **WHEN** the Playwright spec navigates an authenticated
  session to `/__dev/throw` and waits for batch export
- **THEN** the counter has incremented, a log line exists in
  Loki, and a trace exists in Tempo with the exception event

#### Scenario: PII does not leak to either event surface

- **WHEN** the thrown error message contains a JWT-shaped
  string
- **THEN** neither the Loki log line nor the Tempo span event
  contains the original JWT substring; both contain
  `[REDACTED]`

#### Scenario: Spec skips when observability stack is offline

- **WHEN** the Collector, Loki, or Tempo endpoint is
  unreachable
- **THEN** `test.skip(...)` is invoked and the spec passes
  trivially

### Requirement: README documents the frontend error reporting run loop

The repository README SHALL include a `### Frontend errors`
subsection under the existing `## Local observability` section
documenting:

- The four capture surfaces (boundary, `error`, `rejection`,
  `csp`).
- The `VITE_OTEL_ENABLED=true pnpm dev` run loop required to
  emit telemetry.
- The Grafana dashboard URL
  (`http://localhost:3000/d/frontend-overview`) and the new
  Errors row.
- The default dedup window (5 s) and rate cap (30 events/min),
  with their env-var override names.
- An explicit note that built bundles produce munged stack
  frames and that source-map symbolication is deferred to a
  future slice.

#### Scenario: README links the Frontend overview dashboard and notes source-map deferral

- **WHEN** a developer reads the README's "Local
  observability" section
- **THEN** they find the `### Frontend errors` subsection
  containing the four capture surfaces, the env-var run loop,
  the dashboard link, the dedup/rate-cap defaults, and the
  source-map deferral note
