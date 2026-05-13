# add-backend-traces — Design

## Context

Slices 1 (metrics) and 2 (logs) of observability shipped a deliberately
"Spring-canonical" stack: Micrometer + Prometheus + Grafana for metrics,
Spring Boot 4's native ECS structured logging on stdout for logs. Both
slices were implemented as additive infrastructure with zero changes to
business code (apart from four `@Timed` annotations that are themselves
cross-cutting). Their proposals explicitly tee up this slice: slice 2
reserved the JSON keys `trace.id` and `span.id` on every log line; slice 1
forecasted that traces would land "as the third pillar."

The current state, immediately before this change:

- The four `@Timed` business hot paths (`feed.fanout.duration`,
  `feed.read.duration`, `posts.create.duration`,
  `follows.follow.duration`) emit Prometheus histograms but produce no
  span data. A Grafana spike on a `@Timed` panel cannot be drilled into.
- Every JSON log line carries the ECS shape `trace.id`, `span.id`
  *slots*, but they are unset because nothing populates the underlying
  MDC. (Spring Boot 4's `EcsStructuredLogFormatter` lifts MDC entries
  into the JSON envelope on emit.)
- The existing observability filters (`RequestIdFilter`,
  `RequestLoggingFilter`, `UserContextLogFilter`) all manage their own
  MDC keys and do not interact with any tracing context.
- `infra/observability/` already contains `prometheus/` and `grafana/`
  subtrees with provisioning files. There is no third-pillar storage
  for spans.

Constraints carried over from the slice-1 / slice-2 conventions, and
honoured by this slice:

- **No `logback-spring.xml` or `logback.xml`.** Slice 2's spec contains
  the requirement "No `logback-spring.xml` is introduced" — we cannot
  reconcile MDC key naming via a Logback converter.
- **No new logging dependencies.** Slice 2 explicitly forbade
  `logstash-logback-encoder` and the equivalent reasoning extends here.
- **No high-cardinality labels in span attributes.** Slice 1 banned
  `userId`, `post_id`, `email` from Prometheus labels; the same reasoning
  applies to span attributes that drive trace search.
- **Default `docker-compose up` continues to start only `postgres`.**
  Slice 1 established the `observability` profile gate; we extend that
  profile, not the default.
- **No changes to `SecurityConfig` or any `user-accounts/` source.**
  Slice 2 made the same promise; nothing about tracing requires changes
  to authn/authz.

## Goals / Non-Goals

**Goals:**

- Every JSON log line emitted during a servlet request carries a
  populated, non-blank `trace.id` (32-character lowercase hex) and
  `span.id` (16-character lowercase hex) field.
- The `trace.id` value on a log line is the same value present in the
  span tree shipped to Tempo (i.e. log lines and spans share a join
  key). A reader can paste a `trace.id` from a log line into Tempo's
  Grafana search and find the corresponding trace.
- The four slice-1 `@Timed` business methods appear as named child
  spans inside the controller-level span without any new annotations
  on application code.
- Tempo is added to the existing `observability` docker-compose
  profile and provisioned as a Grafana datasource so the local dev
  loop stays one command (`docker-compose --profile observability up
  -d`).
- The existing slice-1 metrics surface and slice-2 log shape are
  unchanged on the wire (the trace-key reconciliation is additive — it
  populates previously-empty slots and removes the agent's
  Logstash-style duplicates from the same line).
- The integration test asserts the agent → MDC → ECS pipeline is
  wired correctly without booting a Tempo container in the test JVM.

**Non-Goals:**

- Manual span instrumentation (`@WithSpan`, `tracer.spanBuilder(...)`)
  on application code.
- Tail-based or head-based sampling configuration. Local default is
  100% sampling.
- An OTel Collector container in this slice. Direct agent → Tempo is
  one fewer moving part. Slice 4 will introduce the collector when
  log shipping demands it.
- Loki, log shipping, or the trace-to-logs auto-link in Grafana. Slice
  4 owns that.
- Frontend / RUM tracing. The React app emits no spans; `traceparent`
  is not propagated from the SPA.
- Outbound `traceparent` injection from the backend — we have no
  outbound HTTP today, and the agent will inject automatically the
  moment one appears.
- Authentication on Tempo's UI. Anonymous viewer matches the
  Prometheus/Grafana posture; production hardening is a future change.
- Fixing the slice-2 async-MDC gap for the manual `request.id` /
  `user.id` keys. See "Open follow-ups."

## Decisions

### Decision 1: OpenTelemetry Java agent, not `micrometer-tracing-bridge-otel`

Spring Boot 4 ships first-party tracing via Micrometer Tracing
(`io.micrometer:micrometer-tracing-bridge-otel` plus
`io.opentelemetry:opentelemetry-exporter-otlp`). It hooks into the same
Observation API that powers the slice-1 `@Timed` annotations and would
arguably be the more "Spring-native" choice.

We choose the **OTel Java agent** instead, for three reasons.

First, **coverage**. The agent auto-instruments the libraries Spring
Boot's own integration cannot reach: HikariCP pool acquisition (so a
trace shows time waiting for a connection), the Postgres JDBC driver
(so each query is a span with the SQL summary as the span name),
Apache HttpClient and the JDK `HttpClient` (so future outbound calls
are traced for free), and Tomcat's request/response lifecycle
(including the security filter chain). Micrometer Tracing covers
Spring MVC and `RestTemplate`/`WebClient`; everything else needs
add-on libraries (e.g. `datasource-micrometer-spring-boot-starter`)
that re-create what the agent already does.

Second, **production realism**. Real production deploys attach the
OTel Java agent at JVM start. Running the same agent locally means
the local trace tree is shaped exactly like the production trace
tree — same span names, same attributes, same propagation behaviour.
The user's stored preference for production-grade architectures
applies here: pick what production uses, not what's easier to
configure in a Spring app.

Third, **zero application coupling**. The agent attaches via a JVM
flag. The application source has no `import io.opentelemetry.*`. If
we ever swap to a different tracing approach, the change is "remove
the JVM flag." The agent does the bytecode rewriting at JVM start;
the app remains entirely unaware of it.

The trade-off is real: the agent's MDC keys are Logstash-style
(`trace_id`, `span_id`), not ECS-style (`trace.id`, `span.id`). We
reconcile that in Decision 2 below.

**Alternatives considered and rejected:**

- *Micrometer Tracing only.* Coverage gap on JDBC and HikariCP; less
  production-shaped; introduces application-level Spring beans that
  would couple slice 3 to specific Spring-Boot module versions.
- *OTel SDK only (no agent), wired via Spring beans.* Worst of both
  worlds: no auto-instrumentation breadth, plus application code has
  to import the SDK.
- *Both — agent + Micrometer Tracing.* Spans get duplicated; the
  agent emits its own controller span and Micrometer's Observation
  bridge emits a parallel one. The OTel docs explicitly warn against
  this.

### Decision 2: Reconcile MDC key naming via a `StructuredLoggingJsonMembersCustomizer` registered through `META-INF/spring.factories`

The OTel Java agent's `instrumentation-logback-mdc-1.0` module puts
`trace_id`, `span_id`, and `trace_flags` into the Logback
`LoggingEvent`'s MDC view at log-emit time. (It does not write to
real per-thread `MDC` storage — see the project memory note on this.)
Spring Boot 4's `EcsStructuredLogFormatter` then lifts those keys
into the JSON envelope verbatim, so by default we would emit:

```json
{ ..., "trace_id": "...", "span_id": "...", "trace_flags": "01" }
```

We want the ECS-canonical nested form on every line:

```json
{ ..., "trace": { "id": "...", "flags": "01" }, "span": { "id": "..." } }
```

Spring Boot 4 exposes a first-party hook for exactly this kind of
field-level rewrite: an implementation of
`StructuredLoggingJsonMembersCustomizer<?>`. The customizer
intercepts the JSON members for each event and can add, rename, or
drop keys. We declare one class
(`backend/src/main/java/com/prodready/social/observability/EcsTraceFieldsCustomizer.java`)
that:

1. Reads `trace_id`, `span_id`, `trace_flags` from the event's MDC
   view.
2. If `trace_id` is non-blank, emits `trace.id`. (Same for `span_id`
   → `span.id`, `trace_flags` → `trace.flags`.)
3. Removes the Logstash-style keys from the JSON output, so each
   line carries exactly one naming convention.

**Alternatives considered and rejected:**

- *Logback `MDCConverter` rename via a custom converter pattern.*
  Requires `logback-spring.xml` to wire the converter, which is
  forbidden by the slice-2 spec ("No `logback-spring.xml` is
  introduced"). Hard rejection.
- *OTel agent system property to rename the keys at the source*,
  e.g. `otel.instrumentation.logback-mdc.trace-id-key=trace.id`.
  No such property exists in the agent's current shipping config
  (the keys are hard-coded in the Logback-MDC instrumentation
  module). If the agent ever adds it, the customizer becomes
  redundant and can be removed.
- *Pre-emit thread-local `MDC.put("trace.id", MDC.get("trace_id"))`
  in a servlet filter.* Doesn't work — the agent injects keys at
  log-event-construction time, not into the per-thread `MDC`. The
  filter-level `MDC.get("trace_id")` returns null.
- *`logging.structured.json.add` static keys.* The Spring Boot
  `add` knob takes static literals only; it cannot reference
  per-event MDC values.

The customizer approach is the only path that simultaneously honours
the slice-2 "no `logback-spring.xml`" rule, requires no application
dependency on `io.opentelemetry.*`, and runs at the right point in
the JSON-emission pipeline.

**Registration mechanism**: Spring Boot 4 initializes
`StructuredLogFormatterFactory` during Logback init, *before* the
Spring application context exists. The factory's
`JsonMembersCustomizerBuilder.loadStructuredLoggingJsonMembersCustomizers()`
uses `SpringFactoriesLoader` (legacy `META-INF/spring.factories` SPI
or the `logging.structured.json.customizer` property) — not the
Spring bean container — to discover customizers. So
`EcsTraceFieldsCustomizer` is registered via
`backend/src/main/resources/META-INF/spring.factories`, not as a
`@Component` / `@Configuration` bean. The `@Order` annotation is
still honoured by the loader's `OrderComparator` sort.

**Path-filter semantics**: Spring Boot 4's
`Members.applyingPathFilter(Predicate<MemberPath>)` predicate is
*exclusionary* — returning `true` from the predicate drops the path
from the rendered JSON, `false` keeps it. (Confirmed empirically:
returning `true` for "keep" produces an empty `{}` line for every
event.) The implementation reflects this: the filter targets the
flat top-level Logstash-style keys and returns `true` to skip them.

### Decision 3: Resolve the agent JAR via a dedicated Gradle `agent` configuration, not the runtime classpath

The agent JAR (`opentelemetry-javaagent.jar`) is *not* a runtime
dependency in the conventional sense — it must be passed to the JVM
as `-javaagent:<path>` *before* the application classpath is loaded.
Putting it on `runtimeClasspath` would cause `ClassNotFoundException`
chaos because the agent JAR shades dozens of conflicting copies of
common libraries (it's deliberately a fat JAR that lives in its own
classloader).

We declare a dedicated Gradle configuration:

```kotlin
val agent: Configuration by configurations.creating
dependencies {
    agent(libs.opentelemetry.javaagent)
}

val copyOtelAgent by tasks.registering(Copy::class) {
    from(agent)
    into(layout.buildDirectory.dir("otel"))
    rename { "opentelemetry-javaagent.jar" }
}
```

…and wire `-javaagent:` onto the three JVM entry points that matter:

- `tasks.named<BootRun>("bootRun") { dependsOn(copyOtelAgent); jvmArgs(...) }`
- `tasks.named<BootJar>("bootJar") { ... }` — the agent path is
  expressed relative to the JAR launcher, so e2e's
  `java -jar build/libs/backend.jar` invocation also attaches the
  agent. (Implementation detail: write the agent JAR alongside the
  bootJar output and pass `-javaagent:` via `JAVA_TOOL_OPTIONS` in
  the e2e launcher script. Final wiring is in `tasks.md`.)
- `tasks.named<Test>("test") { dependsOn(copyOtelAgent); jvmArgs(...) }`
  — so `TracingIT` runs with the agent attached.

The `agent` configuration is isolated from `compileClasspath`,
`runtimeClasspath`, and `testRuntimeClasspath`, so it cannot be
accidentally picked up.

**Alternatives considered and rejected:**

- *`io.opentelemetry.instrumentation:opentelemetry-spring-boot-starter`
  on `runtimeClasspath`.* This is the SDK-based path, not the agent
  path. Smaller coverage and reintroduces application-level imports
  (rejected for the reasons in Decision 1).
- *Vendoring the agent JAR into the repo.* Couples the repo to a
  binary blob and bypasses Gradle's caching. The pinned coordinate
  in `libs.versions.toml` is a better record of the version.
- *Downloading the agent via a `wget` step in CI.* Unreproducible
  and bypasses the pin.

### Decision 4: Tempo, not Jaeger, as the trace store

Both are mature OSS span stores. The choice is driven by the existing
stack:

- **Tempo:** Grafana Labs project; no UI of its own; queried via the
  Tempo datasource inside Grafana, alongside Prometheus. Storage is
  pluggable; for this slice it's local filesystem under the Tempo
  container's volume. Pulls one Docker image
  (`grafana/tempo:2.6.1`) — that's it.
- **Jaeger:** Older, has its own polished UI. Adds two containers
  (`jaeger-collector` and `jaeger-query`) or one all-in-one image.
  Grafana has a Jaeger datasource, so a Tempo-vs-Jaeger swap later
  is mechanical.

For a stack that already uses Grafana as the read surface for
metrics and (eventually, slice 4) logs, Tempo is the boring-correct
pick. Recorded so a future reader doesn't relitigate.

### Decision 5: Agent ships direct to Tempo via OTLP/HTTP; no OTel Collector

The OTel Collector is a separate process between application and
backend. It exists for legitimate reasons: tail-sampling, redaction,
fan-out to multiple backends, and protocol translation. None of
those apply to this slice — we have one trace backend, no PII
concerns in span data (the agent does not capture SQL bind variables
or HTTP request/response bodies by default), and 100% local sampling.

OTLP/HTTP (port `4318`) over OTLP/gRPC (port `4317`): both work; we
pick HTTP for one practical reason — debugging is easier (`curl` and
`tcpdump` work) and the protocol's overhead difference at this scale
is irrelevant.

The collector becomes worthwhile in **slice 4**: log shipping with
Loki via Grafana Alloy will require a process between the
application and Loki anyway, and consolidating trace + log shipping
into one collector is the natural shape. Recorded in "Open
follow-ups."

### Decision 6: Integration test asserts on the log-emission pipeline, not on captured spans

Three test strategies were considered:

(a) Boot a real Tempo container alongside Postgres in
`TracingIT`, exercise the backend, then poll Tempo's HTTP API for
the expected `trace.id`. End-to-end fidelity, but adds ~1.5–2s of
cold-start to every test run, depends on Tempo's flushing behavior
(spans are buffered before they're queryable), and adds a CI image
pull.

(b) Register an in-process `InMemorySpanExporter` on the agent's
`OpenTelemetry` global (via `opentelemetry-sdk-testing`'s
`OpenTelemetryExtension`), exercise the backend, then assert
directly on the captured spans. *Discovered at implementation time:*
this does **not** work with the production OTel Java agent. The
agent installs `GlobalOpenTelemetry` at JVM start and its
instrumentation modules cache `Tracer` references at module-load
time (`Instrumenter` builders read `GlobalOpenTelemetry.get()` once,
not per-call). A `resetForTest()` + `set(testSdk)` from
`@BeforeEach` swaps the global, but the agent's already-cached
Tracers continue to feed the original SDK. The official OpenTelemetry
recommendation in this case is to use the `opentelemetry-agent-for-testing`
JAR (a separate test-only agent that exposes
`AgentTestingExporterAccess.getExportedSpans()`) — which would mean
tests run against a *different* agent than production, defeating
purpose 1 of the test ("prove the agent attached successfully").

(c) Assert the log-emission pipeline carries trace context end-to-end:
the agent is attached (a directly-started span has a valid
`SpanContext` with 32-hex `traceId` / 16-hex `spanId`), per-request
access-log lines carry ECS-canonical `trace.id` / `span.id`, and
log lines outside any active span carry neither.

We choose **(c)**, with one deferred follow-up. The pipeline that
matters on the wire — agent → MDC → ECS-customizer → JSON — is
fully covered. The literal "span name `PostService.create` exists in
the captured span set" assertion from the original proposal is
explicitly deferred: it would require a custom agent extension JAR
(`OTEL_JAVAAGENT_EXTENSIONS=…`) exposing a static
`getCapturedSpans()` API to the application classloader, which is
infrastructure for a follow-up change. The README run-loop scenario
(developer pastes a `trace.id` from a log line into Tempo's Grafana
search and lands on the right trace tree) is the manual smoke that
exercises the OTLP wire path.

### Decision 7: 100% sampling locally; sampling configuration is a future change

The OTel agent default is `parentbased_always_on` — every trace is
kept. This is correct for local dev. Production would tune this
down (1% head sampling, or tail-sampling for "errors and slow
traces only" via the Collector). Sampling configuration is
explicitly a future-change concern; we do not introduce
`OTEL_TRACES_SAMPLER` or `OTEL_TRACES_SAMPLER_ARG` defaults.

### Decision 8: Agent emits spans only; metrics and logs exporters are explicitly disabled

The OTel agent can also export metrics and logs over OTLP. We set:

- `OTEL_METRICS_EXPORTER=none` — slice 1 owns metrics via Prometheus
  pull. Letting the agent also push metrics over OTLP would
  duplicate every value, double-count latency histograms, and
  pollute Tempo's adjacent metrics backend (which we don't have).
- `OTEL_LOGS_EXPORTER=none` — slice 2 owns log emission on stdout.
  The agent's Logback log appender would parallel-emit every log
  event over OTLP. Slice 4 will own log shipping; this slice stays
  out of that lane.

Recording these as explicit defaults rather than relying on the
"none" being the future agent default makes the contract obvious to
a reader.

## Risks / Trade-offs

- **Agent + Spring Boot 4 compatibility.** The OTel Java agent's
  Spring instrumentation supports a wide range of Spring versions,
  but a major Spring Boot rev (e.g. 4.0 → 4.1) can briefly outpace
  agent support for new auto-config classes. → **Mitigation:** pin
  the agent version in `libs.versions.toml`, run the new `TracingIT`
  in CI, and treat any agent-attach failure or any "Failed to
  instrument" agent log line as a release blocker. The IT's
  assertion that `OpenTelemetry` global is registered (not the
  no-op fallback) catches the worst-case "agent silently
  attached-but-disabled" failure mode.

- **JVM startup latency.** The agent's bytecode rewriting adds
  ~300–700ms of cold-start time on a developer laptop. → Acceptable
  for `bootRun` and CI. For unit tests that don't need the agent
  (the existing `gradle test` run), the overhead is a one-time per
  JVM cost. The integration tests are already heavy
  (Testcontainers Postgres) so the relative impact is small.

- **Customizer ordering and the trace-fields race.** The
  `StructuredLoggingJsonMembersCustomizer` bean fires per emitted
  log event. If a future change introduces a *second* customizer
  that also touches MDC keys, the Spring contract is "all
  customizers run; order is unspecified unless `@Order` is set."
  → **Mitigation:** declare `@Order(Ordered.LOWEST_PRECEDENCE)` on
  `EcsTraceFieldsCustomizer` so it runs after any other customizer,
  and so its key removal is the last word. Documented inline.

- **Span-attribute cardinality.** The agent's default Spring MVC
  instrumentation uses the matched route template as the span
  name (`GET /api/v1/users/{userId}`), which is bounded
  cardinality. The JDBC instrumentation, however, captures the
  full SQL statement as the `db.statement` attribute, which is
  *high-cardinality but stored, not searched* — Tempo doesn't
  index attributes, it only indexes service / span name / tag
  index, so high-cardinality attributes are storage cost, not
  query cost. → Acceptable for local dev. Production would set
  `OTEL_INSTRUMENTATION_JDBC_STATEMENT_SANITIZER_ENABLED=true`
  (default `true` actually — confirm at implementation time).

- **`@Timed` and span name collisions.** The agent picks up the
  four `@Timed` annotations and emits a span per invocation. The
  span name is `Class.method` (e.g. `PostService.create`) — that
  naming overlaps with the JDBC span emitted from inside the same
  method. → No real problem; the spans nest correctly because the
  agent's `@Timed` instrumentation wraps the method and the JDBC
  instrumentation runs deeper. Worth verifying once in the IT.

- **Agent JAR size.** ~25MB on disk. Adds to `bootJar` distribution
  size if the launcher script ships the agent JAR alongside it. →
  Acceptable. The e2e harness is local-only; production deploy
  would bundle the agent in the container image, not in the JAR.

- **Test isolation between `TracingIT` runs.** The
  `InMemorySpanExporter` is a singleton; if multiple test methods
  share the JVM and don't reset, one test's spans leak into the
  next. → **Mitigation:** in `TracingIT`, the test scaffolding
  resets the exporter in `@BeforeEach` and asserts on the freshly
  captured set in each test method.

## Open follow-ups

These are recorded so they're not lost between this slice and the
next:

- **Async MDC propagation gap (carried from slice 2).** The manual
  `request.id` and `user.id` MDC keys still do not propagate across
  thread boundaries. Slice 3's agent-managed `trace.id` / `span.id`
  *do* propagate (the OTel `Context` is propagated by the agent's
  `ExecutorService` instrumentation), so off-request log lines now
  correctly carry trace context — but they will continue to omit
  `request.id` and `user.id` until an async surface (scheduler,
  `@Async`, custom executor) lands. The fix at that point is a
  Spring `TaskDecorator` that snapshots and re-puts the manual MDC
  keys. Tracked in project memory at `project_async_mdc_gap.md`.

- **OTel Collector introduction** — slice 4 (Loki) is the natural
  moment. Direct-from-agent shipping for traces is fine until then.

- **Trace-to-logs auto-link in Grafana** — needs Loki as the log
  datasource. The Tempo datasource provisioning file leaves a
  forward-reference comment for the `tracesToLogs` block.

- **Sampling configuration** — production deploys will need
  `OTEL_TRACES_SAMPLER` tuned. Local stays at 100%.

- **Tempo authentication and retention** — local Tempo runs
  anonymous with 1-hour block retention. Production needs OIDC and
  longer retention with object-storage backend (S3 / GCS).

- **In-process span-name capture in `TracingIT`** — see Decision 6.
  Today the IT asserts the log-emission pipeline; the literal
  "captured span set contains span name `PostService.create`"
  assertion needs an agent extension JAR
  (`OTEL_JAVAAGENT_EXTENSIONS=…`) that exposes spans through the
  bootstrap classloader. Recorded as a follow-up so a future test
  pass can pick it up.

- **Outbound `traceparent` injection** — already-supported by the
  agent the moment outbound HTTP appears; not a new follow-up,
  just a forward-pointer.

## Migration plan

This is a strictly additive change. There is no data migration, no
schema migration, and no behavioural change to any HTTP endpoint.
Rollback is "remove the `-javaagent:` flag from `bootRun` /
`bootJar` / `test`, remove the `tempo` service from
`docker-compose.yml`, remove the `EcsTraceFieldsCustomizer` bean";
the result is exactly the slice-2 state.

The one rollout subtlety: the `EcsTraceFieldsCustomizer` runs on
every log event. If a developer rolls back the agent attach but
forgets to remove the customizer, the customizer is a no-op
(it reads keys that aren't there and emits nothing) — there's no
broken-state intermediate.
