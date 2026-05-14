# add-frontend-errors — design

## Context

Slice 5 (`add-frontend-traces`) shipped W3C-traceparent browser-to-
backend trace continuity through the OTel Collector to Tempo. Slice
6 (`add-frontend-rum-metrics`) shipped Web Vitals, route timing,
and long tasks through the same Collector to Prometheus, plus a
Grafana Frontend overview dashboard. Both slices left the
**errors** surface explicitly deferred.

Current state of frontend error visibility:

- A `useMutation` failure: span `status=ERROR`, no JS exception
  detail.
- A React render exception: white screen, console log, no
  telemetry.
- A `window.onerror` (e.g., third-party script): console log
  only.
- An `unhandledrejection`: browser-dependent console warning.
- A `securitypolicyviolation`: invisible.

In production, all five categories will silently degrade UX.
In local dev, all five categories are invisible to the
observability stack — the dashboards say "everything is fine"
while the page is throwing every render.

The OTel ecosystem has matured the third pillar (logs) for the
browser via `@opentelemetry/api-logs` + `@opentelemetry/sdk-logs`
+ `@opentelemetry/exporter-logs-otlp-http`. These packages target
the same Collector OTLP/HTTP receiver slice 5 wired, so no new
wire path is required. The Collector accepts OTel logs and has
a `loki` exporter already in place from slice 4.

This slice closes the FE error gap by routing every captured
error to three sinks — span event, structured log record, and
counter increment — through the existing Collector, and adding
an Errors row to the Frontend overview dashboard.

## Goals / Non-Goals

**Goals:**

- Capture all four canonical browser error surfaces (React
  boundary, `window.onerror`, `unhandledrejection`,
  `securitypolicyviolation`).
- Route each captured error to three sinks: span exception event
  (Tempo), structured ECS log record (Loki), and counter
  increment (Prometheus).
- Bound output volume via SDK-side fingerprint dedup and a per-
  session rate cap; preserve aggregate accuracy via an
  always-incrementing counter.
- Scrub PII (tokens, emails, JWTs) at the SDK *and* at the
  Collector — defence-in-depth.
- Attach `user.id` (opaque UUID only) to error events when
  authenticated.
- Surface error rate and top fingerprints on the existing
  Frontend overview dashboard.
- Prove the FE → Collector → {Tempo, Loki, Prometheus} pipeline
  end-to-end via a Playwright spec.

**Non-Goals:**

- Source-map symbolication. Stack frames in built bundles will
  be munged. Deferred to its own slice with a pre-deploy
  reminder.
- Long Animation Frames API (LoAF) or any browser API not yet
  in every evergreen browser.
- A Sentry-style breadcrumb ring buffer (Decision 6 — traces
  fulfil this role).
- Backend error capture changes. The BE already logs exceptions
  via slice 2; no shape changes here.
- Alerting on the error rate (Alertmanager / SLOs are slice 8).
- Production-bundle dynamic-import code splitting for the OTel
  SDKs. Carried forward as a future slice covering all three
  bootstrap functions.

## Decisions

### Decision 1: Three sinks (span event + log line + counter), not one

**Choice:** Every captured error fans out to (a)
`span.recordException()` on the active OTel span, (b) a
structured OTel log record exported to the Collector and routed
to Loki under `event.dataset=frontend.error`, and (c) a
`frontend_errors_total{kind, route}` counter increment on the
slice-6 metrics path.

**Why:** The three sinks answer three different questions a
human asks during an incident.

```
   Question                          Right surface          Wrong surface
   ─────────────────────────────────────────────────────────────────────────
   "Why did THIS trace fail?"        Span event in Tempo    Logs (no trace
                                                            ID to filter on)
   "How many users hit `TypeError    Loki logs aggregate    Trace search
    from posts.tsx:42` today?"
   "Is error rate spiking right      Prometheus counter     Logs (slow at
    now?"                                                   query time)
```

Production tools (Sentry + Datadog Browser RUM, Honeycomb +
Splunk, Bugsnag + Datadog Metrics) always run a parallel
combination. OTel makes all three reachable from one capture
point. The backend already runs the same triple-sink shape
(access log → Loki, span → Tempo, `http_server_requests` counter
→ Prometheus). The frontend should match.

**Alternatives considered:**

- *Span event only.* Forces every diagnostic workflow through
  trace-first navigation. "Find all TypeErrors today" becomes a
  manual scan or a custom Tempo metrics pipeline. Rejected.
- *Log line only.* Loses the causal-context tree — you see the
  error, but not the click→fetch→render that led to it.
  Rejected.
- *Counter only.* Tells you the rate; tells you nothing about
  the cause. Rejected.

### Decision 2: OTel logs SDK, not custom HTTP POST to a Collector endpoint

**Choice:** Frontend errors-as-log-records use
`@opentelemetry/api-logs` + `@opentelemetry/sdk-logs` +
`@opentelemetry/exporter-logs-otlp-http`. The exporter targets the
existing slice-5 Collector OTLP/HTTP receiver on port 4318.

**Why:** The SDK gives us, for free, the same machinery slice 5
already runs for traces — `BatchLogRecordProcessor` (batching,
retry, back-off), OTLP/HTTP serialisation, the
`Resource`-attribute attachment, and the CORS-allowed receiver
endpoint. A custom POST would re-implement all of this,
including the retry/back-off contract that survives flaky
networks. The SDK is also the canonical shape any future
hosted-vendor migration (e.g., Honeycomb, Grafana Cloud) would
expect.

**Alternatives considered:**

- *Custom `fetch()` POST to a dedicated `/v1/frontend-errors`
  Collector endpoint.* Would require a custom Collector
  receiver, a custom batching layer in the SDK, and a custom
  authentication contract. Net more code, weaker guarantees,
  diverges from OTel-canonical shape. Rejected.
- *POST directly to Loki's `/loki/api/v1/push`.* Couples the
  frontend to Loki's wire format, bypasses the Collector
  redaction layer, exposes Loki's HTTP surface to every browser
  on the internet, and loses the OTel `Resource` attribute
  attachment. Rejected.

### Decision 3: Fingerprint-based dedup + hard rate cap, both at SDK

**Choice:** The error sink computes a fingerprint as
`<error.constructor.name>:<first stackframe path>:<line>`. A
5-second sliding window dedup map suppresses event-shaped
surfaces (span event + log line) for repeat fingerprints. A
hard cap of 30 events/session/minute suppresses event-shaped
surfaces regardless of fingerprint. **The counter increments
on every captured error**, never gated. Both thresholds are
overridable via `VITE_FE_ERROR_DEDUP_WINDOW_MS` and
`VITE_FE_ERROR_RATE_LIMIT`.

**Why:** A `setInterval` firing into a broken handler can
produce 1000 identical exceptions per second. Without dedup,
the Collector chokes, Loki bills explode, and the dashboard
buries the single signal. The 5-second window catches the
"render loop" case without losing visibility into "the same
fingerprint also happened 30 seconds later." The hard cap is
the back-stop for cases where fingerprints differ slightly
(e.g., a `Date.now()`-stamped error message).

Counter unchanged: aggregate accuracy is the metric's job.
"How many errors fired" is the truth; "give me 30 examples per
minute" is the example budget. Sentry, Bugsnag, and the OTel
SDK examples all separate these two concepts.

**Alternatives considered:**

- *No dedup.* Render-loop pathology saturates downstream
  infrastructure. Rejected.
- *Dedup at the Collector.* Possible via a tail-sampling-style
  processor, but moves the rate-cap concern away from the
  source — meaning the SDK still sends every event over the
  wire, the network cost still happens, and a misbehaving
  client can still DoS the Collector. SDK-side is the correct
  layer for client-cost concerns. Rejected.
- *Drop the counter on dedup too.* Loses aggregate accuracy.
  The whole point of the metric is to count *every* event,
  while the event-shaped surfaces are examples. Rejected.

### Decision 4: Defence-in-depth PII scrub — SDK allowlist + Collector deny-list

**Choice:** Two PII-redaction layers, with different threat
models:

```
   SDK side                         Collector side
   ────────────────────             ────────────────────
   Allowlist of attribute           Deny-list regex over
   names; regex strip               error.message,
   tokens/emails/JWTs from          error.stack_trace, and
   error.message and                body fields on every log
   error.stack_trace; drop          record; same regex set
   any source-snippet               (JWT-shaped, email,
   context from frames.             bearer-token-shaped).

   Catches: the 99% the             Catches: the 1% the
   developer thought about.         developer never thought
                                    about (third-party lib
                                    exception messages,
                                    JSON.parse dumping the
                                    payload, etc.)
```

**Why:** One layer catches "if I forgot"; the other catches
"if a library I import forgot." This mirrors the slice-5
path-segment redaction at the Collector, where the application
emits clean paths but the Collector is the last-line guard.

Regex patterns kept identical across the two layers so the
behaviour is auditable in one place. Any pattern added must
land in both `error-sink.ts` and `collector-config.yaml` in
the same commit.

**Alternatives considered:**

- *Collector-only redaction.* Loses control over what the SDK
  sends over the wire. Even with TLS the Collector becomes the
  point at which the developer can no longer reason about
  exposure. Rejected.
- *SDK-only redaction.* No backstop for third-party library
  exceptions. Rejected.
- *Field-level encryption + a downstream decrypt service.*
  Production-tool shape eventually, but well out of scope.
  Recorded as a follow-up.

### Decision 5: Attach `user.id` (opaque UUID) on authenticated events

**Choice:** When the user is authenticated (the slice-2 backend
already provides a UUID in MDC; the frontend has access via
the auth context), every error event carries `user.id` as a
resource-or-event attribute. Email, handle, display name are
NEVER attached.

**Why:** "Is this error one user or every user?" is the first
question a human asks during a spike. Without `user.id` the
answer requires correlating IP addresses across logs — slow,
lossy, and session-based auth makes the IP unreliable. With
it, the answer is a single Grafana `count by (user_id)`.

The UUID exposure is bounded to "an observer with Loki access
can correlate a UUID to an account record." The backend
already accepts this exposure in its access log. The frontend
matching is the only shape that makes cross-tier debugging
work.

**Alternatives considered:**

- *No user attribution.* Solves the wrong problem (PII fear
  vs. operability). Rejected.
- *Email or handle.* Strictly higher PII risk for zero
  additional diagnostic value (the UUID is the join key in the
  database). Rejected.
- *Hashed UUID.* Adds a join step in the analyst's workflow
  (rehash the UUID from the user table) for no security gain
  (the UUID is already opaque to anyone without DB access).
  Rejected.

### Decision 6: No breadcrumb buffer — traces ARE the breadcrumb trail

**Choice:** No client-side ring buffer of "last N user
interactions." The active OTel trace (slice 5 emits spans for
clicks, form submits, route changes, and outbound fetches)
already contains every user action that led up to the error.
Drilling into the error's trace in Tempo shows the chain.

**Why:** A breadcrumb buffer would duplicate state the trace
context graph already maintains, with strictly weaker
guarantees:

- The buffer is in-memory only; a hard crash loses it.
- The trace context is exported in real time; the upstream
  Collector has the data even if the browser crashes mid-
  render.
- The buffer must define its own redaction rules; the trace
  context already runs through slice-5 path redaction.
- The buffer becomes a parallel diagnostic surface a developer
  must learn; the trace UI is already in their workflow.

The single trade-off: in Tempo, the breadcrumb trail is a span
waterfall, not a flat list. In some incident styles the flat
list is easier to read at a glance. Accepted — the waterfall
also carries causality, which a flat list does not.

**Alternatives considered:**

- *In-memory ring buffer of 100 events flushed on error.*
  Rejected per above.
- *IndexedDB-backed buffer that survives crashes.* Even
  weaker — IndexedDB writes are async and unreliable mid-
  crash. Rejected.

### Decision 7: Source-map symbolication explicitly deferred

**Choice:** Built bundles produce minified stack frames. The
SDK captures and forwards the frames as-is. No build-pipeline
changes, no symbolicator, no resolver.

**Why:** Symbolication is a meaningful slice in its own right
— a Vite/Rollup source-map upload step, a symbol store
(self-hosted or vendor), and a Grafana/Tempo/Loki plugin to
resolve frames on read. None of these belong in slice 7's
scope. In local-dev and CI today, Vite serves unminified
bundles and stack frames are already human-readable; the gap
only matters when a real server serves minified bundles to
real users. The deferral is captured in project memory
(`project_source_maps_pre_deploy.md`) so the next time a real-
server deploy is planned, the assistant proactively raises the
gap.

**Alternatives considered:**

- *Ship un-minified bundles always.* Hurts production
  performance for a diagnostic-only benefit. Rejected.
- *Upload source maps to a Loki label.* Misuses Loki labels
  (which are for indexable cardinality, not blobs). Rejected.
- *Resolve in the browser via a service-worker.* Doubles the
  bundle size and runs symbolication on every page load.
  Rejected.

### Decision 8: ECS dataset `frontend.error`, single-pipeline routing

**Choice:** All FE error log records carry
`event.dataset=frontend.error`. The Collector's logs pipeline
filters by `service.name=frontend` (drops anything else as
defence-in-depth) and routes via the existing `loki` exporter.
Loki indexes by label; no datasource change.

**Why:** Mirrors the backend `backend.access` and
`backend.error` dataset naming from slice 2 / slice 4. The
LogQL query surface is consistent across tiers:
`{event_dataset="backend.access"}` and
`{event_dataset="frontend.error"}` are siblings, queryable
side-by-side in one Grafana panel.

The frontend-only filter exists today as documentation: the BE
ships logs via Filebeat, not the OTel Collector. If a future
slice migrates BE logs to OTLP, the filter prevents an
accidental cross-pollination where BE logs hit the FE-shaped
attribute-redaction pass.

**Alternatives considered:**

- *Reuse `event.dataset=backend.error`.* Conflates two
  service tiers in one Loki stream; loses the cross-tier
  partition. Rejected.
- *No `event.dataset` at all, rely on `service.name` only.*
  Diverges from the ECS shape the backend already uses;
  breaks the side-by-side LogQL pattern. Rejected.

### Decision 9: Counter NOT labelled by fingerprint

**Choice:** `frontend_errors_total` is labelled by `kind` and
`route` only. Fingerprints live on log records (where Loki
handles unbounded cardinality), not on the metric.

**Why:** Fingerprints are unbounded per-deploy — every code
change can produce new ones. A Prometheus metric labelled by
fingerprint would explode the active-series count.
`kind` is 4 fixed values; `route` is bounded by the React
Router template list (currently ~5). The slice-6 Collector
high-cardinality filter is the back-stop.

The "top fingerprints" panel on the dashboard comes from Loki
(`count() by (error_fingerprint) | top 10`), not from
Prometheus. Right tool, right job.

### Decision 10: Dev-only `/__dev/throw` route gated by `import.meta.env.DEV`

**Choice:** A new component `<ThrowOnMount />` mounted at
`/__dev/throw` exists only when Vite's `import.meta.env.DEV`
is true. In built bundles, the import is tree-shaken out and
the route is not registered.

**Why:** The Playwright spec needs a deterministic way to
trigger every error surface (boundary, error, rejection, CSP).
A real-application error is by definition rare and timing-
dependent. A dedicated test route is the cleanest contract.
The `DEV`-only gate ensures the route never reaches production
even if the Playwright job is misconfigured.

**Alternatives considered:**

- *Trigger errors via global JS injection from Playwright.*
  Tests against `window.onerror` are doable this way, but the
  React boundary path requires React to mount the throwing
  component within the boundary's child tree. Injection
  bypasses the boundary. Rejected.
- *Always-on `/__dev/throw` route.* Tiny attack surface but
  unnecessary. Rejected.

## Risks / Trade-offs

- **Risk:** A misbehaving page produces enough unique
  fingerprints to defeat dedup (e.g., `Date.now()` in error
  messages, random IDs in stack-trace lines). →
  **Mitigation:** The 30-events/minute hard cap is the
  back-stop and applies regardless of fingerprint. The counter
  still reflects truth.

- **Risk:** A future BE-via-OTLP slice accidentally routes
  backend logs through the FE-shaped pipeline. →
  **Mitigation:** The `filter/frontend_only` Collector
  processor explicitly drops records whose `service.name !=
  frontend`. Documented in the Collector config.

- **Risk:** A regex in the PII scrub matches too aggressively
  and redacts diagnostically useful content (e.g., a 40-char
  hexadecimal commit SHA matches the bearer-token regex). →
  **Mitigation:** The regex set is deliberately conservative
  (JWT shape requires the dot-separated three-segment form;
  bearer regex requires base64 alphabet including `+/=`,
  which excludes hex). Documented test cases live alongside
  the patterns in `error-sink.test.ts` and a Collector unit
  test.

- **Risk:** The fingerprint computation depends on
  `error.stack` format, which is browser-vendor-specific. →
  **Mitigation:** The fingerprint extractor parses the first
  frame defensively (try/catch) and falls back to
  `error.constructor.name` alone if parsing fails. Same
  fingerprint shape every Web RUM tool uses; the failure
  mode is "less precise grouping," not "no grouping."

- **Risk:** Bundle size grows by 25–35 KB gzipped when
  `VITE_OTEL_ENABLED` is true. →
  **Mitigation:** Default `pnpm dev` and CI builds have
  `VITE_OTEL_ENABLED` unset; the OTel imports are
  side-effect-only and tree-shake out of the default build.
  A future "FE production bundle" slice will move all three
  observability bootstraps behind a dynamic `await import()`.

- **Risk:** `securitypolicyviolation` events fire on every CSP-
  blocked resource — potentially many per page load on a
  misconfigured CSP. →
  **Mitigation:** Same dedup + rate-cap applies. A CSP audit
  is a separate concern (no CSP is currently configured for
  this project; the event listener is "future-proofing for
  when one is").

- **Risk:** The dev-only `/__dev/throw` route ships to
  production by accident if the `import.meta.env.DEV` gate is
  bypassed. →
  **Mitigation:** Build-time check — a CI lint rule asserts no
  reference to `__dev/throw` survives in
  `frontend/dist/assets/*.js` after `pnpm build`. Captured
  in tasks.md.

## Migration Plan

This is an additive slice. No data model changes, no API
changes, no behavioural changes when `VITE_OTEL_ENABLED` is
unset (the default in CI and most local dev).

Deploy order does not matter — the Collector logs pipeline
accepts records regardless of whether Loki is ingesting yet;
Loki ingests regardless of whether the Collector has any
records. A fresh checkout that pulls this slice gets the new
dashboard row, the new Collector pipeline, and the new SDK
bootstrap at the same time; docker compose picks them up on
the next `--profile observability up`.

**Rollback:** revert the change. There is no persisted state to
clean up. Loki retains the `frontend.error` records for the
configured retention window; they will roll off naturally.

## Open Questions

- **Should the Collector's PII regex set be exposed as a
  configurable processor parameter?** Today the patterns live
  hard-coded in `collector-config.yaml`. A configurable form
  would let local dev relax the redaction for diagnosing the
  redactor itself. Deferred — fix when it bites.

- **Should the React error boundary fallback UI offer a
  "Send error details" button?** Production tools (Sentry's
  `showReportDialog`) do this. Skipped for slice 7 (no support
  channel exists yet); revisit when one does.

## Open Follow-ups

These are explicitly NOT in scope for this slice but are
recorded for the next observability slice's "Why" section:

- **Source-map symbolication slice.** Build-pipeline upload,
  symbol store, resolver. The pre-deploy reminder in project
  memory will surface this before any real-server deploy.
- **Alerting / SLO slice.** Burn-rate alerts on
  `frontend_errors_total` and on the slice-6 Web Vitals;
  Alertmanager wiring.
- **Tail-sampling slice unifying FE + BE policy.** Carried
  forward from slices 5 and 6 — error spans should be
  always-kept under tail sampling.
- **Dynamic-import code splitting for `tracer.ts`,
  `meter.ts`, and `errors.ts`.** Carried forward; this slice
  grows the static telemetry footprint, making deferral
  slightly more costly.
- **Field-level encryption for error event payloads.** A
  step-up from regex redaction for environments with stricter
  PII contracts.
- **Sentry-style "Send error details" UI button** in the
  error boundary fallback once a support channel exists.
- **CSP audit + provisioning slice.** No CSP exists today;
  the `securitypolicyviolation` listener will sit idle until
  a CSP is configured.
- **Cross-Vitals histogram bucket audit** carried forward
  from slice 6.
