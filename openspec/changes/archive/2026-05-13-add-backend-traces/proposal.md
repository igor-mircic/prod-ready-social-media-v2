# add-backend-traces

## Why

Slices 1 (metrics) and 2 (logs) of observability are landed. Their proposals
forward-referenced this slice in two specific ways: slice 2 reserves the ECS
keys `trace.id` and `span.id` on every log line but currently emits them empty,
and slice 1 forecasted that distributed tracing would arrive next. The
practical consequences today:

- A reader looking at a Grafana spike on the `feed.fanout.duration` panel
  cannot answer the question "show me the slowest 10 requests in this
  five-minute window and what each was doing per database call." The metric
  proves a regression exists; it cannot show *where* time was spent.
- The four `@Timed` business hot paths (`feed.fanout.duration`,
  `feed.read.duration`, `posts.create.duration`, `follows.follow.duration`)
  are *latency counters* but not span boundaries. A slow `POST /api/v1/posts`
  is observed as one number, not as a tree of "controller → service → JDBC
  insert → fanout → JDBC insert per follower."
- The structured-log `trace.id` slot is reserved but always absent. A reader
  who knows a single request's `request.id` cannot pivot from there to the
  span tree of that request, because there is no span tree.

This change introduces the third of three observability slices — the **traces**
pillar — using the OpenTelemetry Java agent shipping spans directly to a local
Tempo container. After this change, every JSON log line the backend emits
during a request carries a populated `trace.id` (and `span.id`); the same
`trace.id` is searchable in Tempo's Grafana datasource, and the four `@Timed`
business methods appear as named spans inside the per-request trace tree
without any new annotations.

**Why the OTel Java agent and not Micrometer Tracing?** Spring Boot 4 also
ships first-party tracing via `micrometer-tracing-bridge-otel`, which would
hook into the same Observation API that powers the slice-1 `@Timed`
annotations. The agent is the production-realism pick for three reasons:
(1) it auto-instruments the libraries Spring Boot's starters cannot reach on
their own (HikariCP pool acquisition, Apache HttpClient, JDBC driver, future
Kafka / gRPC); (2) it is what real production deploys actually run with, so
the local stack mirrors what an operations team would attach in prod; and
(3) it adds zero application dependencies — the JAR attaches at JVM start
and the application source has no `import io.opentelemetry.*`. The trade-off
(the agent's MDC integration uses Logstash-style keys `trace_id`/`span_id`,
not ECS-style `trace.id`/`span.id`) is reconciled in `design.md` Decision 2.

**Why Tempo and not Jaeger?** Tempo is the Grafana-native trace store: drops
into the existing observability compose profile next to Prometheus and
Grafana, uses the same dashboard surface the team already reads, and
provisions through the same `infra/observability/grafana/provisioning/`
directory that slice 1 established. Jaeger is the alternative — older, more
polished standalone UI, heavier ops surface (its own UI server). For a
learning project that has already committed to Grafana, Tempo is the
boring-correct pick. Recorded in `design.md` Decision 4.

**Why ship direct to Tempo from the agent and not via an OTel Collector?**
The collector is the production-shaped answer (it's where you'd add tail
sampling, redaction, fan-out to multiple backends, and span filtering). For
this slice, a direct agent → Tempo OTLP/HTTP path is one fewer container,
one fewer config file, and matches the slice-1 pattern of "ship as direct as
possible, introduce indirection when a feature demands it." Slice 4 (log
shipping with Loki) is the natural moment to introduce the collector,
because at that point we already need a process between the application and
Loki and may as well consolidate trace + log shipping. Recorded in
`design.md` Decision 5.

## What Changes

- **Backend — pin the OTel Java agent JAR** in
  `backend/gradle/libs.versions.toml` as a versioned coordinate
  (`io.opentelemetry.javaagent:opentelemetry-javaagent`). Add a Gradle
  `agent` configuration that resolves the JAR into
  `backend/build/otel/opentelemetry-javaagent.jar` so `bootRun`, `bootJar`,
  and the integration-test JVM all attach the same byte-identical agent.
  No application-source dependency on any `io.opentelemetry.*` package.
- **Backend — wire the agent into `bootRun`, `bootJar`, and `test`** by
  registering `-javaagent:.../opentelemetry-javaagent.jar` as a JVM argument
  on each task in `backend/build.gradle.kts`. The agent JAR is downloaded
  by the resolved `agent` configuration, not by the application classpath;
  the application's runtime classpath stays unchanged.
- **Backend — agent configuration via `OTEL_*` environment variables**
  declared as defaults in `backend/build.gradle.kts` for `bootRun` and
  `test`, overridable by real env at runtime:
  - `OTEL_SERVICE_NAME=backend` (matches the slice-1 Micrometer common tag)
  - `OTEL_RESOURCE_ATTRIBUTES=service.environment=local,deployment.environment=local`
    (matches the slice-2 `service.environment` log field)
  - `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
  - `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
  - `OTEL_TRACES_EXPORTER=otlp`
  - `OTEL_METRICS_EXPORTER=none` (slice 1 owns metrics via Prometheus pull;
    we do NOT want the agent to also push duplicates over OTLP)
  - `OTEL_LOGS_EXPORTER=none` (slice 4 owns log shipping; the agent stays
    out of stdout)
  - `OTEL_INSTRUMENTATION_LOGBACK_MDC_ENABLED=true` (puts trace context
    into Logback's `LoggingEvent` MDC view at log-emit time)
- **Backend —
  `observability/EcsTraceFieldsCustomizer.java`** new
  `StructuredLoggingJsonMembersCustomizer<?>` implementation (Spring Boot 4
  native extension hook) that reads the agent-populated MDC keys `trace_id`,
  `span_id`, `trace_flags` from the structured-log event and re-emits them
  as ECS-canonical nested keys `trace.id`, `span.id`, `trace.flags` on the
  JSON envelope. The Logstash-style keys are dropped from the output so
  every line carries exactly one naming convention. The customizer is
  registered via `backend/src/main/resources/META-INF/spring.factories`
  (not `@Component`) — Spring Boot 4 initializes the structured-log
  formatter during Logback init, before the Spring context exists, and
  loads customizers via `SpringFactoriesLoader`. This avoids introducing
  `logback-spring.xml` (forbidden by the existing slice-2 spec requirement
  "No logback-spring.xml is introduced"). Decision 2 in `design.md` records
  why this approach was chosen over the alternatives (custom Logback
  converter, agent-side key remap).
- **Infra — new `infra/observability/tempo/` directory**:
  - `tempo.yaml` — single-binary Tempo configuration declaring OTLP
    receivers on `4317` (gRPC) and `4318` (HTTP), local-filesystem WAL +
    blocks storage under `/var/tempo`, HTTP API on `3200`, and a 1-hour
    block retention (this is local dev — not production).
- **docker-compose.yml** gains one new service under
  `profiles: ["observability"]`:
  - `tempo` — image `grafana/tempo:2.6.1`, mounts
    `./infra/observability/tempo/tempo.yaml`, exposes `3200:3200`,
    `4317:4317`, `4318:4318`, runs `-config.file=/etc/tempo.yaml`. The
    existing `prometheus` and `grafana` services are unchanged; the
    `grafana` service gains `depends_on: [prometheus, tempo]`.
- **Infra —
  `infra/observability/grafana/provisioning/datasources/tempo.yaml`** new
  Grafana datasource provisioning file declaring `Tempo` of type `tempo`
  at `http://tempo:3200`, `editable: false`, `isDefault: false` (Prometheus
  remains default). The file carries a comment forward-referencing slice 4:
  the `tracesToLogs` correlation block will be added once Loki is
  provisioned as a datasource.
- **Infra — `Backend overview` dashboard gains a "Recent traces" panel** in
  `infra/observability/grafana/dashboards/backend-overview.json`. The panel
  is a Tempo `traceql` query of `{ resource.service.name = "backend" }` in
  table form with a clickable `traceId` column. Single panel; this slice is
  plumbing, not dashboard design.
- **Backend — integration test
  `observability/TracingIT.java`** new Testcontainers IT that boots the
  full Spring context against a Testcontainers Postgres **with the OTel
  agent attached** (the `test` task already carries the
  `-javaagent` argument). Asserts:
  - the agent's `OpenTelemetry` global is registered (proves the agent
    attached and did not silently fall back to the no-op SDK);
  - one authenticated controller request emits one
    `event.dataset=backend.access` JSON log line whose `trace.id` field
    is a non-blank 32-character lowercase hex string (proves agent →
    MDC → ECS-customizer → JSON pipeline);
  - the same line's `span.id` field is a non-blank 16-character
    lowercase hex string;
  - a log event emitted *outside* a span (e.g., from a fresh thread)
    carries no `trace.id` and no `span.id` field;
  - one authenticated `POST /api/v1/posts` request emits an access-log
    line carrying populated `trace.id` and `span.id` ECS fields (proves
    the endpoint that invokes the slice-1 `@Timed PostService.create`
    method is traced end-to-end).
  The literal "captured span set contains a span named `PostService.create`"
  assertion from the original proposal text is **deferred**: the production
  OTel Java agent's instrumentation modules cache `Tracer` references at
  module-load time, which makes the `opentelemetry-sdk-testing`
  `OpenTelemetryExtension` / `InMemorySpanExporter` swap pattern
  ineffective. A future change can wire a custom agent extension JAR
  (`OTEL_JAVAAGENT_EXTENSIONS=…`) exposing captured spans to the test
  classloader. `design.md` Decision 6 records this trade-off; the
  README copy-paste workflow is the manual smoke for the OTLP wire path.
- **README.md** gains a `### Distributed tracing` subsection under the
  existing `## Local observability` section. Documents:
  - that `docker-compose --profile observability up -d` now also brings
    up `tempo`,
  - that the backend ships spans to `http://localhost:4318` over OTLP/HTTP,
  - an example log line showing populated `trace.id` and `span.id`,
  - how to copy a `trace.id` out of a log line and paste it into Tempo's
    Grafana search,
  - a forward-pointer that the auto "click `trace.id` in a log line →
    jump to Tempo" link will land in slice 4 once Loki provides the
    log-line datasource.

### Explicit non-goals (deferred to follow-ups)

- **Log shipping to Loki, Elasticsearch, or any sink.** Logs continue to
  render to stdout only. Slice 4 of observability owns Loki + Grafana
  Alloy and is when the trace-to-logs auto-link materialises.
- **OTel Collector as a separate process.** The agent ships spans
  directly to Tempo over OTLP/HTTP. Introducing a collector becomes
  worthwhile in slice 4 (it consolidates trace + log shipping and
  enables tail-sampling / redaction). Recorded as known follow-up in
  `design.md`.
- **Tail-based or head-based sampling.** Local dev runs at 100% sampling
  (the OTel agent default `parentbased_always_on`). Production would
  reduce this; sampling configuration is recorded as a future change.
- **Manual span instrumentation via `@WithSpan` or
  `tracer.spanBuilder(...)`.** The agent's auto-instrumentation covers
  Spring MVC, JDBC, HikariCP, and the slice-1 `@Timed` business methods
  for free. We do not add hand-rolled spans on top until a specific
  hot-path call is missing from a trace tree.
- **Authentication on Tempo's UI.** Tempo runs anonymous (it is a
  container reachable only from the Docker network and the developer's
  loopback). Production would gate this with the same OIDC/basic-auth
  story as Prometheus and Grafana. Recorded as known follow-up.
- **Front-end / RUM (Real User Monitoring) tracing.** The React app
  emits no OTel spans; `traceparent` headers from the SPA to the
  backend are not propagated. A future change could add browser-side
  tracing.
- **Outbound `traceparent` header injection** on application-initiated
  HTTP calls. The backend has no outbound HTTP calls today — the agent
  will inject `traceparent` automatically the moment one appears.
- **Per-line `trace.id` outside the servlet request lifecycle for the
  manual `request.id` / `user.id` keys.** The agent already propagates
  `trace.id` / `span.id` across thread boundaries via OTel `Context`,
  so off-request log lines carry trace context correctly. The
  pre-existing async-MDC gap from slice 2 (manual `request.id` /
  `user.id` not propagated to off-request threads) is **not** fixed
  here and remains a known follow-up. See `design.md` "Open follow-ups."
- **CI assertion that spans land in Tempo.** The new IT uses an
  in-process exporter to prove the wiring. We do not run a Tempo
  container in CI.
- **Alerting on trace volume / error-span rate.** Prometheus
  Alertmanager is still not wired. Trace data is for human eyeballs in
  Grafana for now.

## Capabilities

### Modified Capabilities

- `observability` — gains five new requirements (agent attachment and
  pinning, OTLP exporter wiring, MDC key reconciliation to ECS-canonical
  shape, Tempo provisioning under the observability profile, README run
  loop, integration test). The existing slice-1 requirements (Prometheus
  scrape, Micrometer common tags, `TimedAspect`, business timers, dashboard
  / Prometheus / Grafana provisioning) and slice-2 requirements (ECS JSON
  console format, request-id filter, user-context filter, access-log
  filter, observability web config, structured-log IT) are untouched.

### Touched-but-not-modified Capabilities (cited for clarity)

- `user-accounts` — the agent attaches at JVM start and is invisible to
  the security chain. No new endpoints exposed; no
  `SecurityFilterChain` allowlist changes; `SecurityConfig.java` is not
  touched by this slice. Tempo's HTTP API is in the Docker network and
  on a developer port (`3200`), not on the application's port `8080`.
- `posts`, `follows`, `feed`, `api-contract`, `frontend-scaffold`,
  `frontend-styling`, `monorepo-layout`, `backend-scaffold`, `ci`,
  `e2e` — no changes. The agent makes the existing `@Timed`
  annotations from slice 1 emit spans automatically, but the
  annotations themselves and the methods they wrap are unchanged.

## Impact

- **Backend:**
  - Modified: `backend/gradle/libs.versions.toml` — pin
    `io.opentelemetry.javaagent:opentelemetry-javaagent` (current stable
    `2.10.0`; verify at implementation time).
  - Modified: `backend/build.gradle.kts` — declare `agent` configuration
    that resolves the JAR to
    `build/otel/opentelemetry-javaagent.jar`; register `-javaagent:`
    JVM argument on `bootRun`, `bootJar`'s launcher, and `test`; declare
    the `OTEL_*` env-var defaults on `bootRun` and `test`.
  - New: `backend/src/main/java/com/prodready/social/observability/EcsTraceFieldsCustomizer.java`
    — `StructuredLoggingJsonMembersCustomizer` that re-maps Logstash-style
    `trace_id` / `span_id` / `trace_flags` MDC keys into ECS-canonical
    `trace.id` / `span.id` / `trace.flags` JSON keys.
  - New: `backend/src/test/java/com/prodready/social/observability/TracingIT.java`.
- **Infra:**
  - New: `infra/observability/tempo/tempo.yaml`.
  - Modified: `infra/observability/grafana/provisioning/datasources/`
    — new file `tempo.yaml`.
  - Modified: `infra/observability/grafana/dashboards/backend-overview.json`
    — add one "Recent traces" panel.
- **docker-compose.yml** at repo root — one new `tempo` service under
  `profiles: ["observability"]`; existing `grafana` service gains
  `depends_on: [prometheus, tempo]`. The default `docker-compose up`
  invocation continues to start only `postgres`.
- **README.md** at repo root — new `### Distributed tracing` subsection
  under `## Local observability`.
- **OpenSpec specs:**
  - Modified at archive time: `openspec/specs/observability/spec.md` —
    five new requirements appended.
- **CI:** No new jobs. The existing backend IT job picks up `TracingIT`
  automatically (the `-javaagent` argument is on the `test` task).
- **Database:** No migrations. No schema changes.
- **Dependencies:**
  - One new pinned JAR coordinate
    (`io.opentelemetry.javaagent:opentelemetry-javaagent`) in the new
    `agent` Gradle configuration. **Not on the application or test
    classpath** — only resolved into a file the JVM `-javaagent:` flag
    points at.
  - One new Docker image (`grafana/tempo:2.6.1`) pulled only when the
    observability compose profile is activated.
- **Frontend / e2e:** No changes. The OTel agent attaches to the backend
  JVM only; the React app and the Playwright harness are unaffected.
  When `e2e/` boots the backend JAR, the JAR's `bootJar` launcher
  carries the `-javaagent:` flag automatically (set up at build time),
  so e2e runs already attach the agent — though no e2e test asserts on
  trace presence.
