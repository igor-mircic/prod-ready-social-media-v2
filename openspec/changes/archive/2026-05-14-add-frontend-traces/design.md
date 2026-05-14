# add-frontend-traces — Design

## Context

Slices 1–4 of observability shipped a complete backend-side stack: metrics
(Prometheus + Grafana, four business `@Timed` timers), logs (ECS structured
JSON with reserved `trace.id`/`span.id` slots), traces (OTel Java agent →
Tempo via OTLP/HTTP on `:4318`), and log shipping (OTel Collector + Loki,
bidirectional Grafana data-link pivots). Slice 4 introduced the OTel
Collector specifically as the production-shape shipping point, and its
proposal recorded *"every future telemetry concern (tail sampling,
redaction, fan-out to additional backends, span filtering) has a home"* —
this slice cashes one of those forward-pointers.

The current state, immediately before this change:

- The OTel Collector listens on `:4318` (OTLP/HTTP) and `:4317`
  (OTLP/gRPC) inside docker-compose, with `:4318` published to the host.
  Slice 3 set the backend agent's `OTEL_EXPORTER_OTLP_*` envs to that
  endpoint; slice 4 kept the agent's envs untouched and re-pointed the
  endpoint from Tempo to the Collector.
- Tempo is reachable at `:3200` (HTTP API) inside the compose network
  and is provisioned as a Grafana datasource named `Tempo`.
- The Grafana dashboard `Backend overview` slices PromQL `by(uri,
  method, status)` only; nothing groups by `service` because the only
  service today is `backend`.
- The frontend ships zero telemetry. `frontend/src/api/client.ts`
  exports a single `apiFetch` function that wraps `window.fetch` — used
  by every Orval-generated request — and is the only place outbound
  HTTP leaves the application. No `@opentelemetry/*` package is in
  `frontend/package.json`.
- Backend CORS is disabled (`backend/.../SecurityConfig.java:51`
  declares `.cors(AbstractHttpConfigurer::disable)`). Dev runs
  same-origin through the Vite proxy (`/api/v1` → `localhost:8080`);
  the browser never issues a preflight against the backend.
- The Vite proxy in `frontend/vite.config.ts` forwards `/api/v1/*` and
  `/actuator/*` to the backend. The Collector is not proxied.

Constraints carried over from prior slices, and honoured by this slice:

- **No high-cardinality labels in span attributes.** Slice 1 banned
  `userId`, `post_id`, `email` from Prometheus labels; slice 3 extended
  that to span attributes that drive trace search. We extend it again to
  browser-emitted spans, with the Collector as the enforcement point.
- **Default `docker-compose up` continues to start only `postgres`.**
  Slice 1 established the `observability` profile gate; this slice
  adds no new containers, so the profile gate is unchanged.
- **No changes to `SecurityConfig` or any backend source.** Slice 3
  made the same promise; nothing about frontend tracing requires
  backend changes. The slice-3 agent already reads `traceparent` from
  request headers; this slice merely populates that header from the
  browser.
- **The `apiFetch` chokepoint stays untouched.** Auto-instrumentation
  of `window.fetch` hooks at the global level; `apiFetch` does not need
  to know tracing exists.
- **The default `pnpm dev` loop stays untouched.** Telemetry is
  opt-in via an env var; a developer who has not started the
  observability stack sees zero behaviour change.

## Goals / Non-Goals

**Goals:**

- When `VITE_OTEL_ENABLED=true`, the frontend boots an OTel
  `WebTracerProvider` before React renders, with `service.name=frontend`
  on every emitted span.
- Every outbound `fetch` to a backend API URL carries a W3C
  `traceparent` header. Third-party hosts (CDNs, fonts) do NOT receive
  `traceparent` — propagation is restricted to the backend origin.
- The OTel Collector accepts those POSTs at
  `http://localhost:4318/v1/traces` from the Vite dev origin
  (`http://localhost:5173`) and the preview origin
  (`http://localhost:4173`) via CORS on the OTLP/HTTP receiver.
- A single `trace.id` connects: the browser-side `documentLoad` /
  user-interaction / fetch spans (`service.name=frontend`) AND the
  backend's controller / JDBC / `@Timed` spans
  (`service.name=backend`) AND the backend's ECS JSON log line for the
  same request.
- A reader pasting a `trace.id` from a backend log line into Tempo
  search sees a trace tree whose root is in `frontend`, not in
  `backend`.
- Path-segment ids (UUIDs, opaque hex ids) are redacted before reaching
  Tempo, applied uniformly to FE and BE spans by a single Collector
  `transform` processor.
- One end-to-end Playwright test asserts the full chain
  (browser → fetch → backend → log line → Tempo) for one
  `POST /api/v1/posts` invocation.

**Non-Goals:**

- **Frontend error capture.** Browser errors, unhandled rejections,
  React error boundaries — all out of scope. They will arrive as a
  later slice and will hang errors off the trace spans this slice
  emits.
- **Frontend RUM metrics.** Web Vitals (LCP, INP, CLS, TTFB), route-
  change timing, long-task observation — none in this slice. They
  will be a separate slice that ships browser-emitted metrics to the
  Collector's metrics pipeline.
- **Frontend logs.** No console capture, no log-event-on-span. Browser
  log volume is a separate decision.
- **Tail sampling.** Local default is 100% head sampling. Tail
  sampling is its own slice and will cover FE and BE policies
  together.
- **Source maps for span / error symbolication.** Slice 5 has no
  errors and span names do not include stack frames; source maps are
  a slice-7 concern.
- **Outbound `traceparent` from the browser to third-party origins.**
  `FetchInstrumentation.propagateTraceHeaderCorsUrls` is restricted to
  the backend origin. CDN, analytics, font hosts receive no header.
- **Backend CORS.** The backend's CORS posture is unchanged
  (disabled at the application layer). Browser → backend traffic in
  dev remains same-origin through the Vite proxy.
- **Production bundle-size optimisation.** The OTel SDK adds ~80–100 KB
  gzipped to the main bundle when enabled. Dynamic-import lazy-loading
  of the SDK is deferred to a future "FE production bundle" slice.
- **Manual span instrumentation in feature code.** No
  `tracer.startActiveSpan(...)` in `features/`. The slice relies
  entirely on auto-instrumentations (document load, user
  interaction, fetch).
- **A new Grafana dashboard.** The slice-1 Backend overview dashboard
  is unchanged; readers see the new FE spans through Tempo search.
  A "Frontend overview" dashboard will arrive with the RUM-metrics
  slice.

## Decisions

### Decision 1: Traces before RUM metrics, errors, or logs

The frontend pillars layer on top of traces, not alongside them. Three
forces compound.

First, **structural integrity**. Web Vitals shipped without trace
propagation become a fourth orphan signal: an LCP-by-route metric
cannot be correlated with the specific user trace that experienced the
slow LCP. Errors without trace propagation become anonymous
stack-traces detached from the request that produced them. Trace
propagation is the join key for everything else; bringing it last
means later slices must retrofit correlation onto already-shipped
signals.

Second, **smallest scope per outcome**. Tracing has one moving piece:
the W3C `traceparent` header crossing the wire. RUM metrics have at
least three (which Vitals, when to emit, what to tag by). Errors have
the most (boundary placement, source maps, deduplication, alert
routing). Shipping the smallest of the three first builds confidence
in the wiring (`tracer.ts`, Collector CORS, redaction processor)
before introducing the higher-uncertainty decisions.

Third, **reuse**. Once the SDK is bootstrapped and shipping spans,
adding error capture is `span.recordException(...)` + a React error
boundary — single-digit lines of code on top of existing
infrastructure. Adding Web Vitals is `web-vitals` library callbacks
emitting custom spans or metric points to the same `tracer.ts`.
Tracing-first is the foundation; everything else is a layer.

Alternatives considered:

- **Errors first.** Maximises operator value (you start getting paged
  on real failures faster), but produces detached telemetry — error
  stack traces with no request context. Sequence-blocking decision:
  do you want to debug errors *with* their trace, or in isolation?
  We choose with.
- **Web Vitals first.** Smallest user-facing latency for non-zero
  value (a dashboard showing LCP histograms). But the metric points
  arrive without a `trace.id` exemplar to drill into, so spike
  investigations still bottom out at "look at all the slow page
  loads at that hour." The exemplar story only works if traces ship
  first.
- **All three at once.** The "frontend observability" bundle.
  Bundling four decisions into one slice means each decision gets
  worse review and the slice takes longer to merge. We prefer
  three small slices to one big one — matches the slice-1→4
  cadence.

### Decision 2: Browser ships direct to Collector via CORS, not through the Vite proxy

The Vite proxy is one alternative: add `/otlp` to `vite.config.ts`'s
proxy map, point it at `http://localhost:4318`. Browser POSTs to
`/otlp/v1/traces` (same-origin), Vite forwards. No CORS preflight, no
new YAML.

We choose **direct cross-origin to `http://localhost:4318/v1/traces`
with CORS on the Collector**, for two reasons.

First, **production realism**. The Vite proxy is dev-only. In any
non-dev environment the browser hits the Collector cross-origin
(whether the Collector is on a sibling subdomain, a sidecar in
Kubernetes, or behind a CDN). Exercising the CORS path in dev means
the same wire shape every later environment will use; a
misconfigured `Access-Control-Allow-Origin` surfaces immediately
rather than at the first cloud deploy. The user's
"prefer production-realistic" guidance recorded in memory points the
same way.

Second, **narrow proxy scope**. Today the Vite proxy forwards
`/api/v1` and `/actuator` — both backend. Adding `/otlp` would mean
the proxy now spans two services (backend + collector), which is
an architecture leak. Keeping the proxy backend-only preserves
the mental model that "Vite proxy = same-origin trick for the
backend, full stop."

The CORS config is six lines of YAML on the OTLP/HTTP receiver. The
preflight that follows is a single `OPTIONS /v1/traces` before the
first POST per page load; the OTel SDK reuses the same exporter for
the rest of the session.

Alternatives considered:

- **Vite proxy.** Simpler today, deferred CORS pain to the first
  non-dev environment. Rejected — defers a load-bearing decision.
- **Backend proxies `/_otel` to the Collector.** The browser POSTs to
  `/_otel/v1/traces`, the backend forwards. Same-origin, no CORS.
  But couples backend deployment to Collector deployment and adds a
  Spring controller to an otherwise-frontend slice. Rejected as
  over-coupled.
- **Direct without CORS (rely on `Access-Control-Allow-Origin: *`).**
  Would work in dev, but `*` is wrong in prod. Configuring an
  origin allowlist now means the prod config is a strict superset,
  not a different shape.

### Decision 3: Path-segment redaction at the Collector, not the application

Browser-emitted fetch spans default to a span name of `HTTP <METHOD>`
and a `http.url` (or `url.full`) attribute equal to the raw fetch URL.
A call to `fetch('/api/v1/users/abc-123/follow')` produces an attribute
of exactly that string — including `abc-123`, which is a high-
cardinality id.

Three places could redact: (a) `FetchInstrumentation`'s
`applyCustomAttributesOnSpan` hook in the application; (b) the
exporter via a transform helper; (c) the Collector via a `transform`
processor.

We choose **(c) the Collector**, for three reasons.

First, **defense in depth across both pillars**. The backend's OTel
Java agent emits spans with `http.target`/`url.path` attributes that
contain the raw path (the agent applies route-template lifting to the
*span name* but not always to the URL attribute). Doing redaction at
the Collector applies the same regex set to FE and BE spans alike — a
single chokepoint, a single set of patterns.

Second, **no route-template drift in TypeScript**. The frontend has
no router-injected route-template equivalent; the fetch URL is an
opaque string at the call site. Application-side redaction would mean
hand-maintaining a list of `[regex, replacement]` pairs next to every
new feature route. The discipline rots silently — adding a route does
not fail-loud if the redaction rule is missed. Collector-side
redaction is a single regex set, ungated by feature work.

Third, **production parity**. Real production OTel Collector pipelines
already include redaction processors for PII; introducing the pattern
now means the slice-5 Collector config is closer to a real production
config than to a learning toy.

Alternatives considered:

- **`applyCustomAttributesOnSpan` in `tracer.ts`.** Single-language,
  same module that bootstraps tracing. Rejected — duplicates patterns
  across FE and BE, and the discipline of "every new route also adds a
  redaction rule" is exactly the rot we want to avoid.
- **No redaction; route templates only.** The backend would still
  redact via agent route-template lifting; FE wouldn't. Asymmetric
  trace data is worse than symmetric incomplete redaction. Rejected.
- **Drop the whole `http.url` attribute and keep only `http.target`
  with route template.** Loses the full URL value entirely, which is
  occasionally useful for debugging. The transform approach replaces
  ids with a token (`{id}`) and preserves the surrounding path
  structure — strictly more information.

The patterns redacted by the `transform` processor in slice 5:

- UUID v4 (lowercase hex with hyphens):
  `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
- Opaque hex ids of length 8+:
  `[0-9a-f]{8,}` (applied only to path segments, not query strings —
  to avoid eating `sha256=...` tokens that are not in paths).
- Numeric ids of length 4+: `[0-9]{4,}` (catches incremental
  database ids without eating port numbers).

All three replace with the literal token `{id}`. The replacement is
intentionally uniform — operators should query by route template,
not by id value, so distinguishing a UUID id from a numeric id in the
span name is anti-helpful.

### Decision 4: Head-sample 100%; tail sampling deferred to its own slice

Tail-sampling (drop boring 200/fast traces, keep errors and the slow
tail) is the production-shape answer. We defer it.

Three reasons.

First, **no traffic justifies sampling**. Local dev has no real load.
Head-sample 100% means every click produces a usable trace; demos do
not require lucky timing; the slice-5 e2e test can assert exact trace
counts without flakiness from sampling.

Second, **unified policy belongs in one slice**. Tail-sampling
policy is a single concept that spans FE and BE — the policy must
decide what to keep based on data from both. Introducing tail-
sampling for FE alone produces an inconsistent trace tree (a trace
kept because the FE span was slow but BE spans were dropped, or
vice versa). The right slice owns both at once, and ideally also
revisits backend sampling (currently implicit 100% from slice 3).

Third, **collector pipeline cost**. Tail sampling requires the
`tail_sampling` processor with a buffering window (typically 30s)
during which the Collector holds spans in memory before deciding to
export. That introduces a memory characteristic and a tuning surface
(buffer size, sampling policy YAML) that deserves dedicated attention.

Alternatives considered:

- **Probabilistic head sampling (1%).** Would match what real prod
  often runs. Rejected because at toy traffic 1% means "almost never
  see a trace"; the e2e test would need retry logic.
- **`always_on` sampler.** Equivalent to head 100% but the explicit
  configuration option. Adopted in implementation (the SDK default is
  parent-based-always-on, which is correct for `documentLoad` /
  user-interaction spans that have no parent).

### Decision 5: `service.name=frontend` (mirrors backend's `service=backend`)

Slice 1 set the backend's Micrometer common tag `service=backend` on
every Prometheus metric. Slice 3 inherited the same value for the
backend's OTel `service.name` resource (the agent reads `OTEL_SERVICE_
NAME=backend` from `backend/build.gradle.kts`). We mirror this with
`service.name=frontend` for browser-emitted spans.

Three reasons.

First, **binary Grafana selectors**. The Tempo service dropdown,
PromQL `by(service)` clauses, and LogQL `{service="..."}` filters
all benefit from a small bounded set of `service` values. Two values
(`frontend`, `backend`) is the simplest cleavage that supports the
pivots this slice enables.

Second, **resource attribute consistency**. OTel's
`semantic-conventions` package defines `SERVICE_NAME` as the
canonical attribute key (resolves to the string `"service.name"`).
Using the same constant in the FE resource as the BE agent emits
ensures the attribute name is byte-identical on both sides.

Third, **the service-graph node label**. Tempo's optional service-
graph rendering uses `service.name` as the node label. Emitting
`frontend` gives the service-graph a `frontend → backend` edge that
matches the mental model of who-calls-whom; emitting the full
package name (`prod-ready-social-media-frontend`) produces a node
label that is unreadable at small graph zoom levels.

We also set `service.version` from `import.meta.env.VITE_APP_VERSION`
(Vite injects this at build time from `package.json`). Frontend
spans carry the deployed version; comparing two versions' spans in
Tempo becomes a `service.version`-based filter.

Alternatives considered:

- **`service.name=prod-ready-social-media-frontend`** (matches the
  package name). Verbose, redundant with the application/service
  separation the backend already established.
- **`service.name=react-app`** (descriptive of the technology).
  Rejected — couples the service identity to the framework, which
  obscures the role (it is the *frontend*, regardless of the SPA
  framework).

### Decision 6: `UserInteractionInstrumentation` for click + submit only; accept the useQuery gap

`@opentelemetry/instrumentation-user-interaction` creates a span on
DOM events and keeps the span active during the synchronous event
handler. It supports a configurable event-type list (defaults include
`click`).

We enable it with the event list `["click", "submit"]`. This covers:

- Button clicks (post composer, follow button, login submit) →
  the `useMutation`-triggered fetch fires in the same task as the
  click handler, so `FetchInstrumentation` parents the fetch span
  to the click span automatically.
- Form submits (login, signup) → same reasoning.

It does NOT cover:

- `useQuery` fetches firing from a `useEffect` on mount. These fire
  in a microtask after the click span has closed (or with no click
  parent at all, e.g. initial page load). They will parent to the
  `documentLoad` span or to no parent.
- `useMutation` retries fired from TanStack Query's retry policy
  after the click span closed. These will parent to the
  `documentLoad` span.

We accept this gap. The `useQuery` case is **accurate** — the fetch
is *not* a user-initiated event; it is React lifecycle. Forcing a
"phantom click span" parent would be misleading. The retry case is
rare enough that fixing it would be premature.

A future improvement is to wrap `useMutation` `onMutate` handlers in
manual spans so retries inherit the same parent. That is one or two
lines of TS per call site, but it requires either touching every
feature module or shipping a `useTracedMutation` wrapper. Both are
real work, and neither is needed to land slice 5's outcome. Recorded
as a slice-5 open follow-up.

Alternatives considered:

- **No user-interaction instrumentation.** Every fetch span parents
  to `documentLoad`. Loses the "this slow trace was caused by *this*
  user click" link. Rejected — that link is the slice's
  raison d'être.
- **`UserInteractionInstrumentation` with all DOM events.** Adds
  span noise from hover, scroll, keydown — most of which do not
  trigger fetches. Rejected — `click` + `submit` is the precise
  subset that triggers fetches.
- **Manual span wrapping in every mutation handler.** Would close
  the useMutation-retry gap but distributes tracing concerns across
  feature code. Rejected for slice 5; revisitable later.

### Decision 7: OTel default — do not capture request/response headers

`FetchInstrumentation`'s defaults do NOT capture request or response
headers as span attributes. Only URL, method, status code, and
timings are recorded.

We keep the default. Consequence: `Authorization: Bearer <jwt>` never
appears in a span, and any future header-borne secret (CSRF token,
etc.) is similarly safe. The `traceparent` header is propagated but
not recorded (that would be redundant — the trace id is the span
identity).

We do not enable any of `applyCustomAttributesOnSpan` hooks that would
synthesise header attributes. The decision is non-action — a thing
not done — but worth recording so a future reader who is tempted to
enable header capture for debugging knows it was a deliberate
default.

Alternatives considered:

- **Capture all request headers.** Convenient for debugging, leaks
  `Authorization` into spans. Hard reject.
- **Capture a whitelist (e.g. `Content-Type`, `Accept`).** Marginal
  signal, marginal risk. Rejected as not worth the configuration
  surface for slice 5.

### Decision 8: Env-var-gated SDK boot; default `pnpm dev` is unchanged

`bootstrapTelemetry()` exits early as a no-op unless
`import.meta.env.VITE_OTEL_ENABLED` is the literal string `"true"`.

The reason is the slice-4 pattern of "fail quietly when the
observability stack is down." A developer who runs `pnpm dev` without
the observability profile up should see zero behaviour change — no
console errors from a failed OTLP POST, no retry spam, no impact on
the existing dev loop. Telemetry is opt-in.

The corresponding production-build flag is the same env var read at
build time (Vite expands `import.meta.env.*` at build, not at
runtime). A future "FE production bundle" slice may move the gate to
runtime via a server-supplied config endpoint; that is out of scope.

Alternatives considered:

- **Always on.** Matches slice 3 (backend agent always attaches). But
  the backend agent's failure mode is "logs an error and continues";
  the OTel Web SDK's failure mode for an unreachable Collector is
  silent failure-with-retry, which is fine, *but* the BatchSpanProcessor
  buffers spans in memory waiting for a successful export. Better to
  gate explicitly.
- **Gate by `import.meta.env.DEV`** (Vite's built-in development
  flag). Couples telemetry to the dev-vs-prod axis, but a developer
  may want telemetry off in dev (most of the time) and on in dev
  (when actively debugging a trace). An explicit env var is more
  honest.

## Risks / Trade-offs

[**Risk**: Bundle size grows by ~80–100 KB gzipped when telemetry is
enabled.]
→ Mitigation: Env-var gating means production builds without
`VITE_OTEL_ENABLED=true` exclude the SDK from the bundle (Vite tree-
shakes unreferenced imports — `bootstrapTelemetry`'s early return is
a static condition that allows dead-code elimination if `tracer.ts`
is imported but never invoked, provided the import is dynamic). A
future slice may switch to a `await import(...)` dynamic import for
explicit code-splitting.

[**Risk**: `UserInteractionInstrumentation` patches global DOM
event-handling. Conflict with React 19's event delegation or with
test-suite event simulation.]
→ Mitigation: The instrumentation is opt-in (only loaded when
telemetry is enabled), and the e2e test exercises the actual
production code path. Vitest tests run in jsdom and run with
telemetry disabled (the env var is unset) — they exercise the no-op
boot path. The single Vitest test added by slice 5 covers exactly
that.

[**Risk**: Collector CORS allowlist hardcoded to Vite ports
`5173` / `4173` will not match a developer's custom port.]
→ Mitigation: The two ports are Vite's defaults. A custom port is
the developer's choice and they can extend `allowed_origins` in the
Collector config. Documented in the README's frontend-tracing
section.

[**Risk**: `traceparent` header leaks to a backend URL the
allowlist did not anticipate.]
→ Mitigation: `propagateTraceHeaderCorsUrls` is restricted to
exactly two patterns — the dev backend (`http://localhost:8080`)
and the configurable production backend URL
(`VITE_API_BASE_URL`). A request to any other origin (CDN, fonts,
analytics) does not receive the header.

[**Risk**: The Collector's `transform` processor regex set is
under-strict and lets a high-cardinality id through, OR over-strict
and redacts a substring that was not an id (e.g. eating a hash in a
filename).]
→ Mitigation: The regex set is intentionally conservative
(UUID/UUID-shape + opaque hex of length 8+ in path segments only +
numeric of length 4+). A unit test of the Collector config is out
of scope for slice 5; a future hardening slice may add Collector-
config integration tests. The slice-5 e2e test asserts at least one
known-bad input (a UUID userId) is redacted, which is a minimum
regression guard.

[**Risk**: Browser sends OTLP POSTs even when the backend trace
context indicates the trace should be dropped (sampling policy
mismatch between FE and BE).]
→ Mitigation: Slice 5 is 100% sampling on both sides; mismatch is
not possible. The tail-sampling slice will introduce a unified
policy.

[**Risk**: Trace continuity assertion in the e2e test races the
Collector's batch export interval (default 5s).]
→ Mitigation: The OTLP batch span processor is configured with
`scheduledDelayMillis: 500` for the test path (overridable via
`VITE_OTEL_BATCH_DELAY_MS`). The test polls Tempo's HTTP API with
a 30-second budget and 1-second interval — standard for the
slice-3 / slice-4 e2e shape.

[**Trade-off**: Telemetry-off-by-default in dev means a developer who
forgets to set the env var believes telemetry "works" when their
spans never reach Tempo.]
→ Mitigation: The README's frontend-tracing section is explicit. The
SDK boot logs one line (`OTel telemetry enabled: traces → ...`)
when the env var is on; absence of the line in the console is the
indicator that the gate is off.

[**Trade-off**: Path-segment redaction is one-way and lossy. An
operator who needs the actual UUID to reproduce a bug cannot recover
it from Tempo.]
→ Mitigation: The actual UUID lives in the backend's ECS log line
(slice 2 emits `request.id` and the user's id where present),
correlated to the same `trace.id`. The Loki pivot from a Tempo
trace recovers the un-redacted ids. The trade-off is asymmetric on
purpose: spans are searched, logs are read.

## Migration Plan

The change is additive across the board:

- **Frontend dev loop**: unchanged unless the developer opts in via
  `VITE_OTEL_ENABLED=true`. No new pre-existing commands change behaviour.
- **Backend**: zero code changes. The slice-3 agent already reads
  `traceparent` from inbound request headers.
- **Collector**: gains CORS on the existing OTLP/HTTP receiver and a
  new `transform` processor. Existing pipelines unchanged in shape.
- **Tempo, Loki, Prometheus, Grafana**: unchanged.

There is no rollback strategy needed beyond reverting the change. No
data shape on the wire changes for any prior signal (the backend
spans now sometimes parent to a browser span, but the trace tree's
storage shape in Tempo is unchanged — a parent span ID is a parent
span ID regardless of which service emitted it).

## Open Follow-ups

These are explicitly NOT in scope for this slice but are recorded for
the next observability slice's "Why" section:

- **Manual span wrapping for `useMutation` handlers.** Closes the
  retry-after-click-closed gap from Decision 6. Either a per-call-site
  pattern or a `useTracedMutation` wrapper.
- **Source maps for symbolicated span / future-error names.** Slice 7
  (errors) will need this; slice 5 does not.
- **Dynamic-import code splitting for `tracer.ts`.** Reduces bundle
  size when telemetry is enabled in prod.
- **Tail-sampling slice unifying FE + BE policy.**
- **Frontend RUM metrics slice** (Web Vitals, route timing, long
  tasks) shipping browser-emitted metrics through the same
  Collector.
- **Frontend errors slice** (React error boundary, window error /
  unhandledrejection capture) hanging errors off the trace spans
  this slice emits.
- **Grafana "Frontend overview" dashboard.** Will arrive with the
  RUM-metrics slice.
- **Service-graph rendering in Grafana** beyond the datasource
  config — adding the panel to the Backend overview dashboard or
  introducing a dedicated Service Map dashboard.
