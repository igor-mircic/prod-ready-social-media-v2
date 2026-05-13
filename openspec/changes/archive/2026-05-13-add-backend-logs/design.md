# add-backend-logs — design

## Context

Code state verified against the tree at change-draft time:

- `backend/src/main/resources/application.yaml` carries the
  slice-1 `management.*` block (Micrometer tags, histogram
  buckets) and a `spring.application.name: backend` line. It has
  no `logging.*` block of any kind — every Logback default is in
  effect.
- There is no `logback-spring.xml` or `logback.xml` anywhere
  under `backend/src/main/resources/`. Logback's default
  console-only `PatternLayoutEncoder` is what Spring Boot wires.
- `backend/build.gradle.kts` uses
  `spring-boot-starter-webmvc` and friends; Spring Boot 4.0.6 is
  pinned via `libs.versions.toml`. The `logging.structured.*`
  YAML keys are part of the platform from Spring Boot 3.4
  onwards and are present in 4.0.
- `backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`
  builds a single `SecurityFilterChain` with
  `addFilterBefore(bearerFilter, AnonymousAuthenticationFilter.class)`.
  Spring Security's `springSecurityFilterChain` is itself a
  servlet filter registered at the default order
  `SecurityProperties.DEFAULT_FILTER_ORDER = -100`. Servlet
  filters with order `< -100` run *before* it; filters with
  order `> -100` run *after* it (i.e. inside its
  `chain.doFilter` call), so they see the populated
  `SecurityContextHolder`.
- `BearerTokenAuthenticationFilter` extends
  `OncePerRequestFilter` and sets
  `SecurityContextHolder.getContext().setAuthentication(...)`
  using a `UserPrincipal`. `UserPrincipal` exposes the user's
  UUID via `getId()` (verified against the class). Reading
  `user.id` after auth is a single
  `((UserPrincipal) authentication.getPrincipal()).getId()` call.
- The existing `*IT.java` integration tests under
  `backend/src/test/java/com/prodready/social/` follow a
  consistent Testcontainers-Postgres + `@SpringBootTest(webEnvironment
  = RANDOM_PORT)` pattern (see `MetricsActuatorIT`,
  `FollowsControllerIT`, `MeIT`). `StructuredLoggingIT` follows
  the same shape; it additionally redirects `System.out` to a
  `ByteArrayOutputStream` for the duration of the test so it can
  parse the JSON the app writes, then restores the original
  stream.

## Goals / Non-Goals

**Goals:**

- Ship the logs pillar of observability — structured ECS JSON on
  stdout, plus per-request correlation fields on every line.
- Add no behaviour change to any HTTP response body and no new
  database migration. The only user-visible surface is the
  `X-Request-Id` response header.
- Make the slice self-contained: a developer running
  `./gradlew :backend:bootRun` and tailing stdout sees JSON
  immediately, can grep by `request.id`, and sees one
  `event.dataset=backend.access` line per HTTP request.
- Reserve the ECS `trace.id` / `span.id` slots so slice 3 (OTel
  agent) is a drop-in: the agent populates MDC, the formatter
  already lifts MDC into JSON, no refactor needed.
- Establish a small `ObservabilityWebConfig` class in the
  existing `observability` package so slice 3 and slice 4 have an
  obvious home for further wiring.

**Non-goals:**

- Log shipping (Loki / Elastic / any sink) — slice 4.
- OpenTelemetry agent or any tracing code — slice 3.
- Alerting on log-derived signals — future.
- Per-line context for background threads (schedulers, async
  tasks) — none exist yet.
- Redaction / sensitive-field filtering — no log line currently
  carries a secret; verified by audit of auth code.
- Logback access valve, Tomcat-level request logs.
- Frontend logging.

## Decisions

### Decision 1: Use Spring Boot's native structured logging, not `logstash-logback-encoder`

**Choice:** Set `logging.structured.format.console: ecs` in
`application.yaml`. Do not add `logstash-logback-encoder` as a
dependency. Do not introduce `logback-spring.xml`.

**Why:** Spring Boot 3.4 introduced first-class structured logging
support; 4.0.6 ships the `EcsStructuredLogFormatter` and
`LogstashStructuredLogFormatter` classes out of the box.
Configuration is a single YAML line. Every MDC entry on the
current thread is lifted into the JSON envelope by the formatter
without any encoder configuration.

`logstash-logback-encoder` is the historically dominant library
for this purpose but predates Spring's native support. Adopting
it now means:

- a new transitive dep (`net.logstash.logback`),
- a `logback-spring.xml` file to wire `LogstashEncoder`,
- a divergence from the platform-documented path that future
  Spring Boot releases will keep improving.

**Trade-off:** ECS JSON is verbose: a single log line is roughly
180–240 bytes vs. ~120 bytes for the Logstash flat format.
For local dev stdout this is invisible; for slice-4 Loki
ingestion the difference is real but small and is the cost of
following an industry-standard schema.

### Decision 2: ECS, not the Logstash flat format

**Choice:** `logging.structured.format.console: ecs`, emitting
ECS (Elastic Common Schema) field names — `@timestamp`,
`log.level`, `service.name`, `service.environment`,
`process.thread.name`, `log.logger`, `message`, `ecs.version`,
plus the request-correlation fields (`request.id`, `user.id`,
`trace.id`, `span.id`) and the access-log fields
(`http.request.method`, `url.path`, `http.response.status_code`,
`event.duration`, `event.dataset`).

**Why:** ECS is the de-facto industry naming standard. Grafana
Loki, Elasticsearch, OpenSearch, Datadog, and Honeycomb all
ingest ECS-shaped JSON without remapping. The field names are
documented (`https://www.elastic.co/guide/en/ecs/current/`),
stable across versions, and shared with the OTel semantic-
conventions vocabulary (which Tempo and the slice-3 agent emit
into). Choosing ECS at the source means slice 3 (traces) and
slice 4 (Loki) don't have to do field-renaming gymnastics.

The Logstash flat format (`@timestamp`, `level`, `message`,
`loggerName`) is a shorter wire format but pushes the naming
decision into downstream layers. For a learning project intent
on landing the full triangle, ECS removes a class of decisions.

**Trade-off:** ECS uses dotted field names
(`http.request.method`). Some downstream parsers (older log
shippers) prefer underscore-separated names. None of the slice-3
or slice-4 components we are heading towards have this
limitation.

### Decision 3: Three filters, ordered at registration

**Choice:** Three servlet filters extending `OncePerRequestFilter`,
registered as `FilterRegistrationBean`s in
`ObservabilityWebConfig` with explicit `setOrder(...)` values.
Do not use `@Order` annotations on the filter classes.

```
order  filter                       MDC fields populated on entry
─────  ───────────────────────────  ─────────────────────────────
-200   RequestIdFilter              request.id
-150   RequestLoggingFilter         (timer start; reads MDC + attr at exit)
-100   springSecurityFilterChain    [Spring Security default]
   0   UserContextLogFilter         user.id (post-auth)
```

**Implementation note (deviates from this slice's first draft, which
placed RequestLoggingFilter at `+100`):** Spring Security's
`ExceptionTranslationFilter` catches an `AuthenticationException` /
`AccessDeniedException` raised by `AuthorizationFilter`, invokes the
configured `AuthenticationEntryPoint` (writing the 401 ProblemDetail in
this project) and returns *without re-invoking the outer servlet
chain*. A filter at order `+100` therefore never runs for an
unauthenticated request to a protected route, and the
"401 emits a `backend.access` line" requirement is unsatisfiable from
that position. Placing `RequestLoggingFilter` at `-150` wraps both the
happy and security-denied paths in a single timer, and the access-log
emission is guaranteed regardless of what the security chain decides.

**Why three, not one:** the three pieces of state have different
"earliest available" points:

- `request.id` must be set *before* Spring Security so that any
  log lines the security filters emit (failed auth, JWT-parse
  errors) carry the correlation field.
- `user.id` can only be read *after* Spring Security has run
  authentication and populated the `SecurityContext`.
- The access-log line at request exit needs both, and the
  duration timer must wrap the entire chain to be meaningful.

Collapsing this into one filter would mean conditional branching
inside `doFilterInternal` on "have I run before or after auth",
which is what filter ordering already expresses. Splitting also
makes the slice-3 insertion point obvious: the OTel agent's MDC
propagation slots cleanly between `RequestIdFilter` and the
security chain without any of these three needing to change.

**Why `setOrder(...)` at registration, not `@Order`:** Spring's
auto-registration of `@Component`-annotated filters via
`OncePerRequestFilter` picks them up in declaration order, and
`@Order` is consulted only in some auto-configuration paths. The
explicit `FilterRegistrationBean.setOrder(...)` in
`ObservabilityWebConfig` is the unambiguous, documented surface
and reads cleanly side-by-side at the registration site. The
three filter classes themselves are then plain `@Component`-less
classes — they are constructed by `ObservabilityWebConfig`
explicitly.

### Decision 4: `UserContextLogFilter` runs inside the security chain via servlet ordering, not as a Spring Security filter

**Choice:** Register `UserContextLogFilter` at order `0` (servlet
filter), not as a filter added to `HttpSecurity` via
`addFilterAfter(...)` in `SecurityConfig`.

**Why:** Two paths are possible:

- **A. Servlet filter at order `0`.** Spring Security's
  `springSecurityFilterChain` is one servlet filter at order
  `-100`. A servlet filter at order `0` runs *inside* its
  `chain.doFilter` call, after auth has populated the
  `SecurityContext`. It is a pure observability concern; it does
  not touch `SecurityConfig`.
- **B. Spring Security filter via `addFilterAfter(bearerFilter)`
  in `SecurityConfig`.** This would also work but couples
  `observability/` to `useraccounts/SecurityConfig` and gives the
  filter access to the `AuthenticationManager` it does not need.

Choice **A** keeps each concern in its own package, makes the
filter ordering visible in one place
(`ObservabilityWebConfig`), and means `useraccounts/SecurityConfig`
gets zero new lines for this slice.

**Trade-off:** servlet-filter ordering numbers are global and
need to stay coherent across packages. `ObservabilityWebConfig`
documents the order constants used and the meaning of each.

### Decision 5: `RequestLoggingFilter` reads MDC at exit; `user.id` survives via a request attribute

**Choice:** `RequestLoggingFilter` reads `request.id` from MDC at
the moment it emits its access-log line. Because the filter runs
*outside* the Spring Security chain (Decision 3), it observes the
chain after `UserContextLogFilter` has already cleared its MDC
entry in `finally`; `UserContextLogFilter` therefore *also*
mirrors `user.id` into a request attribute
(`AccessLogMarkers.REQUEST_ATTR_USER_ID`) when it sets MDC.
`RequestLoggingFilter` reads that attribute and restores
`user.id` into MDC for the single access-log call, then removes
it again — preserving the original intent that the JSON envelope
lifts MDC entries automatically while accommodating the filter
order forced by Decision 3.

**Why:** MDC is the right surface for the JSON envelope (the
ECS encoder picks it up without per-filter marker plumbing), but
MDC is also the right surface for the *inner* request lifetime
because any controller-level log line should carry `user.id`.
Keeping `user.id` in MDC for the duration of the servlet request
*and* propagating it through the request attribute to the
outer-filter access log is the smallest change that satisfies
both. The request attribute is request-scoped and dies with the
request, so it does not leak across Tomcat thread reuse.

The footgun this guards against — Tomcat thread reuse leaking
MDC across requests — is mitigated by every filter that adds
keys clearing them in `finally`, AND verified by the
`StructuredLoggingIT` test that logs from a non-servlet thread
and asserts NO `request.id` / `user.id` field is present.

### Decision 6: Honour an inbound `X-Request-Id` header

**Choice:** `RequestIdFilter` reads `X-Request-Id` from the
inbound request first; only if absent or blank does it generate
a fresh `UUID.randomUUID().toString()`. The value (inbound or
generated) is then both put in MDC and echoed on the response
as `X-Request-Id`.

**Why:** every real deployment sits behind a load balancer or
ingress that injects a per-edge request id. Reading the header
makes the backend correlate with upstream traces immediately
without any further config. The shape of the value is *not*
validated beyond non-emptiness — accepting whatever the caller
sent is the convention for this header, and the field will be
overwritten on a misuse only by the next request.

**Trade-off:** a hostile client can supply an arbitrary
`request.id`, potentially clashing with a different request's
generated id. For local dev and this learning project this is
acceptable. A production deploy would gate on a length cap
(e.g. ≤ 64 chars, alphanumeric-plus-dash) at the ingress, or
strip the inbound header at the edge. This is recorded in the
non-goals.

### Decision 7: Skip `/actuator/health` and `/actuator/prometheus` from the access log

**Choice:** `RequestLoggingFilter` short-circuits (still runs
the chain, but does NOT emit the `backend.access` line) when
`request.getRequestURI()` equals `/actuator/health` or
`/actuator/prometheus`.

**Why:** Prometheus scrapes the metrics endpoint every 15
seconds. Liveness probes hit `/health` even more often in a
real deploy. Logging each of these scrapes adds zero diagnostic
value and balloons log volume by an order of magnitude. The
metric `http_server_requests_seconds_count{uri="/actuator/prometheus"}`
already records the call count and latency for the same path;
the access log is redundant.

**Trade-off:** if `/actuator/prometheus` ever starts returning
5xx, slice 1's dashboard panel surfaces the rate (the metric is
emitted), but no access-log line will show the *details*. This
is acceptable: the diagnostic for a broken metrics endpoint is
the application's own startup logs (which are not skipped) and
the dashboard's "5xx rate by URI" panel from slice 1.

### Decision 8: Use Spring's `service.environment` to label the runtime

**Choice:** Configure `service.environment: local` (or pulled
from `${spring.profiles.active}` if set) via
`logging.structured.json.add` so every log line carries the
deployment-target field.

**Why:** the ECS `service.environment` field is the canonical
slot for distinguishing `local` / `ci` / `staging` / `prod` in
the log query layer. Setting it now means slice 4 (Loki) and any
future remote deploy don't have to refactor every log call.

**Trade-off:** we have no non-`local` deploy target yet. The
field is structurally useful but currently always emits the
same value. That is exactly the right time to add it.

### Decision 9: ECS-canonical `event.duration` (ns) + non-canonical `duration_ms` for humans

**Choice:** The access-log line emits BOTH:

- `event.duration` — request duration in nanoseconds, ECS-canonical.
- `duration_ms` — same value divided by 1e6, non-canonical.

**Why:** ECS strictly defines `event.duration` in nanoseconds.
Dashboards and humans almost always want milliseconds.
Emitting both lets:

- machines (Loki, future log analytics) work off the ECS-typed
  field with no surprises,
- humans grepping logs read a sensible number without dividing.

The cost is a few extra bytes per access-log line, on one log
line per request. Worth it.

### Decision 10: Do not assert log JSON shape in CI gates

**Choice:** `StructuredLoggingIT` runs in the existing IT
gradle suite. CI does not introduce a separate "log shape"
gate. Logs are not piped from CI to anywhere; the test asserts
in-JVM by redirecting `System.out`.

**Why:** the slice's correctness is already proven by the
integration test. A grep-based CI assertion on `gradle test`
output would be brittle (test output interleaves with build
output, formatters change between Gradle versions) without
adding signal beyond what the IT provides.

### Decision 11: No `LogbackContextSelectorListener`, no `TaskDecorator` for `@Async`

**Choice:** Do not configure any `TaskDecorator` for MDC
propagation across async boundaries. Do not add any Logback
context selector.

**Why:** the backend currently has no `@Async` method, no
`CompletableFuture` boundary, no scheduler. The fanout service
is synchronous (verified in slice 1). The first async hop will
land with the async-fanout-worker change; that change owns the
`MdcTaskDecorator` plumbing because *it* is the thing
introducing the thread hop. Adding a `TaskDecorator` here would
be code for a problem that doesn't exist yet.

## Open Questions

- Do we want `event.dataset=backend.access` or
  `event.dataset=backend.http` for the access-log line? The
  former matches the conventional Filebeat / Elastic naming;
  the latter reads more clearly inline with `http.request.*` /
  `http.response.*` field families. Defaulting to
  `backend.access` per ECS examples. Cheap to revisit before
  archive.

## Risks

- **Tomcat thread reuse leaking MDC.** Mitigation: every filter
  clears its MDC keys in `finally`; the IT proves a non-request
  thread carries no `request.id`. **Severity:** high if it
  happens, low likelihood given the test.
- **Spring Boot's `EcsStructuredLogFormatter` field choices
  change between versions.** Mitigation: the IT asserts the
  exact set of top-level keys we depend on, so a Spring Boot
  bump that drops or renames one of them fails CI. **Severity:**
  medium; would only bite on an unrelated dep bump.
- **A future logback config landing in slice 3 (e.g. for the OTel
  agent's appender) overriding the structured-format YAML.**
  Mitigation: the `logging.structured.format.console` property
  is high-precedence and a `logback-spring.xml` would only
  override it for non-console appenders; document in slice 3's
  design.

## Alternatives Considered

- **`logstash-logback-encoder` + `logback-spring.xml`** — see
  Decision 1. Rejected for the dep and the divergence from
  Spring's native path.
- **Hand-rolled JSON via a custom `ConversionRule`** — rejected,
  Spring Boot already does this exact thing.
- **Putting MDC propagation inside `BearerTokenAuthenticationFilter`** — see
  Decision 4. Rejected; couples observability to auth.
- **Emitting the access log via Tomcat's `AccessLogValve`** —
  rejected; valve writes a separate file in a non-JSON shape
  and runs outside the Logback pipeline, so MDC is unavailable.
- **`OncePerRequestFilter` doing all three concerns** — see
  Decision 3. Rejected; ordering already expresses the
  dependencies.
