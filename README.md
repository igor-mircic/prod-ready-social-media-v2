# prod-ready-social-media-v2

An enterprise-realistic social media platform built with Java/Spring, React, and Playwright.

## Monorepo layout

This repo is a flat monorepo. Each top-level directory is owned by one component:

| Directory   | Status      | Component                                         |
| ----------- | ----------- | ------------------------------------------------- |
| `backend/`  | exists      | Java 21 / Spring Boot 4 service (Gradle, Postgres) |
| `frontend/` | exists      | React web client (Vite, TypeScript, pnpm)         |
| `e2e/`      | exists      | Playwright end-to-end harness (Testcontainers Postgres + JAR backend + vite preview) |
| `infra/`    | reserved    | Infrastructure-as-code (added by a future scaffold change) |
| `openspec/` | exists      | OpenSpec change/spec workflow                     |

Reserved directories are not pre-created — each is added by its own scaffold change so the repo
never contains empty placeholder folders.

## Local development

A single `docker-compose.yml` at the repo root brings up the dependencies (currently Postgres)
that any component needs locally. The backend, future frontend dev tooling, and future e2e all
point at this same file.

```sh
docker-compose up -d postgres
```

See `backend/README.md` for backend-specific run and test instructions,
`frontend/README.md` for the frontend dev loop, and `e2e/README.md` for the
Playwright end-to-end harness.

## Logging in locally

Once Postgres, the backend, and the frontend dev server are running:

1. Visit `http://localhost:5173/signup` and create an account (`POST /api/v1/auth/signup`).
2. Visit `http://localhost:5173/login` and sign in with the same email/password
   (`POST /api/v1/auth/login`). The response sets a refresh-token `HttpOnly` cookie
   scoped to `/api/v1/auth/refresh`; the access token lives in memory only.
3. The SPA lands on `/home`, which calls `GET /api/v1/auth/me` to render the
   current user, and offers a Logout button (`POST /api/v1/auth/logout`).

Default token TTLs (overridable via `app.auth.access-token-ttl` and
`app.auth.refresh-token-ttl` in `application.yaml`):

- access token: 15 minutes (`PT15M`)
- refresh token: 30 days (`P30D`)

## Posting locally

After logging in (see above), the `/home` page also renders the posts feature
for the signed-in user:

1. A "New post" composer accepts a non-empty body up to 500 characters. The
   `Post` button stays disabled while the body is empty or whitespace-only.
2. Submitting posts to `POST /api/v1/posts`. On success the list below the
   composer refetches and the new post appears at the top.
3. The list is cursor-paginated (`GET /api/v1/users/{userId}/posts`). When the
   server returns a `nextCursor`, a "Load more" button fetches the next page.
4. Each post you authored renders a Delete control that soft-deletes the post
   via `DELETE /api/v1/posts/{id}` and refetches the list.

The per-endpoint contract lives in `openapi/openapi.json`; the generated
TanStack Query hooks under `frontend/src/api/generated/queries/posts-controller/`
are the source of truth for how the SPA calls those endpoints.

## Local observability

The backend exposes Prometheus-format metrics at `/actuator/prometheus`; an
opt-in compose profile brings up a local Prometheus + Grafana to scrape and
visualise them.

```sh
docker-compose --profile observability up -d
```

- Grafana: `http://localhost:3000` (anonymous viewer access; lands directly on
  the provisioned `Backend overview` dashboard).
- Prometheus: `http://localhost:9090`.
- Tempo: `http://localhost:3200` (queried via the Grafana `Tempo` datasource,
  no standalone UI).

Anonymous viewer access is for local development only — production would gate
the dashboard behind OIDC or basic auth.

### Structured logs

The backend emits one Elastic Common Schema (ECS) JSON object per log event on
stdout (Spring Boot's native `logging.structured.format.console: ecs`), so a
local `bootRun` already produces the same shape a log shipper would index in
production. Every line carries `@timestamp`, `log.level`, `service.name`,
`service.environment`, `process.thread.name`, `log.logger`, `message`, and
`ecs.version`; per-request lines additionally carry `request.id` (and
`user.id` once Spring Security has authenticated the caller).

Each HTTP request emits exactly one access-log line on `event.dataset=backend.access`
summarising method, route template, status, and duration:

```json
{"@timestamp":"2026-05-13T14:00:00Z","log":{"level":"INFO","logger":"backend.access"},
 "service":{"name":"backend","environment":"local"},"process":{"thread":{"name":"http-nio-8080-exec-1"}},
 "event":{"dataset":"backend.access","duration":3241000},"http":{"request":{"method":"GET"},
 "response":{"status_code":200}},"url":{"path":"/api/v1/auth/me"},"duration_ms":3,
 "request":{"id":"7d7c2e8e-1b1a-4d2f-8a4f-9bb6f9c1c0a1"},"user":{"id":"…"},
 "message":"","ecs":{"version":"8.11"}}
```

`/actuator/health` and `/actuator/prometheus` are deliberately skipped so the
per-15-second Prometheus scrape does not flood the log.

Each response carries the correlation id back to the client as `X-Request-Id`,
and the filter honours an inbound `X-Request-Id` header verbatim if the caller
already issued one (so an upstream proxy's id wins):

```sh
curl -i -H 'X-Request-Id: my-correlation-id' http://localhost:8080/api/v1/auth/me
# < HTTP/1.1 401
# < X-Request-Id: my-correlation-id
```

Grep one request's lifetime out of `bootRun` stdout with `jq`:

```sh
./gradlew :backend:bootRun 2>&1 | jq -c 'select(.request.id == "my-correlation-id")'
```

### Distributed tracing

The backend attaches the [OpenTelemetry Java agent](https://opentelemetry.io/docs/zero-code/java/agent/)
to every JVM entry point (`bootRun`, the `bootJar` launcher used by the e2e
harness, and the integration-test JVM). The agent auto-instruments Spring MVC,
HikariCP, JDBC, the slice-1 `@Timed` business methods, and any future outbound
HTTP, emitting one span per call. The same compose profile that brings up
Prometheus and Grafana now also brings up [Tempo](https://grafana.com/oss/tempo/)
as the local span store:

```sh
docker-compose --profile observability up -d
```

Spans flow from the agent to Tempo at `http://localhost:4318` over OTLP/HTTP
(no separate OpenTelemetry Collector — the agent ships direct for now;
slice 4 introduces the collector alongside Loki for log shipping).

Every request log line now carries populated `trace.id` and `span.id` ECS
fields. The MDC keys the agent populates (Logstash-style `trace_id`,
`span_id`, `trace_flags`) are remapped to ECS-canonical nested keys by
`EcsTraceFieldsCustomizer` so each line uses exactly one naming convention:

```json
{"@timestamp":"2026-05-13T14:00:00Z","log":{"level":"INFO","logger":"backend.access"},
 "service":{"name":"backend","environment":"local"},"process":{"thread":{"name":"http-nio-8080-exec-1"}},
 "event":{"dataset":"backend.access","duration":3241000},"http":{"request":{"method":"GET"},
 "response":{"status_code":200}},"url":{"path":"/api/v1/auth/me"},"duration_ms":3,
 "request":{"id":"7d7c2e8e-1b1a-4d2f-8a4f-9bb6f9c1c0a1"},"user":{"id":"…"},
 "trace":{"id":"a3c1f4e2b7d8c9106e5a4b3c2d1e0f9a","flags":"01"},
 "span":{"id":"b2c3d4e5f6071829"},
 "message":"","ecs":{"version":"8.11"}}
```

Manual log-to-trace correlation works as a copy-paste:

1. `jq -c 'select(.url.path == "/api/v1/auth/me")'` over `bootRun` stdout to
   find the request's access-log line.
2. Copy the value of `trace.id`.
3. Open Grafana at `http://localhost:3000`, switch the explore datasource to
   `Tempo`, paste the trace id into the search box, hit run — the span tree
   for that request renders.

The one-click `tracesToLogs` and `logsToTraces` pivots (no copy-paste) are
wired by the `### Log shipping` subsection below.

### Log shipping

The same compose profile that brings up Prometheus, Grafana, and Tempo also
brings up an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
and [Loki](https://grafana.com/oss/loki/):

```sh
docker-compose --profile observability up -d
```

The Collector replaces Tempo as the listener on host ports `4317` and
`4318`. The OTel agent's `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
is unchanged — only the container behind the port differs. Tempo's
`http://localhost:3200` HTTP API binding stays for direct curl debugging;
Tempo's OTLP host port bindings are retired in favour of the Collector
(Tempo is now reachable only as `tempo:4317` inside the docker network).

To enable the file appender the Collector tails, export `LOG_FILE_PATH`
before starting the backend:

```sh
export LOG_FILE_PATH=./infra/observability/logs/backend.json
./gradlew :backend:bootRun
```

With `LOG_FILE_PATH` set, the backend writes the same ECS JSON to that file
alongside its stdout output. The Collector's `filelog` receiver tails the
host directory (bind-mounted into the Collector container) and ships each
line to Loki. Without `LOG_FILE_PATH` set, the file appender does not
engage and the dev loop is byte-identical to the slice 2 / slice 3 default.

In Grafana:

- **`logsToTraces`** (Loki → Tempo): a `trace.id` value in any Loki log
  line renders as a clickable link; clicking it opens the matching Tempo
  span tree.
- **`tracesToLogs`** (Tempo → Loki): from a Tempo span view, the "Logs for
  this span" link opens the matching Loki log lines, scoped by `trace.id`.
- The slice-3 manual workflow ("copy `trace.id` and paste into Tempo
  search") still works, but is no longer necessary.

The host directory (`./infra/observability/logs/`) is committed (with a
`.gitkeep` placeholder) so the Collector's bind-mount target exists on a
fresh clone; the `*.json` content in that directory is gitignored.

### Frontend tracing

The frontend ships an opt-in OpenTelemetry Web SDK that boots before
React renders. With telemetry enabled, every user click and form submit
becomes a span, and every outbound fetch to the backend carries a W3C
`traceparent` header so the Tempo trace tree starts in the browser and
continues seamlessly into the backend's controller and JDBC spans —
one `trace.id`, one trace, two `service.name` values (`frontend` and
`backend`).

Opt in by exporting `VITE_OTEL_ENABLED=true` before starting the dev
server (the default `pnpm dev` invocation stays unchanged):

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

On boot, the devtools console writes exactly one confirmation line:

```
OTel telemetry enabled: traces → http://localhost:4318/v1/traces
```

The default exporter URL points at the OTel Collector's OTLP/HTTP
receiver published from the observability profile; override it with
`VITE_OTEL_TRACES_ENDPOINT` if you front the Collector with a different
host. The Collector's `:4318` receiver carries a `cors` block that
allowlists the Vite dev (`http://localhost:5173`) and preview
(`http://localhost:4173`) origins, so the browser POST succeeds
without a proxy.

Click-to-trace, in Grafana → Explore → Tempo:

1. Click the post composer's `Post` button (or any UI button that
   fires a `useMutation`).
2. In Tempo search, filter by `{ resource.service.name = "frontend" }`
   and find the most recent trace. Its root span is the
   `UserInteractionInstrumentation`-emitted click; the next span is
   `FetchInstrumentation`'s `POST /api/v1/posts`; the children below
   are the backend's controller, `@Timed`, and JDBC spans
   (`{ resource.service.name = "backend" }`).
3. From the same trace, click the `Logs for this span` data link on
   any backend span — Loki returns the ECS log line that carries the
   same `trace.id`.
4. Switch Tempo's view to `Service Graph` (provisioned in
   `infra/observability/grafana/provisioning/datasources/tempo.yaml`
   via the `serviceMap` block) to see the `frontend → backend` edge
   after a few requests have flowed through.

`traceparent` propagation is **scoped to the backend origin** —
`http://localhost:8080` in dev and any URL whose origin matches
`VITE_API_BASE_URL` at build time. The browser SDK does **not** send
`traceparent` or `tracestate` to third-party hosts (CDNs, fonts,
analytics). The Collector's `transform/redact-path-ids` processor
rewrites high-cardinality path segments (UUIDs, opaque hex, numeric
ids) to the literal `{id}` on both FE and BE spans before they reach
Tempo.

Frontend RUM metrics (Web Vitals: LCP, INP, CLS) and frontend errors
(window errors, unhandled rejections, React error boundary events)
are the natural follow-up slices — they will layer on top of the
trace propagation this slice establishes.

### Frontend RUM metrics

The frontend ships an opt-in OpenTelemetry browser metrics SDK that
boots alongside the slice-5 tracer. With metrics enabled, the
[`web-vitals`](https://github.com/GoogleChrome/web-vitals) library
reports finalised LCP / CLS / INP / FCP / TTFB into OTel histograms
named `web_vitals_*`; a React Router `<RouteTimingObserver />`
records SPA route-transition durations into
`route_change_duration_ms` (labelled by route template, never by
resolved id); a `PerformanceObserver({type: 'longtask'})` records
main-thread blocks into `long_task_duration_ms`.

Opt in by exporting `VITE_OTEL_ENABLED=true` before starting the dev
server (the same gate that enables slice-5 traces — flipping it on
opts into both):

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

On boot, the devtools console writes one confirmation line per
telemetry surface:

```
OTel telemetry enabled: traces → http://localhost:4318/v1/traces
OTel telemetry enabled: metrics → http://localhost:4318/v1/metrics
```

Wire path:

1. The browser SDK POSTs OTLP/HTTP metrics to
   `http://localhost:4318/v1/metrics` (the OTel Collector's HTTP
   receiver, the same listener slice 5 uses for traces — its CORS
   allowlist already covers the metrics endpoint).
2. The Collector's slice-6 `metrics` pipeline runs FE data points
   through a `filter/drop_high_cardinality` processor (defence-in-
   depth against any future code path that forgets the route-template
   label) and re-emits them as Prometheus text-exposition on
   `http://localhost:8889/metrics`.
3. Prometheus's `collector` scrape job (added in
   `infra/observability/prometheus/prometheus.yml`) reads
   `:8889/metrics` every 15 s into the same Prometheus instance the
   Backend overview already uses.
4. Grafana provisions the new dashboard at
   `http://localhost:3000/d/frontend-overview` (also reachable via
   Grafana search for `Frontend overview`). Four rows: Web Vitals
   (LCP / CLS / INP / FCP / TTFB p75), route-timing percentiles
   keyed by route, long-task rate and mean duration, and a
   browser-request-volume proxy.

Override the metrics endpoint with `VITE_OTEL_METRICS_ENDPOINT` if
the Collector is fronted by a different host; tighten the export
cadence with `VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` (default 15 s,
matched to Prometheus's `scrape_interval`).

Empty panels are expected on a fresh stack: until a browser session
loads the app with the gate enabled there are no FE samples to
display, and even with the gate on individual Web Vitals only
finalise after specific user actions — LCP after the first paint,
INP after the first event handler completes, CLS at page hide.
Open the app in a tab, click around for a few seconds, and the
Frontend overview dashboard's panels start filling in within one
export + scrape cycle (≤ 30 s).

Frontend errors are covered in the next subsection. FE-plus-BE
alerting / SLO definitions are the natural follow-up slice — it
layers on top of this metrics path, the slice-5 trace path, and
the slice-7 error path.

**Frontend SLOs (LCP, INP).** Four multi-window multi-burn-rate
alerts ride on top of the Web Vitals histograms above:
`LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`,
`InpSloSlowBurn`. They evaluate two SLO targets — LCP `95%` of page
loads `< 2500` ms, INP `95%` of interactions `< 200` ms, both over
a 30 d window — using the same burn-rate constants as the backend
latency SLOs (fast-page 14.4× over 1h+5m, slow-page 6× over
6h+30m). Each alert carries `severity=page`, `slo=lcp|inp`, and
`service=frontend` labels. The Frontend overview dashboard's
`SLO` row surfaces the same SLOs at a glance: error budget
headroom (last 6 h), current 1 h burn rate per SLO, and p75 vs
SLO threshold for LCP and INP. The recording rules backing the
alerts read the `le="2500"` (LCP) and `le="200"` (INP) buckets,
which `frontend/src/observability/meter.ts` pins via per-instrument
`advice.explicitBucketBoundaries`. The Prometheus rule files
(`fe-slo-recording.yml`, `fe-slo-alerting.yml`,
`fe-slo-tests.yml`) live alongside the backend ones in
`infra/observability/prometheus/rules/`. Reminder: Prometheus must
be restarted (`docker-compose --profile observability restart
prometheus`) for `rule_files:` changes to take effect — same caveat
as the slice-8 Alerting subsection below.

### Frontend errors

The frontend captures every uncaught browser exception across four
canonical surfaces and fans each one out to three observability
sinks via the same OTel Collector slice 5 and 6 already use:

- **React error boundary** — a top-level `<FrontendErrorBoundary>`
  wraps `<App />` in `main.tsx`; render-time exceptions are caught
  via `componentDidCatch` and recorded with `kind="boundary"`.
- **`window.error`** — synchronous uncaught JS exceptions and
  resource-load failures (`kind="error"`).
- **`window.unhandledrejection`** — fire-and-forget promise
  rejections (`kind="rejection"`).
- **`window.securitypolicyviolation`** — CSP violation events,
  future-proofing for when a CSP is configured (`kind="csp"`).

Each captured error fans out to three sinks:

- a `span.recordException` event on the active OTel span (Tempo);
- a structured OTel log record with ECS attributes emitted via
  `@opentelemetry/sdk-logs` to the Collector and routed to Loki
  under `event.dataset=frontend.error`;
- a `frontend_errors_total{kind, route}` counter increment
  (Prometheus via the slice-6 metrics pipeline).

Opt in with the same gate as slices 5 and 6:

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

A fourth confirmation line lands on the devtools console at boot:

```
OTel telemetry enabled: logs → http://localhost:4318/v1/logs
```

Wire path:

1. The browser SDK POSTs OTLP/HTTP log records to
   `http://localhost:4318/v1/logs` (the same Collector receiver as
   slice 5/6).
2. The Collector's `logs/frontend` pipeline filters to
   `resource.service.name=frontend` (defence-in-depth against a
   future BE-via-OTLP migration), runs the `transform/pii_scrub`
   processor — a regex backstop redacting JWT, email, and bearer-
   token-shaped substrings to `[REDACTED]` — and promotes
   `event.dataset` + `service.name` to Loki labels.
3. Loki ingests under `{event_dataset="frontend.error",
   service_name="frontend"}` alongside the BE access log under
   `{event_dataset="backend.access"}`.
4. Grafana's Frontend overview dashboard gains an Errors row at
   `http://localhost:3000/d/frontend-overview` — three panels:
   error rate by `kind`, top fingerprints (Loki), and CSP
   violations.

**Dedup + rate cap (SDK-side):** a render-loop pathology can fire
the same exception thousands of times per minute. The SDK
fingerprints each captured error as
`<type>:<first stackframe path>:<line>` and suppresses the
event-shaped sinks (span event, log record) for any fingerprint
that fired within the last **5 s** (`VITE_FE_ERROR_DEDUP_WINDOW_MS`
override), or any further events after **30 per rolling 60 s**
(`VITE_FE_ERROR_RATE_LIMIT` override). The
`frontend_errors_total` counter is **never** gated — aggregate
counts stay accurate even when example surfaces drop.

**PII (defence-in-depth):** the SDK strips JWT, email, and bearer-
token-shaped substrings from `error.message` and
`error.stack_trace` before export. The Collector's
`transform/pii_scrub` processor re-applies the same three regexes
over `attributes.error.message`, `attributes.error.stack_trace`,
and `body` — a last-line guard for any third-party library
exception the SDK regex missed. The patterns live in
`frontend/src/observability/error-sink.ts` (`PII_REGEXES`) and
`infra/observability/collector/collector-config.yaml`
(`transform/pii_scrub`); they must move together.

**Source-map symbolication:** explicitly **out of scope** for
this slice. Built bundles produce munged stack frames; in local
dev Vite serves unminified bundles so frames are already
readable. A dedicated symbolication slice (build-pipeline upload
+ symbol store + Grafana plugin) is queued before any real-server
deploy — see `project_source_maps_pre_deploy.md` in the
auto-memory and the **Open Follow-ups** section of
`openspec/changes/add-frontend-errors/design.md`.

### Alerting

The same observability profile also brings up [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/)
and loads the slice-8 SLO recording + multi-window multi-burn-rate alerting
rules into Prometheus:

```sh
docker-compose --profile observability up -d
```

Three SLOs are evaluated continuously against the backend's existing metrics:

- **API availability** — 5xx ratio on `/api/v1/*`, target `99.5%` over 30d.
  Fast-page (1h × 5m), slow-page (6h × 30m), and ticket (3d × 6h) burn-rate
  alerts fire from the same error budget.
- **Feed read latency** — fraction of `feed.read.duration` requests slower
  than 200ms, target `95%` over 30d. Fast-page and slow-page alerts.
- **Post create latency** — fraction of `posts.create.duration` requests
  slower than 500ms, target `95%` over 30d. Fast-page and slow-page alerts.

Plus a non-SLO operational alert: `BackendDown` fires when Prometheus has
been unable to scrape `up{job="backend"}` for 2 minutes — necessary because
burn-rate alerts can't fire when the target is offline (no samples to divide).

**Where active alerts surface:**

- Alertmanager UI: `http://localhost:9093` (full alert list, silences, status).
- Grafana → Alerting (left-nav) — reads the same alerts via the provisioned
  Alertmanager datasource. No copy-paste from Prometheus needed.
- Raw HTTP: `curl http://localhost:9093/api/v2/alerts` for scripting.

For this slice, Alertmanager is configured with a stub `null` receiver — alerts
are accepted and visible on the surfaces above, but not forwarded anywhere.
A real webhook receiver (PagerDuty / Slack / dev sink) is deferred to the
follow-up slice that also adds fault injection.

**Run the alerting-rule unit tests locally** with `promtool test rules`:

```sh
docker run --rm --entrypoint promtool \
  -v "$PWD/infra/observability/prometheus/rules:/rules:ro" \
  prom/prometheus:v2.55.1 \
  test rules /rules/slo-tests.yml
```

The fixture at `infra/observability/prometheus/rules/slo-tests.yml` is the
executable spec for the alerting rules — each scenario in
`openspec/changes/add-backend-alerting-slos/specs/observability/spec.md`
corresponds to a test stanza. The same one-liner runs in CI as a gate.

**Editing rule files** (`slo-recording.yml`, `slo-alerting.yml`) requires a
Prometheus restart for the changes to take effect; Prometheus reads the rule
files only at startup under this compose setup:

```sh
docker-compose --profile observability restart prometheus
```

(The Grafana datasource provisioning has the same restart requirement — see
the prior subsection's notes on the slice-4 / slice-5 datasource files.)

### Exemplars (metric → trace one-click pivot)

The same observability profile lights up Prometheus exemplar storage and a
Grafana panel-to-Tempo pivot, so a high-latency bucket on the
`http_server_requests_seconds_bucket` histogram is one click away from the
trace that produced it:

```sh
docker-compose --profile observability up -d
```

What's wired:

- The backend's `/actuator/prometheus` endpoint serves OpenMetrics on
  `Accept: application/openmetrics-text`. Each histogram bucket recorded
  while an OTel span was active carries an exemplar suffix
  (`# {trace_id="…",span_id="…"} <value> <ts>`). The bridge to the OTel
  Java agent's active span is the `OpenTelemetryAgentSpanContext` bean in
  `ExemplarsConfig`.
- Prometheus runs with `--enable-feature=exemplar-storage`, so the
  scraped exemplars survive ingestion and surface via
  `/api/v1/query_exemplars`.
- The Grafana Prometheus datasource has `exemplarTraceIdDestinations`
  pointing at the Tempo datasource (UID `tempo`), so any panel with the
  exemplars query option enabled renders diamond markers that open the
  matching trace in Tempo on click.

Click-path: `Backend overview → "p50 / p95 / p99 latency by URI" → click
an exemplar diamond → Tempo trace view`. Exemplars only appear once the
panel's time range covers a sample taken under an active span; drive a
few requests against the running backend, wait one scrape interval
(15 s), and the diamonds fill in.

**Datasource provisioning restart caveat:** Grafana reads provisioning
files only at container start. After editing
`infra/observability/grafana/provisioning/datasources/prometheus.yaml`,
restart Grafana so the new `jsonData.exemplarTraceIdDestinations` (or
any other datasource change) takes effect:

```sh
docker-compose --profile observability restart grafana
```

**Frontend exemplars are deferred:** the OTel Collector's `prometheus`
exporter does not synthesize exemplars from FE OTLP histograms in this
slice, so the Frontend overview dashboard's panels do not yet carry the
metric→trace pivot.

## Prerequisites

- Java 21
- Node (version pinned in `frontend/.nvmrc`) and pnpm (for the frontend)
- Docker (for Postgres and Testcontainers)
