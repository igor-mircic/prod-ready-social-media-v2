# observability Specification

## Purpose
TBD - created by archiving change add-backend-metrics. Update Purpose after archive.
## Requirements
### Requirement: Backend exposes a Prometheus-format metrics scrape endpoint

The `backend/` project SHALL include `io.micrometer:micrometer-registry-prometheus` as a runtime dependency and SHALL expose `GET /actuator/prometheus` returning the current Micrometer meter values in Prometheus text-exposition format. The endpoint SHALL be reachable without an `Authorization` header (it is added to the deny-by-default `SecurityFilterChain` allowlist). The endpoint SHALL be the SOLE metrics surface; no other URL on the backend SHALL emit Prometheus-format metrics.

#### Scenario: Scrape endpoint returns 200 unauthenticated

- **WHEN** a client calls `GET /actuator/prometheus` with no `Authorization` header
- **THEN** the response status is 200
- **AND** the `Content-Type` header starts with `text/plain` (Prometheus text-exposition format).

#### Scenario: Scrape endpoint exposes standard auto-instrumented metric families

- **WHEN** a reader inspects the response body of `GET /actuator/prometheus`
- **THEN** the body contains a line whose metric name is `http_server_requests_seconds_count`
- **AND** the body contains a line whose metric name is `hikaricp_connections_active`
- **AND** the body contains a line whose metric name is `jvm_memory_used_bytes`.

#### Scenario: Other Actuator endpoints remain authenticated

- **WHEN** a client calls `GET /actuator/env` with no `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.

### Requirement: Common Micrometer tags identify the application and service

The backend SHALL configure Micrometer common tags via
`management.metrics.tags` in `backend/src/main/resources/application.yaml` such that every emitted metric carries:

- `application = prod-ready-social-media-backend`,
- `service = backend`.

#### Scenario: Common tags appear on emitted metrics

- **WHEN** a reader inspects the body of `GET /actuator/prometheus`
- **THEN** at least one emitted metric line carries the label `application="prod-ready-social-media-backend"`
- **AND** at least one emitted metric line carries the label `service="backend"`.

### Requirement: `TimedAspect` is registered so `@Timed` annotations take effect

The backend SHALL declare a `@Configuration` class `backend/src/main/java/com/prodready/social/observability/MetricsConfig.java` that registers a `TimedAspect` bean wired to the application's `MeterRegistry`. Without this bean, every `@Timed` annotation on a Spring bean is silently a no-op and would emit no metrics.

#### Scenario: `@Timed` annotations emit metrics at runtime

- **GIVEN** a Spring bean method carries the `@Timed("some.timer.name")` annotation
- **WHEN** the method is invoked one or more times in the running application
- **THEN** the body of `GET /actuator/prometheus` contains a metric line whose name is `some_timer_name_seconds_count` with a value greater than or equal to the number of invocations.

### Requirement: Four hand-instrumented business timers cover the hot paths

The backend SHALL carry `@Timed` annotations on four business methods so that their per-invocation latency is observable as Prometheus histograms:

- `FeedFanoutService` (class-level) — timer name `feed.fanout.duration`,
- `FeedService.findPage` — timer name `feed.read.duration`,
- `PostService.create` — timer name `posts.create.duration`,
- `FollowService.follow` — timer name `follows.follow.duration`.

The timers SHALL be tagged ONLY with the implicit Micrometer tags (`class`, `method`, `exception`) and the common application/service tags. The timers SHALL NOT carry per-request high-cardinality tags such as a user id, post id, or any value derived from request input.

#### Scenario: `feed.fanout.duration` is emitted on the post-create write path

- **GIVEN** an authenticated user posts via `POST /api/v1/posts`
- **WHEN** a reader scrapes `/actuator/prometheus` afterwards
- **THEN** the body contains a line for `feed_fanout_duration_seconds_count` with a value >= 1.

#### Scenario: `feed.read.duration` is emitted on the feed read path

- **GIVEN** an authenticated user calls `GET /api/v1/feed`
- **WHEN** a reader scrapes `/actuator/prometheus` afterwards
- **THEN** the body contains a line for `feed_read_duration_seconds_count` with a value >= 1.

#### Scenario: `posts.create.duration` is emitted on the post create path

- **GIVEN** an authenticated user posts via `POST /api/v1/posts`
- **WHEN** a reader scrapes `/actuator/prometheus` afterwards
- **THEN** the body contains a line for `posts_create_duration_seconds_count` with a value >= 1.

#### Scenario: `follows.follow.duration` is emitted on the follow path

- **GIVEN** an authenticated user calls `POST /api/v1/users/{userId}/follow`
- **WHEN** a reader scrapes `/actuator/prometheus` afterwards
- **THEN** the body contains a line for `follows_follow_duration_seconds_count` with a value >= 1.

#### Scenario: Custom timers do NOT carry high-cardinality tags

- **WHEN** a reader inspects the source of `FeedFanoutService`, `FeedService`, `PostService`, and `FollowService`
- **THEN** no `@Timed` annotation declares an `extraTags = {...}` block that references a user id, post id, follow target id, or any value derived from request input.

### Requirement: HTTP server metrics are auto-instrumented for every controller

The backend SHALL rely on Spring Boot's auto-instrumentation of the WebMvc layer to emit `http_server_requests_seconds_*` histograms for every controller invocation. The auto-instrumentation SHALL tag each line with `uri` (the route template, NOT the resolved path), `method`, `status`, and `outcome`. No explicit `@Timed` annotation is required on controller classes.

#### Scenario: Controller invocation increments the auto-instrumented counter

- **GIVEN** an authenticated client calls a controller endpoint with a known route template (e.g. `GET /api/v1/users/{userId}`)
- **WHEN** a reader scrapes `/actuator/prometheus` immediately before and after that one call
- **THEN** the value of `http_server_requests_seconds_count{uri="/api/v1/users/{userId}",method="GET",status="200",...}` increases by exactly 1.

#### Scenario: URI tag is the template, not the resolved path

- **WHEN** a reader inspects the emitted `http_server_requests_seconds_*` lines after a call to `/api/v1/users/{someUuid}`
- **THEN** the `uri` label is the literal string `/api/v1/users/{userId}`
- **AND** the `uri` label is NOT the resolved UUID (which would be a high-cardinality footgun).

### Requirement: Prometheus scrape configuration lives in `infra/observability/prometheus/`

The repository SHALL include `infra/observability/prometheus/prometheus.yml` declaring exactly one scrape job named `backend` targeting `host.docker.internal:8080` at metrics path `/actuator/prometheus` with a 15-second scrape interval. The file SHALL include a comment documenting the Linux-host workaround (`extra_hosts: ["host.docker.internal:host-gateway"]` on the prometheus compose service, or `network_mode: host`).

#### Scenario: Prometheus config declares the backend scrape job

- **WHEN** a reader inspects `infra/observability/prometheus/prometheus.yml`
- **THEN** the file contains exactly one entry under `scrape_configs:`
- **AND** the entry's `job_name` is `backend`
- **AND** the entry's `metrics_path` is `/actuator/prometheus`
- **AND** the entry's `scrape_interval` is `15s`
- **AND** the entry's target is `host.docker.internal:8080`.

### Requirement: Grafana provisioning lives in `infra/observability/grafana/`

The repository SHALL include Grafana provisioning files such that a freshly-started Grafana container loads its Prometheus datasource and its dashboards without any UI clickops.

- `infra/observability/grafana/provisioning/datasources/prometheus.yaml` SHALL declare one datasource named `Prometheus` of type `prometheus`, URL `http://prometheus:9090`, `isDefault: true`, `editable: false`.
- `infra/observability/grafana/provisioning/dashboards/dashboards.yaml` SHALL declare one provider named `default` of type `file`, path `/etc/grafana/dashboards`, `allowUiUpdates: false`.

#### Scenario: Provisioning files declare the datasource and dashboard provider

- **WHEN** a reader inspects `infra/observability/grafana/provisioning/`
- **THEN** `datasources/prometheus.yaml` declares one Prometheus datasource set as default and as non-editable
- **AND** `dashboards/dashboards.yaml` declares one file-based dashboard provider pointing at `/etc/grafana/dashboards`.

### Requirement: One provisioned dashboard renders RED, DB, JVM, and business panels

The repository SHALL include `infra/observability/grafana/dashboards/backend-overview.json` — a single provisioned Grafana dashboard titled `Backend overview` carrying panels for:

- HTTP request rate by `uri`,
- HTTP 4xx rate by `uri`,
- HTTP 5xx rate by `uri`,
- HTTP p50 / p95 / p99 duration by `uri`,
- HikariCP active / idle / pending connections,
- JVM heap used (by pool),
- JVM GC pause time rate,
- p95 latency of each of the four custom business timers (`feed.fanout.duration`, `feed.read.duration`, `posts.create.duration`, `follows.follow.duration`).

Every PromQL `by (...)` clause in the dashboard SHALL group only by bounded label sets (`uri`, `method`, `status`, `area`, `id`, `le`). No panel SHALL group by `userId`, `post_id`, `email`, or any other high-cardinality label.

#### Scenario: Dashboard JSON contains the listed panel titles

- **WHEN** a reader greps `infra/observability/grafana/dashboards/backend-overview.json` for panel titles
- **THEN** every panel listed above is present as a `"title"` field in the JSON.

#### Scenario: No PromQL query groups by a high-cardinality label

- **WHEN** a reader inspects every `"expr"` field in `backend-overview.json`
- **THEN** no `by (...)` clause references `userId`, `post_id`, `email`, or any equivalent unbounded id label.

### Requirement: Observability stack starts under the `observability` docker-compose profile

The repository's `docker-compose.yml` SHALL declare two services under `profiles: ["observability"]`: `prometheus` (image `prom/prometheus:v2.55.1`, port `9090:9090`) and `grafana` (image `grafana/grafana:11.2.0`, port `3000:3000`, `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`, `depends_on: [prometheus]`). The default `docker-compose up` invocation SHALL continue to start only `postgres`.

#### Scenario: Default invocation starts only postgres

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Observability profile starts the additional services

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, and `grafana` services all start
- **AND** Grafana on `http://localhost:3000` lands on an anonymous Viewer session without a login prompt.

### Requirement: README documents the local observability run loop

The repository's `README.md` SHALL include a `## Local observability` section after the existing `## Posting locally` section. The section SHALL document the `docker-compose --profile observability up -d prometheus grafana` invocation, the Grafana URL (`http://localhost:3000`) with the landing dashboard name (`Backend overview`), and the Prometheus URL (`http://localhost:9090`). The section SHALL state that anonymous viewer access is for local dev only.

#### Scenario: README documents the run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `## Local observability` section
- **AND** the section names the `docker-compose --profile observability up` invocation
- **AND** the section names the Grafana URL and the landing dashboard
- **AND** the section names the Prometheus URL.

### Requirement: Integration test proves the metrics surface end-to-end

The `backend/` project SHALL include a Testcontainers integration test `backend/src/test/java/com/prodready/social/observability/MetricsActuatorIT.java` that boots the full Spring context against a Testcontainers Postgres and asserts:

- `GET /actuator/prometheus` returns 200 without an `Authorization` header,
- the response body contains the expected metric family names listed in the requirements above,
- the response body carries the `application` and `service` common tags,
- `GET /actuator/env` returns 401 (proves the allowlist is narrow),
- after driving one authenticated HTTP call, the corresponding `http_server_requests_seconds_count` line increases by exactly 1,
- after driving a `POST /api/v1/posts` call, `feed_fanout_duration_seconds_count` is at least 1 (proves `TimedAspect` is correctly wired).

#### Scenario: Integration test covers each listed assertion

- **WHEN** a reader inspects `MetricsActuatorIT.java`
- **THEN** every assertion bullet listed above corresponds to at least one `@Test` method.

### Requirement: Backend emits one ECS-format JSON object per log event on stdout

The `backend/` project SHALL configure
`logging.structured.format.console: ecs` in
`backend/src/main/resources/application.yaml` so that Spring Boot's
native `EcsStructuredLogFormatter` renders every log event as a
single line of Elastic Common Schema JSON on stdout. The project
SHALL NOT introduce a `logback-spring.xml`, a `logback.xml`, or
the `logstash-logback-encoder` dependency. Every emitted JSON
object SHALL carry at minimum the keys `@timestamp`, `log.level`,
`service.name`, `service.environment`, `process.thread.name`,
`log.logger`, `message`, and `ecs.version`. `service.name` SHALL
be `backend` (derived from `spring.application.name`).
`service.environment` SHALL be `local` (set via
`logging.structured.json.add.service.environment`).

#### Scenario: Every line on stdout parses as one JSON object

- **WHEN** the backend writes a log event
- **THEN** the corresponding stdout line is a single, complete,
  valid JSON object terminated by a newline.

#### Scenario: Base ECS fields are present on every line

- **WHEN** a reader parses any log line emitted by the backend
- **THEN** the parsed object contains string-valued keys
  `@timestamp`, `log.level`, `service.name`,
  `service.environment`, `process.thread.name`, `log.logger`,
  `message`, and `ecs.version`
- **AND** `service.name` equals the string `"backend"`
- **AND** `service.environment` equals the string `"local"`.

#### Scenario: No `logback-spring.xml` is introduced

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml`
  nor `logback.xml`
- **AND** `backend/build.gradle.kts` does NOT declare a
  dependency on `net.logstash.logback:logstash-logback-encoder`.

### Requirement: Each HTTP request carries a generated `request.id` correlation field in MDC

The backend SHALL register a servlet filter
`backend/src/main/java/com/prodready/social/observability/RequestIdFilter.java`
(servlet filter ordering value `-200`, i.e. before Spring
Security's default `-100`). For every incoming HTTP request the
filter SHALL determine a `request.id` value (using the inbound
`X-Request-Id` header verbatim if present and non-blank, otherwise
generating a fresh `UUID.randomUUID().toString()`), SHALL put that
value in Logback MDC under the key `request.id` before the chain
runs, SHALL set the `X-Request-Id` response header to the same
value, and SHALL clear the MDC entry in a `finally` block so the
Tomcat worker thread does not leak the value to the next request.

#### Scenario: Generated `request.id` appears in MDC and in the response header

- **GIVEN** a client makes an HTTP request to any backend
  endpoint without an `X-Request-Id` header
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** at least one line carries a string-valued `request.id`
  field
- **AND** the same value appears as the `X-Request-Id` response
  header.

#### Scenario: Inbound `X-Request-Id` header is honoured

- **GIVEN** a client makes an HTTP request to any backend
  endpoint with `X-Request-Id: client-supplied-abc`
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** the corresponding `request.id` JSON field equals
  `"client-supplied-abc"`
- **AND** the `X-Request-Id` response header equals
  `"client-supplied-abc"`.

#### Scenario: MDC is cleared between requests

- **GIVEN** an HTTP request has completed
- **WHEN** the same JVM emits a log event from a thread that is
  NOT inside a servlet request
- **THEN** the resulting JSON line carries no `request.id` field
- **AND** the resulting JSON line carries no `user.id` field.

### Requirement: Authenticated requests carry a `user.id` correlation field in MDC

The backend SHALL register a servlet filter
`backend/src/main/java/com/prodready/social/observability/UserContextLogFilter.java`
(servlet filter ordering value `0`, i.e. after Spring Security's
default `-100` so it runs inside the security chain with a
populated `SecurityContext`). When the current
`SecurityContextHolder.getContext().getAuthentication()` is
authenticated and its principal is an instance of `UserPrincipal`,
the filter SHALL put `((UserPrincipal) principal).getId().toString()`
in MDC under the key `user.id`. The filter SHALL clear that MDC
entry in a `finally` block. When no authentication is present or
the principal is not a `UserPrincipal`, the filter SHALL NOT put
any placeholder value in MDC (the JSON line SHALL simply omit the
`user.id` field).

#### Scenario: Authenticated request carries `user.id` matching the signed-in user

- **GIVEN** a client calls an authenticated endpoint with a valid
  bearer token for user U
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** the lines carry a `user.id` field equal to U's id as a
  string.

#### Scenario: Anonymous request to a protected route emits no `user.id` field

- **GIVEN** a client calls an authenticated endpoint with no
  `Authorization` header
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** none of the lines carries a `user.id` field
- **AND** the access log line for the request (see next
  requirement) carries `http.response.status_code == 401`.

### Requirement: One ECS `backend.access` log line is emitted per HTTP request

The backend SHALL register a servlet filter
`backend/src/main/java/com/prodready/social/observability/RequestLoggingFilter.java`
at servlet filter ordering value `-150`, i.e. between `RequestIdFilter`
(`-200`) and Spring Security's default order (`-100`) so that the
access-log line is emitted for both happy-path and security-rejected
requests (Spring Security's `ExceptionTranslationFilter` consumes the
401/403 exception and never re-invokes the outer servlet chain — a filter
placed *after* the security chain would never run for a 401, and the
"401 access log line" scenario below would be unsatisfiable). For every
HTTP request
the filter SHALL emit exactly one log event at level INFO via the
logger named `backend.access` carrying the following structured
fields:

- `event.dataset` = `backend.access`,
- `http.request.method` = the request method,
- `url.path` = the matched route template (read from
  `HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE` on the request),
  falling back to `request.getRequestURI()` if the attribute is
  not set,
- `http.response.status_code` = the resolved response status,
- `event.duration` = nanoseconds elapsed across `chain.doFilter`,
- `duration_ms` = `event.duration / 1_000_000`.

The filter SHALL NOT emit an access-log line for requests to
`/actuator/health` or `/actuator/prometheus` (the chain still
runs; only the log emission is suppressed). The filter SHALL emit
the access-log line in a `finally` block so that requests that
throw still produce a line.

#### Scenario: A normal authenticated request emits one access log line

- **GIVEN** a client calls `GET /api/v1/auth/me` with a valid
  bearer token for user U
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** exactly one line has `event.dataset == "backend.access"`
- **AND** that line has `http.request.method == "GET"`
- **AND** `url.path == "/api/v1/auth/me"`
- **AND** `http.response.status_code == 200`
- **AND** `event.duration` is a positive integer (nanoseconds)
- **AND** `duration_ms` is a non-negative integer equal to
  `event.duration / 1_000_000`
- **AND** `user.id` equals U's id as a string
- **AND** `request.id` is a non-blank string.

#### Scenario: `url.path` is the route template, not the resolved path

- **GIVEN** a client calls a route whose mapping template is
  `/api/v1/users/{userId}` with some concrete UUID
- **WHEN** a reader inspects the corresponding `backend.access`
  JSON line
- **THEN** `url.path` equals the literal string
  `"/api/v1/users/{userId}"`
- **AND** `url.path` does NOT equal the resolved UUID path.

#### Scenario: `/actuator/prometheus` is not access-logged

- **GIVEN** Prometheus scrapes `GET /actuator/prometheus`
- **WHEN** a reader inspects the JSON log lines emitted during
  that request
- **THEN** none of the lines has `event.dataset ==
  "backend.access"`
- **AND** the scrape response itself was HTTP 200 (the
  suppression is on log emission, not on the response).

#### Scenario: An anonymous request to a protected route emits a 401 access log line

- **GIVEN** a client calls `GET /api/v1/auth/me` with no
  `Authorization` header
- **WHEN** a reader inspects the corresponding `backend.access`
  JSON line
- **THEN** `http.response.status_code == 401`
- **AND** the line carries a `request.id` field
- **AND** the line carries NO `user.id` field.

### Requirement: Observability filters are registered with explicit servlet ordering, decoupled from `SecurityConfig`

The backend SHALL declare a `@Configuration` class
`backend/src/main/java/com/prodready/social/observability/ObservabilityWebConfig.java`
that registers the three observability filters (`RequestIdFilter`,
`RequestLoggingFilter`, `UserContextLogFilter`) as
`FilterRegistrationBean`s with explicit `setOrder(...)` values of
`-200`, `-150`, and `0` respectively. The class SHALL NOT modify
`backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`
or any other `user-accounts` source file. The deny-by-default
`SecurityFilterChain` allowlist enumerated in `user-accounts`
SHALL be unchanged by this slice.

#### Scenario: The three filters are registered with the documented orders

- **WHEN** a reader inspects `ObservabilityWebConfig.java`
- **THEN** the file declares three `@Bean` methods returning
  `FilterRegistrationBean<...>`
- **AND** the registration for `RequestIdFilter` calls
  `setOrder(-200)`
- **AND** the registration for `RequestLoggingFilter` calls
  `setOrder(-150)`
- **AND** the registration for `UserContextLogFilter` calls
  `setOrder(0)`.

#### Scenario: `SecurityConfig` is not modified by this slice

- **WHEN** a reader compares
  `backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`
  before and after the change
- **THEN** the literal contents of `PERMIT_ALL_POSTS` and
  `PERMIT_ALL_GETS` are unchanged
- **AND** no `addFilterBefore` / `addFilterAfter` call is added
  for any filter under the `observability/` package.

### Requirement: The application READMEs document the structured-log run loop

The repository's `README.md` SHALL include a `### Structured logs`
subsection under the existing `## Local observability` section.
The subsection SHALL document:

- that the backend emits one ECS JSON object per log event on
  stdout,
- an example access log line showing the `event.dataset`,
  `http.request.method`, `url.path`, `http.response.status_code`,
  `event.duration`, `duration_ms`, `request.id`, and `user.id`
  fields,
- the `X-Request-Id` response header round-trip,
- a grep-by-request-id pattern using `jq`,
- a forward-pointer that `trace.id` / `span.id` slots are reserved
  by the ECS formatter and will start populating when the next
  observability slice (distributed tracing) lands.

#### Scenario: README documents the structured-log run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Structured logs` subsection
- **AND** the subsection shows an example ECS JSON access log
  line
- **AND** the subsection documents the `X-Request-Id` round-trip
- **AND** the subsection documents the `jq`-based grep-by-
  `request.id` pattern
- **AND** the subsection forward-references the future tracing
  slice for `trace.id` / `span.id`.

### Requirement: Integration test proves the structured-log surface end-to-end

The `backend/` project SHALL include a Testcontainers integration
test
`backend/src/test/java/com/prodready/social/observability/StructuredLoggingIT.java`
that boots the full Spring context against a Testcontainers
Postgres and asserts:

- every captured stdout line parses as one JSON object carrying
  the base ECS fields,
- an authenticated request emits one `event.dataset=backend.access`
  JSON line with the documented field set,
- the `url.path` field carries the matched route template, not
  the resolved path,
- an anonymous request to a protected route emits a
  `backend.access` line with `http.response.status_code=401` and
  no `user.id` field,
- `GET /actuator/prometheus` does NOT emit a `backend.access`
  line,
- the `X-Request-Id` response header matches the `request.id`
  JSON field,
- a client-supplied inbound `X-Request-Id` header is honoured
  (the same value appears in the response header and in the
  access log line),
- a log call from outside the servlet request lifecycle emits a
  JSON line carrying no `request.id` and no `user.id` field
  (proves MDC clearing).

#### Scenario: Integration test covers each listed assertion

- **WHEN** a reader inspects `StructuredLoggingIT.java`
- **THEN** every assertion bullet listed above corresponds to at
  least one `@Test` method.

### Requirement: OpenTelemetry Java agent attaches to every backend JVM at a pinned version

The `backend/` project SHALL pin the OpenTelemetry Java agent JAR coordinate `io.opentelemetry.javaagent:opentelemetry-javaagent` in `backend/gradle/libs.versions.toml` and SHALL declare a dedicated Gradle `agent` configuration in `backend/build.gradle.kts` that resolves the JAR. The configuration SHALL be isolated from `compileClasspath`, `runtimeClasspath`, and `testRuntimeClasspath` so the agent is never on the application classpath. A Gradle task SHALL copy the resolved JAR to `backend/build/otel/opentelemetry-javaagent.jar` so a stable, version-controlled path exists for the `-javaagent:` JVM flag.

The `bootRun`, `bootJar`, and `test` tasks SHALL each launch the JVM with `-javaagent:<path-to-opentelemetry-javaagent.jar>` so all three entry points (developer dev loop, e2e harness JAR launcher, integration-test JVM) attach the same byte-identical agent. Application source SHALL NOT import any class from the `io.opentelemetry.*`, `io.opentelemetry.api.*`, or `io.opentelemetry.instrumentation.*` package families.

#### Scenario: Agent JAR coordinate is pinned

- **WHEN** a reader inspects `backend/gradle/libs.versions.toml`
- **THEN** the file declares a coordinate for `io.opentelemetry.javaagent:opentelemetry-javaagent` with an explicit, non-`+`, non-`latest.release` version string.

#### Scenario: Agent configuration is isolated from runtime classpath

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the file declares a Gradle `Configuration` named `agent` (or equivalent) holding the agent JAR
- **AND** that configuration is NOT extended from, included by, or otherwise merged into `compileClasspath`, `runtimeClasspath`, or `testRuntimeClasspath`.

#### Scenario: All three JVM entry points attach the agent

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the `bootRun` task carries a JVM argument of the form `-javaagent:<path>/opentelemetry-javaagent.jar`
- **AND** the `bootJar` build path produces a launcher (or documents a launcher invocation in `e2e/`) that attaches the agent
- **AND** the `test` task carries the same `-javaagent:` argument.

#### Scenario: Application source has no compile-time dependency on the OTel SDK

- **WHEN** a reader greps `backend/src/main/java/` for `import io.opentelemetry`
- **THEN** the search returns zero matches.

### Requirement: Agent ships spans only; metrics and logs OTLP exporters are explicitly disabled

The backend's OTel agent SHALL be configured via environment variables (defaulted in `backend/build.gradle.kts` for `bootRun` and `test`, overridable at runtime) such that:

- `OTEL_SERVICE_NAME` is `backend` (matches the slice-1 Micrometer common tag),
- `OTEL_RESOURCE_ATTRIBUTES` includes `service.environment=local` and `deployment.environment=local` (matches the slice-2 `service.environment` log field),
- `OTEL_TRACES_EXPORTER` is `otlp`,
- `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf`,
- `OTEL_EXPORTER_OTLP_ENDPOINT` is `http://localhost:4318`,
- `OTEL_METRICS_EXPORTER` is `none` (slice 1 owns metrics via Prometheus pull; the agent SHALL NOT push duplicate metrics over OTLP),
- `OTEL_LOGS_EXPORTER` is `none` (slice 2 owns log emission on stdout; the agent SHALL NOT parallel-emit logs over OTLP).

The "defaulted ... overridable at runtime" wording above SHALL be verifiable: when a parent process exports an `OTEL_*` variable that the build also names in its defaults, the parent value SHALL win on the forked JVM. The build script SHALL implement this by skipping its `JavaForkOptions.environment(k, v)` call for any key already present in the parent env (`System.getenv(k) != null`).

#### Scenario: Build wires the documented OTEL_* defaults

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the `bootRun` and `test` task configurations declare environment-variable defaults for each of `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER`
- **AND** the values match those listed above.

#### Scenario: Parent-env OTEL_* values override the build's defaults

- **GIVEN** the parent shell (e.g., the GitHub Actions runner) exports `OTEL_TRACES_EXPORTER=none`
- **WHEN** Gradle launches `bootRun` or `test`, or a build task that forks a JVM in the same shape (e.g., `generateOpenApiDocs`)
- **THEN** the forked JVM's `OTEL_TRACES_EXPORTER` is `none` (the parent value)
- **AND** the build's `otlp` default is NOT silently re-applied on top.

#### Scenario: No OTLP metrics duplicate the Prometheus surface

- **GIVEN** the backend is running with the agent attached
- **WHEN** a reader inspects emitted metrics surfaces
- **THEN** the only metrics surface remains `GET /actuator/prometheus`
- **AND** no metric values are pushed to `http://localhost:4318/v1/metrics`.

#### Scenario: No OTLP logs duplicate the stdout surface

- **GIVEN** the backend is running with the agent attached
- **WHEN** a reader inspects emitted log surfaces
- **THEN** every log event continues to render exactly once on stdout in ECS JSON format
- **AND** no log payload is pushed to `http://localhost:4318/v1/logs`.

### Requirement: Per-request log lines carry ECS-canonical `trace.id` and `span.id` fields

The backend SHALL declare a class implementing `org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer<?>` at `backend/src/main/java/com/prodready/social/observability/EcsTraceFieldsCustomizer.java`, registered via `backend/src/main/resources/META-INF/spring.factories` under the key `org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer`. (Spring Boot 4 initializes the structured-log formatter via `SpringFactoriesLoader` during Logback init, before the Spring application context exists — so `@Component`/`@Configuration` registration is too late and is forbidden here.) The customizer SHALL be annotated `@Order(Ordered.LOWEST_PRECEDENCE)` so it executes after any other JSON-members customizer, and SHALL:

- read the `trace_id`, `span_id`, and `trace_flags` keys from the current `LoggingEvent`'s MDC view (which the OTel agent's `instrumentation-logback-mdc` module populates at log-emit time);
- when `trace_id` is non-blank, emit a JSON member `trace.id` (nested ECS form) carrying that value, and remove the Logstash-style `trace_id` key from the JSON output;
- when `span_id` is non-blank, emit a JSON member `span.id` carrying that value, and remove the `span_id` key from the JSON output;
- when `trace_flags` is non-blank, emit a JSON member `trace.flags` carrying that value, and remove the `trace_flags` key from the JSON output;
- when any of those MDC keys is absent or blank, omit the corresponding ECS field entirely (the JSON line carries no empty placeholder).

The customizer SHALL NOT introduce a `logback-spring.xml` or a `logback.xml` and SHALL NOT add a Logback converter pattern (the existing slice-2 prohibition on `logback-spring.xml` is preserved).

#### Scenario: Authenticated request emits one access log line carrying populated `trace.id` and `span.id`

- **GIVEN** the backend is running with the OTel agent attached
- **AND** a client calls `GET /api/v1/auth/me` with a valid bearer token for user U
- **WHEN** a reader inspects the JSON log line carrying `event.dataset == "backend.access"` for that request
- **THEN** the line carries a string-valued `trace.id` field that is exactly 32 lowercase hexadecimal characters
- **AND** the line carries a string-valued `span.id` field that is exactly 16 lowercase hexadecimal characters
- **AND** the line does NOT carry a top-level `trace_id` or `span_id` key.

#### Scenario: Log event outside any span carries no `trace.id` or `span.id`

- **GIVEN** the backend is running with the OTel agent attached
- **WHEN** a log event is emitted from a thread that is NOT inside an active OTel span (for example, an application-bootstrap log line)
- **THEN** the corresponding JSON line carries no `trace.id` field
- **AND** the corresponding JSON line carries no `span.id` field
- **AND** the corresponding JSON line carries no top-level `trace_id` or `span_id` key.

#### Scenario: No `logback-spring.xml` is introduced (preserved across slice 3)

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml` nor `logback.xml`
- **AND** `backend/build.gradle.kts` declares no dependency on `net.logstash.logback:logstash-logback-encoder`.

### Requirement: Tempo is provisioned under the `observability` docker-compose profile and as a Grafana datasource

The repository's `docker-compose.yml` SHALL declare one service
`tempo` under `profiles: ["observability"]` using the image
`grafana/tempo:2.6.1`, mounting
`./infra/observability/tempo/tempo.yaml` to `/etc/tempo.yaml`,
exposing host port `3200:3200` (HTTP API only — the OTLP receiver
host port bindings from slice 3 are retired by slice 4 in favour of
the Collector taking over `4317:4317` and `4318:4318`), and starting
with `-config.file=/etc/tempo.yaml`. Tempo's OTLP receivers continue
to listen inside the container on `4317` and `4318` and are
reachable from inside the docker network as `tempo:4317` and
`tempo:4318` (the Collector's `otlp/tempo` exporter targets
`tempo:4317`). The existing `grafana` service's `depends_on` list
SHALL include `tempo` (in addition to the slice-1 `prometheus` and
the slice-4 `loki` and `collector` dependencies). The default
`docker-compose up` invocation (with no profile flag) SHALL continue
to start only `postgres`.

The repository SHALL include `infra/observability/tempo/tempo.yaml`
declaring an OTLP receiver enabled on both gRPC (`0.0.0.0:4317`) and
HTTP (`0.0.0.0:4318`), local-filesystem WAL and blocks storage under
`/var/tempo`, the HTTP API on `0.0.0.0:3200`, and a 1-hour block
retention. The file SHALL carry an inline comment marking the
local-filesystem storage choice as a learning-project default and
forward-referencing object-storage backends for production.

The repository SHALL include
`infra/observability/grafana/provisioning/datasources/tempo.yaml`
declaring one datasource named `Tempo` of type `tempo` at URL
`http://tempo:3200`, with `editable: false` and `isDefault: false`
(the Prometheus datasource from slice 1 remains the default). The
file SHALL declare a `tracesToLogs` (or equivalent
`tracesToLogsV2` per Grafana version) correlation block targeting
the slice-4 `Loki` datasource by name, keyed on the `trace.id` span
tag so that opening a Tempo span in Grafana presents a one-click
pivot to the matching Loki log lines.

#### Scenario: Default invocation still starts only postgres (preserved across slice 4)

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Observability profile starts tempo alongside the other observability services

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, `tempo`,
  `collector`, and `loki` services all start
- **AND** Tempo's HTTP API on `http://localhost:3200/ready` returns
  a 200 once the container has finished initial startup
- **AND** no process on the host is listening on ports `4317` or
  `4318` other than the slice-4 Collector container's bindings.

#### Scenario: Tempo configuration declares OTLP receivers and local storage

- **WHEN** a reader inspects `infra/observability/tempo/tempo.yaml`
- **THEN** the file enables an OTLP receiver listening on
  `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP)
- **AND** the file declares local-filesystem WAL and blocks storage
  rooted at `/var/tempo`
- **AND** the file exposes Tempo's HTTP API on `0.0.0.0:3200`
- **AND** the file carries an inline comment marking
  local-filesystem storage as a learning-project default.

#### Scenario: Grafana datasource provisioning declares Tempo as non-default with traces-to-logs correlation

- **WHEN** a reader inspects
  `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one datasource named `Tempo` of type
  `tempo`
- **AND** the URL is `http://tempo:3200`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file declares a `tracesToLogs` (or `tracesToLogsV2`)
  correlation entry whose `datasourceUid` (or named target)
  references the slice-4 `Loki` datasource
- **AND** the file does NOT carry the slice-3 inline comment
  forward-referencing the slice-4 `tracesToLogs` block (the block
  is now present, not forward-referenced).

#### Scenario: Backend overview dashboard retains the Recent traces panel

- **WHEN** a reader inspects
  `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard still declares the slice-3 panel titled
  `Recent traces`
- **AND** the panel's datasource is `Tempo`
- **AND** the panel's query targets
  `{ resource.service.name = "backend" }` in TraceQL.

### Requirement: README documents the local distributed-tracing run loop

The repository's `README.md` SHALL include a `### Distributed tracing` subsection under the existing `## Local observability` section, after the existing `### Structured logs` subsection. The subsection SHALL document:

- that `docker-compose --profile observability up -d` now also brings up the `tempo` service,
- that the backend ships spans to `http://localhost:4318` over OTLP/HTTP via the OTel Java agent,
- an example JSON log line showing populated `trace.id` and `span.id` ECS fields,
- the workflow of copying a `trace.id` value out of a log line and pasting it into Tempo's Grafana search to land on the corresponding span tree,
- a forward-pointer that the auto "click `trace.id` in a log line → jump to Tempo" link will land in the next observability slice (log shipping with Loki) once the log datasource is provisioned.

#### Scenario: README documents the tracing run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Distributed tracing` subsection under `## Local observability`
- **AND** the subsection states that `docker-compose --profile observability up -d` brings up `tempo`
- **AND** the subsection shows an example JSON log line with populated `trace.id` and `span.id`
- **AND** the subsection documents the copy-`trace.id`-into-Grafana workflow
- **AND** the subsection forward-references the future slice for the trace-to-logs auto-link.

### Requirement: Integration test proves the agent → MDC → ECS pipeline end-to-end in-process

The `backend/` project SHALL include a Testcontainers integration test `backend/src/test/java/com/prodready/social/observability/TracingIT.java` that boots the full Spring context against a Testcontainers Postgres with the OTel Java agent attached (the `test` task carries the `-javaagent:` flag). The test SHALL assert:

- the agent's `OpenTelemetry` global is registered and is NOT the no-op fallback — verified by obtaining a `Tracer` from `GlobalOpenTelemetry.get()`, starting a span, and confirming its `SpanContext.isValid()` and that its trace id matches `^[0-9a-f]{32}$` and span id matches `^[0-9a-f]{16}$`;
- one authenticated `GET /api/v1/auth/me` request emits exactly one `event.dataset=backend.access` JSON log line whose `trace.id` field is a non-blank 32-character lowercase hex string and whose `span.id` field is a non-blank 16-character lowercase hex string, with no top-level `trace_id` / `span_id` / `trace_flags` key;
- a log event emitted from a thread *outside* any active span (a freshly-spawned `Thread`) carries no `trace.id`, no `span.id`, and no top-level `trace_id` / `span_id` key;
- one authenticated `POST /api/v1/posts` request emits an access-log line carrying populated `trace.id` and `span.id` ECS fields (proves the endpoint that invokes the slice-1 `@Timed PostService.create` method is traced end-to-end).

Capturing the agent-emitted span set by literal span name (e.g., asserting a span named `PostService.create` exists) is **explicitly deferred** in this slice: the production OTel Java agent installs `GlobalOpenTelemetry` at JVM start and its instrumentation modules cache `Tracer` references at module-load time, which makes the `opentelemetry-sdk-testing` `OpenTelemetryExtension` / `InMemorySpanExporter` swap pattern ineffective. A future change can revisit this once an agent extension JAR is wired (`OTEL_JAVAAGENT_EXTENSIONS=…`).

The test SHALL NOT boot a Tempo container, SHALL NOT make any network call to `http://localhost:4318` or `http://localhost:3200`, and SHALL NOT depend on any service outside the `Testcontainers` Postgres + the in-process Spring context.

#### Scenario: Tracing integration test covers each listed assertion

- **WHEN** a reader inspects `TracingIT.java`
- **THEN** every assertion bullet listed above corresponds to at least one `@Test` method
- **AND** the test class contains no reference to a Tempo container, no `Testcontainers` declaration of `grafana/tempo`, and no HTTP call to port `4318` or `3200`.

### Requirement: Backend writes ECS JSON log events to an env-var-gated file in addition to stdout

The `backend/` project SHALL extend
`backend/src/main/resources/application.yaml` so that, when the
environment variable `LOG_FILE_PATH` is set to a non-empty value, every
log event is appended as one ECS JSON line to the file at that path in
addition to the existing stdout emission. The file output SHALL use
`logging.structured.format.file: ecs` so the file lines are
byte-identical to the corresponding stdout lines. When `LOG_FILE_PATH`
is unset or empty, no file appender SHALL engage and the dev loop SHALL
be byte-identical to slice 2 / slice 3 behaviour. The file appender
SHALL NOT introduce a `logback-spring.xml`, a `logback.xml`, or any
dependency on `net.logstash.logback:logstash-logback-encoder` (the
existing slice-2 prohibitions are preserved).

#### Scenario: File appender does not engage by default

- **GIVEN** the backend is started with no `LOG_FILE_PATH` environment
  variable set
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** no file is created at any path the backend controls.

#### Scenario: File appender writes ECS JSON when `LOG_FILE_PATH` is set

- **GIVEN** the backend is started with
  `LOG_FILE_PATH=/some/writable/path/backend.json`
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** the same event appears as one ECS JSON line appended to
  `/some/writable/path/backend.json`
- **AND** the two lines are byte-identical.

#### Scenario: File lines carry the full ECS field set including correlation fields

- **GIVEN** the backend is started with a non-empty `LOG_FILE_PATH`
- **WHEN** an authenticated client calls `GET /api/v1/auth/me` with a
  valid bearer token for user U
- **THEN** the file contains one line with
  `event.dataset == "backend.access"`
- **AND** that line carries the base ECS fields (`@timestamp`,
  `log.level`, `service.name`, `service.environment`,
  `process.thread.name`, `log.logger`, `message`, `ecs.version`)
- **AND** that line carries a non-blank `request.id`
- **AND** that line carries a `user.id` equal to U's id as a string
- **AND** that line carries a 32-character lowercase hex `trace.id`
- **AND** that line carries a 16-character lowercase hex `span.id`.

#### Scenario: No `logback-spring.xml` is introduced (preserved across slice 4)

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml` nor
  `logback.xml`
- **AND** `backend/build.gradle.kts` declares no dependency on
  `net.logstash.logback:logstash-logback-encoder`.

### Requirement: OpenTelemetry Collector is provisioned under the `observability` docker-compose profile with two pipelines

The repository's `docker-compose.yml` SHALL declare one new service
`collector` under `profiles: ["observability"]` using the image
`otel/opentelemetry-collector-contrib:0.111.0`, mounting
`./infra/observability/collector/collector-config.yaml` to
`/etc/otelcol-contrib/config.yaml` and
`./infra/observability/logs:/var/log/backend:ro`, exposing host ports
`4317:4317` (OTLP gRPC) and `4318:4318` (OTLP HTTP), and starting with
`--config=/etc/otelcol-contrib/config.yaml`.

The repository SHALL include
`infra/observability/collector/collector-config.yaml` declaring:

- one OTLP receiver listening on `0.0.0.0:4317` (gRPC) and
  `0.0.0.0:4318` (HTTP);
- one `filelog` receiver tailing `/var/log/backend/*.json` and
  parsing each line as a JSON object (so the ECS fields land as
  attributes on the Loki log entry);
- one `otlp/tempo` exporter targeting `tempo:4317` with TLS
  disabled (in-network call);
- one `loki` exporter targeting `http://loki:3100/loki/api/v1/push`;
- one `batch` processor with default settings, shared by both
  pipelines;
- a `traces` pipeline wiring `otlp` receiver → `batch` processor →
  `otlp/tempo` exporter;
- a `logs` pipeline wiring `filelog` receiver → `batch` processor →
  `loki` exporter.

The Collector configuration SHALL set the Loki exporter's
`labels.attributes` so that each shipped log line carries
`service_name`, `event.dataset`, and `log.level` as Loki labels (the
remaining ECS fields are kept inside the JSON body and queried via
`| json` at read time, so the Loki label cardinality stays bounded).

#### Scenario: Observability profile starts collector alongside the existing services

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, `tempo`,
  `collector`, and `loki` services all start
- **AND** the Collector's OTLP HTTP endpoint at
  `http://localhost:4318/v1/traces` accepts a POST.

#### Scenario: Default invocation still starts only postgres (preserved across slice 4)

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Collector configuration declares the two pipelines

- **WHEN** a reader inspects
  `infra/observability/collector/collector-config.yaml`
- **THEN** the file declares an OTLP receiver bound on
  `0.0.0.0:4317` and `0.0.0.0:4318`
- **AND** the file declares a `filelog` receiver whose `include` glob
  matches `/var/log/backend/*.json` and whose operators parse each line
  as JSON
- **AND** the file declares an `otlp/tempo` exporter targeting
  `tempo:4317`
- **AND** the file declares a `loki` exporter targeting
  `http://loki:3100/loki/api/v1/push`
- **AND** the `service.pipelines.traces` section wires OTLP receiver →
  batch → `otlp/tempo` exporter
- **AND** the `service.pipelines.logs` section wires `filelog`
  receiver → batch → `loki` exporter.

#### Scenario: Loki label set is bounded

- **WHEN** a reader inspects the `loki` exporter section of
  `infra/observability/collector/collector-config.yaml`
- **THEN** the `labels.attributes` (or equivalent) declares exactly
  the labels `service_name`, `event.dataset`, and `log.level`
- **AND** no high-cardinality attribute (`request.id`, `user.id`,
  `trace.id`, `span.id`) appears as a Loki label.

### Requirement: Loki is provisioned under the `observability` docker-compose profile as a Grafana datasource

The repository's `docker-compose.yml` SHALL declare one new service
`loki` under `profiles: ["observability"]` using the image
`grafana/loki:3.2.0`, mounting
`./infra/observability/loki/loki-config.yaml` to
`/etc/loki/local-config.yaml`, with no host port binding (Loki is
reachable only from inside the docker network), and starting with
`-config.file=/etc/loki/local-config.yaml`. The existing `grafana`
service's `depends_on` list SHALL be extended to include both `loki`
and `collector` (in addition to the existing `prometheus` and `tempo`
dependencies from slices 1 and 3).

The repository SHALL include `infra/observability/loki/loki-config.yaml`
declaring a single-binary Loki configuration with local-filesystem
storage rooted at `/loki`, the HTTP API on `0.0.0.0:3100`, schema
config compatible with Loki 3.x, and retention disabled. The file
SHALL carry an inline comment marking the local-filesystem storage
and disabled retention as learning-project defaults and
forward-referencing object-storage backends and a retention period
for production.

The repository SHALL include
`infra/observability/grafana/provisioning/datasources/loki.yaml`
declaring one datasource named `Loki` of type `loki` at
`http://loki:3100`, with `editable: false` and `isDefault: false`
(the slice-1 Prometheus datasource remains the default). The file
SHALL declare a `derivedFields` block that turns any non-blank
`trace.id` field in a Loki log line into a clickable link to the
Tempo datasource using the URL template `${__value.raw}`. The
matching regex SHALL key on the literal JSON key
`"trace.id":"<value>"` so that the link only appears when a real
`trace.id` is present (no link on lines emitted outside a span).

#### Scenario: Loki container starts under the observability profile

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `loki` service starts
- **AND** the Loki HTTP API responds 200 to a `/ready` request from
  inside the docker network at `http://loki:3100/ready`
- **AND** no host port is bound to the loki container.

#### Scenario: Loki configuration uses local-filesystem storage with disabled retention

- **WHEN** a reader inspects `infra/observability/loki/loki-config.yaml`
- **THEN** the file declares local-filesystem storage rooted at
  `/loki`
- **AND** the file binds the HTTP API on `0.0.0.0:3100`
- **AND** the file disables retention
- **AND** the file carries an inline comment marking these as
  learning-project defaults.

#### Scenario: Grafana datasource provisioning declares Loki as non-default with logs-to-traces correlation

- **WHEN** a reader inspects
  `infra/observability/grafana/provisioning/datasources/loki.yaml`
- **THEN** the file declares one datasource named `Loki` of type
  `loki`
- **AND** the URL is `http://loki:3100`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file declares a `derivedFields` entry whose regex
  matches the literal JSON key `"trace.id":"<value>"` in a log line
  body
- **AND** that `derivedFields` entry targets the slice-3 `Tempo`
  datasource by name.

#### Scenario: Backend overview dashboard gains a Recent logs panel

- **WHEN** a reader inspects
  `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard declares one new panel titled `Recent logs`
- **AND** the panel's datasource is `Loki`
- **AND** the panel's query targets `{service_name="backend"}` and
  parses each line with `| json` to surface the ECS field set.

### Requirement: README documents the local log-shipping run loop

The repository's `README.md` SHALL include a `### Log shipping`
subsection under the existing `## Local observability` section, after
the existing `### Distributed tracing` subsection. The subsection SHALL
document:

- that `docker-compose --profile observability up -d` now also brings
  up the `collector` and `loki` services,
- that the developer SHALL export
  `LOG_FILE_PATH=./infra/observability/logs/backend.json` before
  `./gradlew bootRun` to enable the file appender that the Collector
  tails (an example shell line),
- that the slice-3 Tempo direct OTLP host ports (`4317`, `4318`) are
  retired by this slice in favour of the Collector and that Tempo's
  `http://localhost:3200` HTTP API binding stays for direct curl
  debugging,
- the `tracesToLogs` workflow: clicking a `trace.id` in a Tempo span
  view in Grafana opens the matching Loki log lines for that request,
- the `logsToTraces` workflow: clicking a `trace.id` in a Loki log
  line in Grafana opens the matching Tempo span tree,
- a one-line note that the slice-3 manual "copy `trace.id` and paste
  into Tempo search" workflow still works.

#### Scenario: README documents the log-shipping run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Log shipping` subsection under
  `## Local observability`
- **AND** the subsection states that
  `docker-compose --profile observability up -d` brings up
  `collector` and `loki`
- **AND** the subsection shows an example shell line that exports
  `LOG_FILE_PATH` before `./gradlew bootRun`
- **AND** the subsection documents the `tracesToLogs` workflow as a
  one-click pivot from a Tempo span to Loki log lines
- **AND** the subsection documents the `logsToTraces` workflow as a
  one-click pivot from a Loki log line to a Tempo span tree
- **AND** the subsection notes that Tempo's OTLP host port bindings
  are retired and that its `3200` HTTP API binding remains.

### Requirement: Integration test proves the file log-output surface end-to-end in-process

The `backend/` project SHALL include a Testcontainers integration
test
`backend/src/test/java/com/prodready/social/observability/LogFileOutputIT.java`
that boots the full Spring context against a Testcontainers Postgres
with `LOG_FILE_PATH` set to a JUnit-managed temporary file and the
OTel Java agent attached (the `test` task already carries the
`-javaagent:` flag from slice 3). The test SHALL assert:

- every line written to the temp file parses as one JSON object
  carrying the base ECS fields;
- one authenticated `GET /api/v1/auth/me` request results in a line
  in the temp file with `event.dataset == "backend.access"` carrying
  populated `request.id` (non-blank), `user.id` (matching the
  authenticated user), `trace.id` (32-character lowercase hex), and
  `span.id` (16-character lowercase hex) fields;
- the same line is byte-identical between the temp file and the
  captured stdout for the test run (proves the file output is an
  additive surface, not a replacement, and that no formatter
  divergence has been introduced);
- when `LOG_FILE_PATH` is unset for a second test case, no file is
  written to the directory the test created (proves the default dev
  loop remains stdout-only).

The test SHALL NOT boot a Loki container, SHALL NOT boot a
Collector container, and SHALL NOT make any network call to
`http://localhost:4318`, `http://localhost:3100`, or any other
observability-stack endpoint. The wire path from file to Loki is a
manual smoke through the README run loop.

#### Scenario: Log file output integration test covers each listed assertion

- **WHEN** a reader inspects `LogFileOutputIT.java`
- **THEN** every assertion bullet listed above corresponds to at
  least one `@Test` method
- **AND** the test class contains no reference to a Loki container,
  no reference to a Collector container, no `Testcontainers`
  declaration of `grafana/loki` or
  `otel/opentelemetry-collector-contrib`, and no HTTP call to port
  `4318`, `3100`, or `4317`.

### Requirement: Frontend bootstraps an OTel `WebTracerProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The `frontend/` project SHALL pin the following packages in `frontend/package.json` as runtime dependencies: `@opentelemetry/sdk-trace-web`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/context-zone`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-fetch`, `@opentelemetry/instrumentation-document-load`, and `@opentelemetry/instrumentation-user-interaction`. Each coordinate SHALL be pinned with an explicit, non-`latest`, non-tilde-without-bound version range.

The frontend SHALL declare a module `frontend/src/observability/tracer.ts` exporting one function `bootstrapTelemetry(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, construct a `Resource` carrying at minimum the attributes `service.name="frontend"` and `service.version=<value of import.meta.env.VITE_APP_VERSION>`;
- register a `WebTracerProvider` with that resource, a `ZoneContextManager`, a `BatchSpanProcessor`, and an `OTLPTraceExporter` whose URL defaults to `http://localhost:4318/v1/traces` and is overridable via `import.meta.env.VITE_OTEL_TRACES_ENDPOINT`;
- register exactly three auto-instrumentations: `DocumentLoadInstrumentation`, `FetchInstrumentation`, and `UserInteractionInstrumentation`;
- write exactly one console line of the form `OTel telemetry enabled: traces → <endpoint>` when boot succeeds, so a reader can confirm activation from devtools.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapTelemetry()` synchronously before `createRoot(...)` is called.

#### Scenario: SDK packages are pinned with explicit versions

- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block declares each of the nine listed `@opentelemetry/*` packages
- **AND** each coordinate's version range starts with a digit, a caret, or a tilde-with-bound (NOT `latest`, NOT `*`).

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapTelemetry()` runs
- **THEN** no OTel `WebTracerProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled:` is written
- **AND** no outbound POST to `/v1/traces` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: traces → <endpoint>`
- **AND** a `WebTracerProvider` is registered globally (verifiable via `trace.getTracerProvider()`).

#### Scenario: Application source has no compile-time dependency on the OTel SDK outside the observability module

- **WHEN** a reader greps `frontend/src/` for `import .* from ['\"]@opentelemetry/`
- **THEN** every match's file path starts with `frontend/src/observability/`.

### Requirement: Outbound browser fetch requests to the backend carry a W3C `traceparent` header

When telemetry is enabled, `FetchInstrumentation` SHALL be configured with `propagateTraceHeaderCorsUrls` matching exactly the backend origins reachable from the browser:

- the dev backend at `http://localhost:8080`,
- the Vite proxy-relative path family `/api/v1/*` (same-origin),
- the value of `import.meta.env.VITE_API_BASE_URL` if set at build time.

The instrumentation SHALL NOT propagate `traceparent` or `tracestate` headers to any other origin (CDN, font host, analytics host).

#### Scenario: Same-origin fetch to backend carries traceparent

- **GIVEN** the frontend is loaded with telemetry enabled
- **WHEN** an authenticated user triggers a `POST /api/v1/posts` via the UI
- **THEN** the outgoing HTTP request to that URL carries a header named `traceparent` whose value matches the W3C format `00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`.

#### Scenario: Cross-origin fetch to a third-party host carries no traceparent

- **GIVEN** the frontend is loaded with telemetry enabled
- **AND** a `fetch` call is made to a host other than the backend (e.g. a stub fetch to `https://example.com/`)
- **WHEN** a reader inspects the outgoing request headers
- **THEN** no `traceparent` header is present
- **AND** no `tracestate` header is present.

#### Scenario: Backend log line for the traced request carries the same `trace.id`

- **GIVEN** the frontend issues a fetch carrying `traceparent: 00-<X>-<Y>-01` to the backend
- **WHEN** the backend processes the request and emits an access log line
- **THEN** the JSON line's `trace.id` field equals the value `<X>` from the inbound header.

### Requirement: Browser-emitted spans carry `service.name=frontend` and `service.version`

The `Resource` registered with the `WebTracerProvider` SHALL declare at least these resource attributes on every span:

- `service.name` exactly equal to the string `frontend`,
- `service.version` equal to the value of `import.meta.env.VITE_APP_VERSION` (Vite injects this at build time from `frontend/package.json`'s `version` field; if the field is absent the value SHALL be the literal string `unknown`).

Spans SHALL NOT carry any resource attribute whose value is derived from request input (no `user.id`, `post.id`, or other per-request identifier as a resource attribute — those are span attributes if anywhere, never resource attributes).

#### Scenario: Browser-emitted spans land in Tempo with service.name=frontend

- **GIVEN** the frontend is loaded with telemetry enabled and the observability profile is running
- **WHEN** a user clicks a button that fires a backend request
- **AND** a reader queries Tempo for the resulting trace
- **THEN** at least one span in the trace carries `service.name=frontend`
- **AND** at least one span in the trace carries `service.name=backend`
- **AND** both spans share the same `trace.id`.

#### Scenario: service.version is the package version

- **GIVEN** `frontend/package.json` declares `"version": "0.0.0"`
- **WHEN** a span lands in Tempo
- **THEN** its resource attribute `service.version` equals `0.0.0`.

### Requirement: OTel Collector OTLP/HTTP receiver allows CORS for Vite origins

The file `infra/observability/collector/collector-config.yaml` SHALL declare a `cors` block on the `otlp` receiver's `http` protocol stanza with:

- `allowed_origins` containing at minimum `http://localhost:5173` (Vite dev) and `http://localhost:4173` (Vite preview),
- `allowed_headers` containing at minimum `*` OR the explicit list `["Content-Type", "traceparent", "tracestate"]`.

The receiver SHALL continue to listen on `0.0.0.0:4318` and SHALL continue to accept gRPC OTLP on `:4317` unchanged. The CORS block SHALL apply only to the HTTP protocol; the gRPC receiver SHALL NOT carry a CORS block.

#### Scenario: Collector config declares the CORS allowlist on the OTLP/HTTP receiver

- **WHEN** a reader inspects `infra/observability/collector/collector-config.yaml`
- **THEN** the file declares an `otlp` receiver with an `http` protocol stanza
- **AND** that stanza contains a `cors` block
- **AND** the `cors.allowed_origins` list includes both `http://localhost:5173` and `http://localhost:4173`.

#### Scenario: Preflight from Vite dev origin is accepted

- **GIVEN** the observability profile is running
- **WHEN** a client issues `OPTIONS http://localhost:4318/v1/traces` with `Origin: http://localhost:5173` and `Access-Control-Request-Method: POST`
- **THEN** the response status is 200 OR 204
- **AND** the response carries `Access-Control-Allow-Origin: http://localhost:5173`.

#### Scenario: Preflight from a disallowed origin is rejected

- **GIVEN** the observability profile is running
- **WHEN** a client issues `OPTIONS http://localhost:4318/v1/traces` with `Origin: https://evil.example.com`
- **THEN** the response does NOT carry `Access-Control-Allow-Origin: https://evil.example.com`
- **AND** the response does NOT carry `Access-Control-Allow-Origin: *`.

### Requirement: Collector redacts high-cardinality path segments from FE and BE spans

The file `infra/observability/collector/collector-config.yaml` SHALL declare a `transform` processor (`transform/redact-path-ids` or equivalent name) that, on every span passing through the `traces/default` pipeline, replaces matches of the following patterns inside span name, `http.url`, `http.target`, and `url.full` (where present) with the literal token `{id}`:

- UUID v4 (lowercase hex with hyphens): `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
- opaque hex segments of length 8 or more (`[0-9a-f]{8,}`) when bounded by `/` or end-of-string;
- numeric segments of length 4 or more (`[0-9]{4,}`) when bounded by `/` or end-of-string.

The processor SHALL be wired into the `traces/default` pipeline before the Tempo exporter, after any receiver-side processors. The processor SHALL apply to spans from any `service.name` value (FE and BE both).

#### Scenario: Collector pipeline lists the redaction processor before the Tempo exporter

- **WHEN** a reader inspects `infra/observability/collector/collector-config.yaml`
- **THEN** the file declares a `transform/redact-path-ids` processor (or equivalent name)
- **AND** the `service.pipelines.traces` (or `service.pipelines.traces/default`) `processors` list includes that processor
- **AND** the processor appears before any Tempo exporter in the same pipeline's `exporters` evaluation order.

#### Scenario: UUID segment is redacted in a browser-emitted span

- **GIVEN** the frontend issues a fetch to `/api/v1/users/00000000-0000-0000-0000-000000000abc/follow`
- **WHEN** the resulting span is queried from Tempo
- **THEN** the span's `http.url` attribute does NOT contain the substring `00000000-0000-0000-0000-000000000abc`
- **AND** the span's `http.url` attribute contains the substring `{id}`.

#### Scenario: Numeric id segment is redacted in a backend-emitted span

- **GIVEN** the backend handles `GET /api/v1/users/123456`
- **WHEN** the resulting span is queried from Tempo
- **THEN** no span attribute on that span contains the substring `/123456`
- **AND** at least one span attribute contains the substring `/{id}`.

### Requirement: Browser → Collector traffic goes direct; Vite proxy is NOT extended to `/v1/traces`

The file `frontend/vite.config.ts` SHALL NOT declare a proxy entry whose target is the OTel Collector. The proxy configuration SHALL remain restricted to backend paths (currently `/api/v1` and `/actuator`).

#### Scenario: Vite proxy config covers only backend paths

- **WHEN** a reader inspects the `server.proxy` (and `preview.proxy`) blocks in `frontend/vite.config.ts`
- **THEN** every proxy key matches either `/api/v1*` or `/actuator*`
- **AND** no proxy key matches `/v1/traces`, `/otlp*`, or any path under the Collector.

### Requirement: Browser-side header capture is left at OTel defaults

The `FetchInstrumentation` registration in `frontend/src/observability/tracer.ts` SHALL NOT pass an `applyCustomAttributesOnSpan` (or equivalent) hook that synthesises request- or response-header attributes onto spans. The OTel default behaviour (URL, method, status code, timings recorded; headers NOT recorded) SHALL be preserved.

#### Scenario: No header capture hook is configured

- **WHEN** a reader inspects `frontend/src/observability/tracer.ts`
- **THEN** the `FetchInstrumentation` constructor call carries no key named `applyCustomAttributesOnSpan`, `requestHook`, or `responseHook`
- **AND** no code in `frontend/src/observability/` calls `span.setAttribute('http.request.header.*', ...)` or `span.setAttribute('http.response.header.*', ...)`.

#### Scenario: Authorization header does not leak to a span

- **GIVEN** the frontend issues an authenticated `POST /api/v1/posts` carrying `Authorization: Bearer <jwt>`
- **WHEN** the resulting span is queried from Tempo
- **THEN** no span attribute on that span contains the substring `Bearer `
- **AND** no span attribute on that span carries a name starting with `http.request.header.authorization`.

### Requirement: Tempo datasource provisioning enables the service graph

The file `infra/observability/grafana/provisioning/datasources/tempo.yaml` SHALL declare on the existing `Tempo` datasource a `jsonData.serviceMap` block configured to render the service graph. The block SHALL reference the existing Prometheus datasource by name (`Prometheus`) so the service graph queries traffic metrics from Prometheus.

#### Scenario: Tempo datasource declares the serviceMap block

- **WHEN** a reader inspects `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one `Tempo` datasource
- **AND** the datasource's `jsonData` carries a `serviceMap` key whose `datasourceUid` (or `datasourceName`) refers to the `Prometheus` datasource.

### Requirement: End-to-end test proves browser → backend trace continuity

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/observability.frontend-traces.spec.ts` that, with the observability profile up and telemetry enabled:

- logs in as a seeded user via the UI,
- triggers a `POST /api/v1/posts` from the UI (not via direct API call),
- captures the `traceparent` header on the outgoing request via Playwright's `request.headers()`,
- polls Tempo's HTTP API (`http://localhost:3200/api/traces/<traceId>`) until **both** `resource.service.name=frontend` AND `resource.service.name=backend` spans are present in the returned trace (not just any non-empty response — the backend's span batch lands first, and the FE batch arrives after a BatchSpanProcessor flush + Collector → Tempo ingest tail, so the loop SHALL continue past the first non-empty batch until the FE-side span is also visible, with the existing 30-second total budget and 1-second interval),
- asserts the backend ECS log line emitted for that request carries the same `trace.id` value as the `traceparent` from the browser.

The spawned telemetry-enabled `vite dev` server SHALL bind to `http://localhost:5173` (the canonical Vite dev port, already in the Collector's CORS allowlist). The test SHALL NOT bind to a port outside that allowlist; spawning the dev server on an off-allowlist port would CORS-block the browser's OTLP POSTs and the FE half of the trace would never reach Tempo. The `--strictPort` flag SHALL be passed so a busy `:5173` fails loud rather than silently selecting a fallback.

The test SHALL `test.skip(...)` itself when the Tempo HTTP API is not reachable, matching the slice-3 pattern. The test SHALL NOT depend on which service.name span is the root of the trace tree (the root may be `documentLoad` or a click span, both of which are `frontend`).

#### Scenario: Test asserts trace continuity for one POST /api/v1/posts

- **WHEN** the e2e test runs against an observability-up environment
- **THEN** the test passes
- **AND** the test makes exactly one assertion that the browser-emitted `traceparent` carries a 32-hex-character trace id
- **AND** the test makes exactly one assertion that the Tempo trace contains spans from both `service.name=frontend` and `service.name=backend`
- **AND** the test makes exactly one assertion that the backend's log line for the request carries the same `trace.id`.

#### Scenario: Test self-skips when Tempo is unreachable

- **GIVEN** the observability profile is NOT running (Tempo HTTP API on `:3200` is unreachable)
- **WHEN** the e2e test executes
- **THEN** the test is reported as skipped, not failed
- **AND** the skip reason mentions Tempo reachability.

#### Scenario: Tempo poll waits for the FE span, not just any batch

- **GIVEN** the e2e test has captured a `traceparent` from the browser's `POST /api/v1/posts`
- **WHEN** the test polls `GET http://localhost:3200/api/traces/<traceId>`
- **THEN** the loop SHALL continue past a response that contains only `resource.service.name=backend` spans
- **AND** the loop SHALL return only when the response contains at least one `resource.service.name=frontend` span AND at least one `resource.service.name=backend` span
- **AND** the loop SHALL respect a 30-second total budget; on budget exhaustion the test SHALL fail with a message identifying which service name(s) were still missing.

#### Scenario: Telemetry-enabled dev server binds to the allowlisted dev origin

- **WHEN** the e2e test's `beforeAll` spawns its own `vite dev` server (so the build can read `VITE_OTEL_ENABLED=true`)
- **THEN** the server binds to `http://localhost:5173` exactly (host MUST be the literal `localhost`, not `127.0.0.1` — CORS treats those as distinct origins and only `http://localhost:5173` is in `cors.allowed_origins`)
- **AND** the spawn passes `--strictPort` so a busy port fails the test loudly rather than silently using a fallback
- **AND** the Origin the browser presents to the Collector's CORS preflight (`http://localhost:5173`) is already in `cors.allowed_origins` on the OTLP/HTTP receiver.

#### Scenario: Loki HTTP API is reachable from the host

- **GIVEN** the observability profile is running
- **WHEN** the e2e test issues `GET http://localhost:3100/loki/api/v1/query_range` from the Playwright process running on the host
- **THEN** Loki responds (`docker-compose.yml` SHALL publish container port 3100 to host port 3100 on the `loki` service)
- **AND** the Grafana → Tempo `tracesToLogs` pivot continues to use the container DNS address (`http://loki:3100`), unaffected by the host port mapping.

#### Scenario: Loki query matches the ECS-nested trace.id shape

- **GIVEN** the e2e test has captured a `traceparent` from the browser's `POST /api/v1/posts`
- **WHEN** the test polls `GET http://localhost:3100/loki/api/v1/query_range` with a LogQL filter that selects lines containing the trace id
- **THEN** the filter SHALL match the backend's ECS-nested emission (`"trace":{"id":"<id>"`), not a flat dotted key (`"trace.id":"<id>"`)
- **AND** the test SHALL accept the line as a match if the 32-hex trace id appears anywhere in the stored line (the id is unique enough to make false positives impossible and avoids coupling the assertion to the loki exporter's field-order choices).

### Requirement: README documents the frontend tracing run loop

The repository's `README.md` SHALL add a `### Frontend tracing` subsection inside the existing `## Local observability` section, after the existing trace-pivot documentation. The subsection SHALL document:

- the `VITE_OTEL_ENABLED=true pnpm dev` invocation (in `frontend/`),
- the Tempo URL via Grafana, with the one-trace-two-services shape (`frontend` plus `backend`),
- the click→trace pivot (clicking a UI button produces a trace whose root is in `frontend`),
- the fact that `traceparent` is propagated only to the backend, not to third-party hosts.

#### Scenario: README documents the run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Frontend tracing` subsection nested under `## Local observability`
- **AND** the section names the `VITE_OTEL_ENABLED=true pnpm dev` invocation
- **AND** the section names Grafana's Tempo service-name filter and references both `frontend` and `backend` service values
- **AND** the section explicitly states that `traceparent` propagation is restricted to the backend origin.

### Requirement: Frontend pins the Web Vitals library and OTel browser metrics SDK packages

The `frontend/` project SHALL pin the following packages in `frontend/package.json` as runtime dependencies: `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`. Each coordinate SHALL be pinned with an explicit, non-`latest` version range. The packages SHALL be imported only from files under `frontend/src/observability/`.

#### Scenario: New SDK packages are pinned with explicit versions

- **WHEN** a reader inspects `frontend/package.json`
- **THEN** the `dependencies` block declares each of `web-vitals`, `@opentelemetry/sdk-metrics`, and `@opentelemetry/exporter-metrics-otlp-http`
- **AND** each coordinate's version range starts with a digit, a caret, or a tilde-with-bound (NOT `latest`, NOT `*`).

#### Scenario: Application source has no compile-time dependency on the new packages outside the observability module

- **WHEN** a reader greps `frontend/src/` for `import .* from ['"]web-vitals` or `import .* from ['"]@opentelemetry/sdk-metrics` or `import .* from ['"]@opentelemetry/exporter-metrics-otlp-http`
- **THEN** every match's file path starts with `frontend/src/observability/`.

### Requirement: Frontend bootstraps an OTel `MeterProvider` before React renders, gated by `VITE_OTEL_ENABLED`

The frontend SHALL declare a module `frontend/src/observability/meter.ts` exporting one function `bootstrapMetrics(): void`. The function SHALL:

- return immediately as a no-op when `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`;
- when enabled, register a `MeterProvider` whose `Resource` is the shared `Resource` instance exported by `frontend/src/observability/resource.ts` (carrying at minimum `service.name="frontend"` and `service.version`);
- register a `PeriodicExportingMetricReader` whose exporter is an `OTLPMetricExporter` whose URL defaults to `http://localhost:4318/v1/metrics` and is overridable via `import.meta.env.VITE_OTEL_METRICS_ENDPOINT`;
- set the reader's export interval from `import.meta.env.VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` if defined as a positive integer, otherwise default to `15000` (15 s, matching Prometheus's `scrape_interval`);
- write exactly one console line of the form `OTel telemetry enabled: metrics → <endpoint>` when boot succeeds.

The module `frontend/src/main.tsx` SHALL invoke `bootstrapMetrics()` synchronously after `bootstrapTelemetry()` and before `createRoot(...)`.

#### Scenario: Bootstrap is a no-op when the env var is unset

- **GIVEN** `import.meta.env.VITE_OTEL_ENABLED` is not the string `"true"`
- **WHEN** the frontend boots and `bootstrapMetrics()` runs
- **THEN** no OTel `MeterProvider` is registered
- **AND** no console line of the form `OTel telemetry enabled: metrics →` is written
- **AND** no outbound POST to `/v1/metrics` is made for the lifetime of the page.

#### Scenario: Bootstrap activates the meter provider when the env var is set

- **GIVEN** the frontend is built with `VITE_OTEL_ENABLED=true`
- **WHEN** the page first loads
- **THEN** the console carries exactly one line of the form `OTel telemetry enabled: metrics → <endpoint>`
- **AND** at least one POST to `<endpoint>` is observed within `2 * exportIntervalMillis` (i.e. within 30 s at the default).

#### Scenario: Bootstrap runs after `bootstrapTelemetry()` and before `createRoot(...)`

- **WHEN** a reader inspects `frontend/src/main.tsx`
- **THEN** the call to `bootstrapTelemetry()` precedes the call to `bootstrapMetrics()`
- **AND** both calls precede the call to `createRoot(...)`.

### Requirement: Frontend traces and metrics share one OTel `Resource` instance

The frontend SHALL declare a module `frontend/src/observability/resource.ts` exporting exactly one `Resource` instance carrying at minimum `service.name="frontend"` and `service.version=<value of import.meta.env.VITE_APP_VERSION>` (defaulting to the string `unknown` when the env var is absent). Both `frontend/src/observability/tracer.ts` and `frontend/src/observability/meter.ts` SHALL import that shared `Resource` rather than construct their own.

#### Scenario: `tracer.ts` imports the shared resource

- **WHEN** a reader inspects `frontend/src/observability/tracer.ts`
- **THEN** the file imports the shared `Resource` instance from `./resource`
- **AND** the file does NOT call `resourceFromAttributes(...)` directly with `service.name` or `service.version`.

#### Scenario: `meter.ts` imports the shared resource

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** the file imports the shared `Resource` instance from `./resource`
- **AND** the file does NOT call `resourceFromAttributes(...)` directly with `service.name` or `service.version`.

### Requirement: Web Vitals are recorded as histograms via the official `web-vitals` library

When metrics are enabled, `bootstrapMetrics()` SHALL register handlers `onLCP`, `onCLS`, `onINP`, `onFCP`, and `onTTFB` from the `web-vitals` package. Each handler's callback SHALL record the metric's `value` into a Histogram instrument whose name follows the pattern `web_vitals_<lowercase metric name>` (so: `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp`, `web_vitals_fcp`, `web_vitals_ttfb`). The instruments SHALL NOT declare any per-event attributes; only the meter's shared `Resource` attributes apply.

The Web Vitals reporter SHALL be called in `reportAllChanges: false` mode (one final value per metric per page load), matching the Google-published default.

#### Scenario: LCP observation lands as a histogram bucket increment

- **GIVEN** the frontend is loaded with metrics enabled
- **AND** the OTel metrics exporter has flushed at least once after a page load
- **WHEN** a reader inspects the Collector's `/metrics` scrape body
- **THEN** at least one line whose name starts with `web_vitals_lcp_bucket` is present
- **AND** the line carries the label `service_name="frontend"`.

#### Scenario: Web Vitals instruments carry no per-event attributes

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** no call to `histogram.record(...)` for a Web Vitals histogram passes a non-empty attributes object
- **AND** the only resource attributes on the data points are `service.name` and `service.version` (and OTel SDK defaults).

### Requirement: Route-transition duration is recorded with a route-template label

The frontend SHALL declare a component `frontend/src/observability/route-timing.tsx` exporting `<RouteTimingObserver />`. The component SHALL subscribe to React Router's `useLocation()` and, on every pathname change after the initial render, SHALL record the duration from `performance.now()` at the previous transition (or from `performance.timeOrigin`-relative navigation start on the first transition) into a Histogram instrument named `route_change_duration_ms`. The instrument SHALL be labelled by exactly one attribute `route` whose value is the matched React Router `path` template (e.g. `/home`, `/users/:userId`, `/login`), NOT the resolved pathname. When no matching route is found, the label value SHALL be the literal string `unknown`.

The component SHALL be rendered exactly once inside `<BrowserRouter>` in `frontend/src/App.tsx`, and SHALL render `null`.

#### Scenario: Navigation increments the route-timing histogram with a route-template label

- **GIVEN** the frontend is loaded with metrics enabled
- **AND** a user is on `/home`
- **WHEN** the user navigates to `/users/abc-123`
- **AND** the OTel metrics exporter flushes
- **THEN** the Collector's `/metrics` body contains at least one line for `route_change_duration_ms_bucket` carrying the label `route="/users/:userId"`
- **AND** no line carries the label `route="/users/abc-123"`.

#### Scenario: Observer renders nothing visible

- **WHEN** a reader inspects the DOM after `<RouteTimingObserver />` mounts
- **THEN** the component contributes no rendered nodes.

#### Scenario: Observer lives inside `<BrowserRouter>`

- **WHEN** a reader inspects `frontend/src/App.tsx`
- **THEN** `<RouteTimingObserver />` is rendered as a descendant of `<BrowserRouter>`.

### Requirement: Long-task durations are recorded via the Performance Observer

When metrics are enabled, `bootstrapMetrics()` SHALL register a `PerformanceObserver` of type `longtask` with `buffered: true`. Each entry's `duration` SHALL be recorded into a Histogram instrument named `long_task_duration_ms`. The instrument SHALL declare no per-entry attributes; only the meter's shared `Resource` attributes apply. If the `longtask` performance entry type is unsupported in the current browser (`PerformanceObserver.supportedEntryTypes` does not include `longtask`), `bootstrapMetrics()` SHALL skip registration silently and continue with the rest of the bootstrap.

#### Scenario: A long task records into the histogram

- **GIVEN** the frontend is loaded with metrics enabled in a browser that supports `longtask`
- **AND** a synthetic main-thread block of at least 60 ms is forced (e.g. a busy-wait loop in a click handler)
- **WHEN** the OTel metrics exporter flushes
- **THEN** the Collector's `/metrics` body contains at least one line for `long_task_duration_ms_bucket` whose `service_name` label equals `frontend`.

#### Scenario: Unsupported browser silently skips registration

- **GIVEN** a browser whose `PerformanceObserver.supportedEntryTypes` does not include `longtask`
- **WHEN** the frontend boots with metrics enabled
- **THEN** no exception is thrown
- **AND** the rest of `bootstrapMetrics()` (Web Vitals, route timing) registers successfully.

### Requirement: OTel Collector exposes FE metrics via a `prometheus` exporter on `:8889`

The OTel Collector configuration at `infra/observability/collector/collector-config.yaml` SHALL declare a new pipeline `metrics` with:

- the existing `otlp` receiver (no CORS change required — slice 5's allowlist on `:4318` already covers the metrics endpoint at `/v1/metrics`);
- the `batch` processor (existing);
- a new `prometheus` exporter listening on `0.0.0.0:8889` with `add_metric_suffixes: false` and `namespace: ""` so emitted metric names are preserved verbatim.

The Collector compose entry in `docker-compose.yml` SHALL publish container port `8889` to host port `8889` so the Prometheus container (and `curl` on the developer's loopback) can reach the exporter.

#### Scenario: Collector exposes a Prometheus scrape endpoint on `:8889`

- **GIVEN** the observability docker-compose profile is up
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response status is 200
- **AND** the `Content-Type` header starts with `text/plain` (Prometheus text-exposition format).

#### Scenario: Emitted metric names carry no Collector-added prefix

- **GIVEN** a browser has flushed at least one OTLP metrics export to the Collector
- **WHEN** a reader inspects the body of `GET http://localhost:8889/metrics`
- **THEN** at least one line begins with `web_vitals_lcp_bucket`
- **AND** no line begins with `otelcol_web_vitals_` or any other Collector-injected prefix.

### Requirement: Collector drops FE metric data points with high-cardinality route labels

The Collector configuration SHALL declare a `filter/drop_high_cardinality` processor in the `metrics` pipeline (between `batch` and `prometheus` exporter) that drops any data point whose `route` attribute matches an unredacted-id pattern: `[0-9a-f]{8,}`, `/[0-9]{4,}/`, or a UUID v4. This guard is defense-in-depth; the primary cardinality control is in `route-timing.tsx` (Requirement: "Route-transition duration is recorded with a route-template label").

#### Scenario: A leaked id-bearing route attribute is dropped at the Collector

- **GIVEN** the Collector configuration declares the `filter/drop_high_cardinality` processor
- **AND** a (hypothetical) data point with `route="/users/abc-123-def-456-7890"` is received via OTLP
- **WHEN** the Collector evaluates the processor
- **THEN** the data point is dropped before reaching the `prometheus` exporter
- **AND** no Prometheus query returns a sample carrying `route="/users/abc-123-def-456-7890"`.

#### Scenario: A clean route-template attribute passes through

- **GIVEN** a data point with `route="/users/:userId"` is received via OTLP
- **WHEN** the Collector evaluates the processor
- **THEN** the data point is forwarded to the `prometheus` exporter unchanged.

### Requirement: Prometheus scrapes the Collector as a new `collector` job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL declare a second scrape job named `collector` with `metrics_path: /metrics`, `scrape_interval: 15s`, and `static_configs.targets: ["collector:8889"]`. The existing `backend` job SHALL remain unchanged.

#### Scenario: Prometheus reports the collector target as up

- **GIVEN** the observability profile is up and the Collector is running
- **WHEN** a reader issues `GET http://localhost:9090/api/v1/targets`
- **THEN** the response body contains a target whose `labels.job` is `collector`
- **AND** that target's `health` is `up`.

#### Scenario: Prometheus query returns FE Web Vitals samples after browser traffic

- **GIVEN** at least one browser has loaded the app with metrics enabled and the page has been visible long enough for `web-vitals` to finalise the LCP metric (typically < 5 s after first paint)
- **AND** at least one Collector → Prometheus scrape cycle has completed
- **WHEN** a reader queries `GET http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}`
- **THEN** the response's `data.result` array is non-empty.

### Requirement: Grafana provisions a `Frontend overview` dashboard

The repository SHALL include a Grafana dashboard JSON file at `infra/observability/grafana/dashboards/frontend-overview.json` picked up by the existing provisioning provider in `infra/observability/grafana/provisioning/dashboards/dashboards.yaml`. The dashboard SHALL contain at minimum five rows of panels:

- **Web Vitals**: time-series or stat panels for `web_vitals_lcp` p75, `web_vitals_cls` p75, `web_vitals_inp` p75, `web_vitals_fcp` p75, and `web_vitals_ttfb` p75 — each filtered to `service_name="frontend"`.
- **Route timing**: a time-series panel for `route_change_duration_ms` p50/p95/p99, grouped by the `route` label.
- **Long tasks**: a time-series panel for the rate of `long_task_duration_ms_count` and a time-series panel for the rate-of-sum of `long_task_duration_ms_sum`.
- **Browser request volume**: a time-series panel for the rate of `web_vitals_lcp_count` per minute, used as a session-rate proxy.
- **SLO**: at minimum four panels covering the LCP and INP SLOs:
  - A stat panel showing LCP "error budget headroom (last 6 h)" computed as `1 - (job:slo_lcp:slow_ratio_rate6h / (1 - 0.95))`, with the panel title or description making the 6 h window explicit.
  - A stat panel showing INP "error budget headroom (last 6 h)" computed as `1 - (job:slo_inp:slow_ratio_rate6h / (1 - 0.95))`, with the panel title or description making the 6 h window explicit.
  - A time-series panel showing the current 1 h burn rate for LCP and INP — one line per SLO, computed as `job:slo_lcp:slow_ratio_rate1h / (1 - 0.95)` and `job:slo_inp:slow_ratio_rate1h / (1 - 0.95)`.
  - A time-series panel showing `histogram_quantile(0.75, sum(rate(web_vitals_lcp_bucket{service_name="frontend"}[5m])) by (le))` and the matching INP query, with a static reference line at 2500 (LCP) and 200 (INP) drawn as a threshold.

The dashboard SHALL declare its data source as the existing provisioned Prometheus datasource, NOT a hard-coded datasource UID. The existing rows (Web Vitals, Route timing, Long tasks, Browser request volume) SHALL be preserved without behavioral change.

#### Scenario: Provisioning surface exposes the dashboard

- **GIVEN** the observability profile is up
- **WHEN** a reader issues `GET http://localhost:3000/api/search?query=Frontend%20overview`
- **THEN** the response body contains an entry whose `title` is `Frontend overview`

#### Scenario: Dashboard JSON references the Prometheus datasource by name, not by hard-coded UID

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** every panel's `datasource` block either omits the `uid` field or uses the templated form `${DS_PROMETHEUS}` resolved by provisioning

#### Scenario: Dashboard JSON contains the SLO row with panels for LCP and INP

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** the dashboard contains a row whose title (or section header) is `SLO`
- **AND** at least one panel in that row queries `job:slo_lcp:slow_ratio_rate6h` (the LCP budget headroom stat)
- **AND** at least one panel in that row queries `job:slo_inp:slow_ratio_rate6h` (the INP budget headroom stat)
- **AND** at least one panel in that row queries both `job:slo_lcp:slow_ratio_rate1h` and `job:slo_inp:slow_ratio_rate1h` (the burn-rate time-series)
- **AND** at least one panel in that row computes a `histogram_quantile(0.75, ...)` over `web_vitals_lcp_bucket` and another over `web_vitals_inp_bucket`

#### Scenario: Pre-existing rows are preserved

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/frontend-overview.json`
- **THEN** the dashboard still contains panels matching each row from the previous version (Web Vitals p75 panels for LCP/CLS/INP/FCP/TTFB, the route-timing p50/p95/p99 panel, the long-tasks rate and rate-of-sum panels, and the browser request-volume panel)

### Requirement: End-to-end test proves the FE → Collector → Prometheus metrics pipeline

The repository SHALL include a Playwright spec at `e2e/tests/observability.frontend-rum-metrics.spec.ts` that drives one authenticated session through the home page and at least one route transition, then asserts the full metrics chain. The spec SHALL be skipped (via `test.skip(...)`) when either of `http://localhost:8889/metrics` or `http://localhost:9090/-/healthy` is unreachable, mirroring the slice-5 pattern that allows the suite to stay green when the observability profile is not running.

#### Scenario: Collector scrape endpoint carries FE-emitted series

- **GIVEN** the observability profile is up
- **AND** the spec has driven one authenticated session through `/home` and at least one navigation to `/users/{id}`
- **WHEN** the spec polls `http://localhost:8889/metrics` after the Collector's batch flush interval has elapsed
- **THEN** the response body contains at least one line beginning with `web_vitals_lcp_bucket` carrying `service_name="frontend"`
- **AND** the response body contains at least one line beginning with `route_change_duration_ms_bucket` carrying both `service_name="frontend"` and a `route` label whose value is a route template (no resolved id).

#### Scenario: Prometheus query returns the FE-emitted series

- **GIVEN** the spec has driven the same authenticated traffic
- **AND** at least 30 s have elapsed since the first observation (one export interval plus one scrape interval)
- **WHEN** the spec queries `GET http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}`
- **THEN** `data.result` is a non-empty array.

#### Scenario: Spec is skipped cleanly when observability is not running

- **GIVEN** the docker-compose `observability` profile is NOT up
- **AND** either `http://localhost:8889/metrics` or `http://localhost:9090/-/healthy` returns a network error
- **WHEN** the spec runs
- **THEN** every test case in the file reports as `skipped`, not `failed`.

### Requirement: README documents the local frontend RUM run loop

The repository's root `README.md` SHALL contain a subsection `### Frontend RUM metrics` under the existing `## Local observability` section. The subsection SHALL document at minimum:

- the `VITE_OTEL_ENABLED=true pnpm dev` opt-in;
- that browser metrics post to `http://localhost:4318/v1/metrics` (the OTel Collector's OTLP/HTTP endpoint, same port as slice 5 traces);
- that the Collector exposes the FE metrics on `http://localhost:8889/metrics`;
- the URL of the provisioned dashboard: `http://localhost:3000/d/frontend-overview` (or via Grafana search for the title `Frontend overview`);
- the expectation that panels are empty until a browser session has loaded the app with the gate enabled.

#### Scenario: README has a Frontend RUM subsection under Local observability

- **WHEN** a reader greps `README.md` for `### Frontend RUM metrics`
- **THEN** exactly one match is returned
- **AND** that match's nearest enclosing `##` header is `## Local observability` (or an equivalent existing observability section).

#### Scenario: README cites the new Collector scrape port

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text mentions the literal string `localhost:8889/metrics` at least once.

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

### Requirement: Alertmanager is provisioned under the `observability` docker-compose profile and as a Grafana datasource

A single `alertmanager` service runs alongside the existing Prometheus, Tempo, Loki, OTel Collector, Grafana, and (from this slice) webhook-sink containers when (and only when) the `observability` profile is selected. Its HTTP API on port `9093` is the canonical alert store: queryable for active alerts, consumed by Grafana via a provisioned datasource, and the routing entry point for every firing. Alertmanager's configuration MUST declare a severity-based routing tree that delivers `severity=page` alerts to one webhook receiver and `severity=ticket` alerts to another, plus an inhibition rule that suppresses every SLO alert while `BackendDown` is firing. The default `docker-compose up -d postgres` invocation MUST continue to start only Postgres.

#### Scenario: Default invocation still starts only postgres (preserved across slice 8)
- **WHEN** an operator runs `docker-compose up -d postgres` from the repository root
- **THEN** only the `social-postgres` container is started
- **AND** no `social-alertmanager`, `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, `social-loki`, or `social-webhook-sink` container is started

#### Scenario: Observability profile starts alertmanager alongside the other observability services
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `social-alertmanager` container is started in addition to `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, `social-loki`, and `social-webhook-sink`
- **AND** the `social-alertmanager` container exposes Alertmanager's HTTP API on host port `9093`

#### Scenario: Alertmanager image tag is pinned
- **WHEN** the docker-compose `alertmanager` service definition is read
- **THEN** the `image:` field is `prom/alertmanager:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: Alertmanager configuration declares a severity-based routing tree
- **WHEN** `infra/observability/alertmanager/alertmanager.yml` is loaded by Alertmanager at startup
- **THEN** the top-level `route:` block names a `default` receiver from the `receivers:` list
- **AND** the top-level `route:` declares two child routes: one matching `severity="page"` that targets a `page-webhook` receiver, and one matching `severity="ticket"` that targets a `ticket-webhook` receiver
- **AND** neither child route sets `continue: true` (each firing terminates at the first matching leaf)
- **AND** the existing `group_by: ['alertname', 'slo']`, `group_wait: 10s`, `group_interval: 5m`, and `repeat_interval: 4h` values on the top-level route are preserved

#### Scenario: Alertmanager webhook receivers target the webhook-sink container
- **WHEN** the `receivers:` block in `alertmanager.yml` is loaded
- **THEN** the `page-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink:8080/page` and `send_resolved: true`
- **AND** the `ticket-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink:8080/ticket` and `send_resolved: true`
- **AND** the `default` receiver exists (Alertmanager requires it) and declares no `webhook_configs:` (unlabelled alerts are dropped silently until they gain a severity label)

#### Scenario: Alertmanager configuration declares the BackendDown inhibition rule
- **WHEN** the `inhibit_rules:` block in `alertmanager.yml` is loaded
- **THEN** there is exactly one inhibition rule whose `source_matchers:` match `alertname="BackendDown"` and whose `target_matchers:` match `slo=~".+"`
- **AND** the rule's `equal:` field is the empty list (a BackendDown anywhere inhibits every SLO alert anywhere — slice 11 has only one backend target)

#### Scenario: Grafana datasource provisioning declares Alertmanager as non-default
- **WHEN** Grafana provisioning is loaded
- **THEN** `infra/observability/grafana/provisioning/datasources/alertmanager.yaml` declares an Alertmanager datasource targeting `http://alertmanager:9093`
- **AND** the datasource is marked `isDefault: false`
- **AND** the datasource implementation is `alertmanager` (so Grafana's built-in Alerting nav reads from it)

### Requirement: Prometheus rule files live in `infra/observability/prometheus/rules/` and are loaded at startup

Recording and alerting rules SHALL be version-controlled under a dedicated directory next to the existing Prometheus configuration. The Prometheus configuration MUST load them via the `rule_files:` block and MUST declare the Alertmanager target via the `alerting:` block, so rule evaluation and alert routing both happen from a Prometheus restart with no further wiring. The `rule_files:` block MUST include the frontend SLO rule files (`fe-slo-recording.yml`, `fe-slo-alerting.yml`) alongside the existing backend rule files (`slo-recording.yml`, `slo-alerting.yml`).

#### Scenario: Prometheus configuration loads the rule files

- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has a `rule_files:` block that references at least `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, and `fe-slo-alerting.yml` under `infra/observability/prometheus/rules/`

#### Scenario: Prometheus configuration declares the Alertmanager target

- **WHEN** `infra/observability/prometheus/prometheus.yml` is read
- **THEN** the file has an `alerting:` block with `alertmanagers:` containing a `static_configs:` target of `alertmanager:9093` on the shared docker network

#### Scenario: Rule files are mounted into the Prometheus container

- **WHEN** the docker-compose `prometheus` service starts under the `observability` profile
- **THEN** `infra/observability/prometheus/rules/` is mounted read-only into the container at the path referenced by `rule_files:` in `prometheus.yml`

#### Scenario: Frontend SLO rule files appear in the Prometheus rules API

- **GIVEN** the observability profile is up and Prometheus has loaded the rule files
- **WHEN** a reader issues `GET http://localhost:9090/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field matches the mounted path for `fe-slo-recording.yml` and `fe-slo-alerting.yml`
- **AND** the groups together declare the recording rules `job:slo_lcp:slow_ratio_rate1h` and `job:slo_inp:slow_ratio_rate1h` and the alerting rules `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`

### Requirement: Recording rules compute per-SLO error-budget ratios over canonical windows

Burn-rate alerts are arithmetic on per-window error ratios. A canonical recording rule MUST be emitted for each SLO at each window the alerts need, named following Prometheus's `level:metric:operation` convention. Recording-rule names SHALL be considered part of the public contract because follow-up dashboards and alerts will reference them.

#### Scenario: API availability error ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** the following series exist (one sample per evaluation interval) with the labels `job="backend"`:
  - `job:slo_api_availability:errors_ratio_rate5m`
  - `job:slo_api_availability:errors_ratio_rate30m`
  - `job:slo_api_availability:errors_ratio_rate1h`
  - `job:slo_api_availability:errors_ratio_rate6h`
  - `job:slo_api_availability:errors_ratio_rate3d`
- **AND** each series is defined as `sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*", status=~"5.."}[<window>])) / sum(rate(http_server_requests_seconds_count{uri=~"/api/v1/.*"}[<window>]))`

#### Scenario: Feed-read latency slow-request ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** series `job:slo_feed_read_latency:slow_ratio_rate<W>` exist for `W` in {`5m`, `30m`, `1h`, `6h`, `3d`}
- **AND** each series is the ratio of `feed_read_duration_seconds_bucket{le="0.2"}` request count to the total `feed_read_duration_seconds_count`, expressed as `1 - good / total` over the window

#### Scenario: Post-create latency slow-request ratio is recorded at every required window
- **WHEN** Prometheus evaluates `slo-recording.yml`
- **THEN** series `job:slo_post_create_latency:slow_ratio_rate<W>` exist for `W` in {`5m`, `30m`, `1h`, `6h`, `3d`}
- **AND** each series is the ratio of `posts_create_duration_seconds_bucket{le="0.5"}` request count to the total `posts_create_duration_seconds_count`, expressed as `1 - good / total` over the window

#### Scenario: Recording-rule names follow the Prometheus convention
- **WHEN** any rule name in `slo-recording.yml` is inspected
- **THEN** the name matches the pattern `<level>:<metric>:<operation>` where `<level>` is `job`, `<metric>` is the slo identifier in snake_case, and `<operation>` describes the aggregation (e.g. `errors_ratio_rate1h`)

### Requirement: Multi-window multi-burn-rate alerts cover the API availability SLO

The API availability SLO is `99.5%` over a `30d` window. Three alert rules MUST fire from the same SLO, each correlating a long-window burn rate with a short-window burn rate so that both the trend and the freshness condition hold. Every alert SHALL carry `severity` and `slo` labels for downstream routing and grouping.

#### Scenario: Fast-burn page fires when 1h and 5m burn rates both exceed 14.4
- **WHEN** `job:slo_api_availability:errors_ratio_rate1h` exceeds `14.4 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate5m` exceeds `14.4 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilityFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="api_availability"`

#### Scenario: Slow-burn page fires when 6h and 30m burn rates both exceed 6
- **WHEN** `job:slo_api_availability:errors_ratio_rate6h` exceeds `6 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate30m` exceeds `6 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilitySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="api_availability"`

#### Scenario: Ticket alert fires when 3d and 6h burn rates both exceed 1
- **WHEN** `job:slo_api_availability:errors_ratio_rate3d` exceeds `1 * (1 - 0.995)` AND `job:slo_api_availability:errors_ratio_rate6h` exceeds `1 * (1 - 0.995)` for the alert's `for:` duration
- **THEN** the alert `ApiAvailabilityBudgetBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="ticket"` and `slo="api_availability"`

#### Scenario: No availability alert fires under steady-state synthetic traffic
- **WHEN** synthetic series feed `slo-tests.yml` with constant successful traffic and zero 5xx for 24 simulated hours
- **THEN** none of `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, or `ApiAvailabilityBudgetBurn` enter `firing` state

### Requirement: Multi-window burn-rate alerts cover the feed-read latency SLO

The feed-read latency SLO is `p95 < 200ms` over a `30d` window, modelled as a "fraction of requests slower than 200ms" SLI so the burn-rate math is symmetric to availability. Fast-page and slow-page rules MUST apply; the 3d ticket alert SHALL be omitted for latency SLOs because long-window latency slow-burn is rarely actionable at toy traffic.

#### Scenario: Fast-burn page fires for feed-read latency
- **WHEN** `job:slo_feed_read_latency:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_feed_read_latency:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `FeedReadLatencyFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="feed_read_latency"`

#### Scenario: Slow-burn page fires for feed-read latency
- **WHEN** `job:slo_feed_read_latency:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_feed_read_latency:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `FeedReadLatencySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="feed_read_latency"`

### Requirement: Multi-window burn-rate alerts cover the post-create latency SLO

The post-create latency SLO is `p95 < 500ms` over a `30d` window, modelled identically to feed-read. Fast-page and slow-page rules MUST apply; the 3d ticket alert SHALL be omitted.

#### Scenario: Fast-burn page fires for post-create latency
- **WHEN** `job:slo_post_create_latency:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_post_create_latency:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `PostCreateLatencyFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="post_create_latency"`

#### Scenario: Slow-burn page fires for post-create latency
- **WHEN** `job:slo_post_create_latency:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_post_create_latency:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `PostCreateLatencySlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"` and `slo="post_create_latency"`

### Requirement: A non-SLO backend liveness alert covers the scrape target itself

Burn-rate alerts cannot fire when the backend is offline (no samples, no ratios). A dedicated alert MUST cover the "Prometheus has lost the backend target" failure mode. This alert SHALL NOT carry an `slo` label — it is operational, not budget-based.

#### Scenario: BackendDown page fires when the scrape target is unreachable for 2 minutes
- **WHEN** `up{job="backend"} == 0` continuously for 2 minutes in Prometheus
- **THEN** the alert `BackendDown` is in `firing` state
- **AND** the alert carries `severity="page"`
- **AND** the alert does NOT carry an `slo` label

#### Scenario: BackendDown does not fire when the target reports up
- **WHEN** `up{job="backend"} == 1` continuously
- **THEN** the alert `BackendDown` is not in `firing` state

### Requirement: `promtool test rules` proves the alerting logic against synthetic series

A test fixture at `infra/observability/prometheus/rules/slo-tests.yml` MUST feed crafted time series into the recording and alerting rules and assert which alerts are in which state at which simulated time, including the value of the `runbook_url` annotation. Every alerting-rule scenario in this spec SHALL correspond to at least one stanza in the fixture. CI MUST invoke `promtool test rules` (via the pinned Prometheus image) and SHALL fail the build on any test failure.

#### Scenario: The fixture lives next to the rule files
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `slo-tests.yml` alongside `slo-recording.yml` and `slo-alerting.yml`

#### Scenario: Every spec-level alerting scenario is covered by a test stanza
- **WHEN** the fixture is read
- **THEN** for each of `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, and `BackendDown` there is at least one test that asserts the alert fires under matching synthetic input
- **AND** for `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, and `ApiAvailabilityBudgetBurn` there is at least one test that asserts no firing under steady-state successful traffic

#### Scenario: Fixture asserts the runbook_url annotation on every firing alert
- **WHEN** any alerting-rule test in `slo-tests.yml` or `fe-slo-tests.yml` declares an `exp_alerts:` entry
- **THEN** the matching `exp_annotations:` block contains a `runbook_url` key
- **AND** the `runbook_url` value matches the URL pattern declared in the alert definition (a GitHub blob path under `infra/observability/runbooks/<AlertName>.md`)

### Requirement: README documents the local alerting run loop

The repository README's observability section MUST contain an "Alerting" subsection that names the new surfaces and the commands to inspect alert delivery locally — so an operator who pulls the branch can verify the slice without reading the spec.

#### Scenario: README documents the alerting run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9093` as the Alertmanager UI and notes that Grafana's Alerting left-nav also surfaces alerts (via the provisioned Alertmanager datasource)
- **AND** the README documents the one-liner that runs `promtool test rules` against the rule files using the pinned `prom/prometheus` image
- **AND** the README mentions that a Prometheus restart is required after editing rule files for changes to take effect
- **AND** the README documents that the local `webhook-sink` container records every routed firing and the commands to inspect it (`docker compose logs webhook-sink` and the `GET /received` endpoint)
- **AND** the README documents that the `runbook_url` annotation on each alert points at a Markdown stub under `infra/observability/runbooks/` and that real incident notes are expected to grow there over time

### Requirement: A reusable `TaskDecorator` propagates MDC across thread boundaries

The backend SHALL provide a Spring `TaskDecorator` implementation in the `com.prodready.social.observability` package that, when wired onto an `Executor` / `TaskExecutor`, copies the caller thread's MDC snapshot onto each worker thread for the duration of the submitted task and clears the worker's MDC afterwards so no state leaks to the next task that pool thread runs.

The decorator MUST be a plain building block: it MUST NOT be auto-registered on any executor, and the change MUST NOT introduce a new executor bean. Any future async-capable feature is responsible for wiring the decorator on the executor it owns.

A code-level note SHALL be placed in the observability package (either a `package-info.java` or a paragraph added to an existing class's class-level Javadoc) instructing future contributors that any new `Executor`, `TaskExecutor`, or `@Async` configuration must wire this decorator or request-scoped MDC keys will disappear from worker-thread log lines.

#### Scenario: Decorator carries caller MDC onto the worker thread

- **GIVEN** the caller thread has populated MDC with `request.id` and `user.id`
- **WHEN** the caller submits a task to a `ThreadPoolTaskExecutor` whose `taskDecorator` is the new decorator
- **THEN** during task execution the worker thread's MDC contains the same `request.id` and `user.id` values as the caller
- **AND** a log statement emitted from the worker thread carries those values in its rendered ECS JSON output

#### Scenario: Worker thread MDC is empty after the task completes

- **GIVEN** a `ThreadPoolTaskExecutor` wired with the decorator has executed a task with non-empty MDC propagated from the caller
- **WHEN** the task completes (normally or by throwing)
- **THEN** the worker thread's MDC is empty
- **AND** a subsequent task submitted to the same worker thread observes an empty MDC at start unless its own caller had MDC populated at submit time

#### Scenario: Caller thread MDC is unaffected by submission

- **GIVEN** the caller thread has populated MDC with `request.id` and `user.id`
- **WHEN** the caller submits one or more tasks via an executor wired with the decorator
- **THEN** the caller thread's MDC values remain unchanged before, during, and after submission, including after the worker tasks complete

#### Scenario: Decorator is a building block, not an active bean

- **WHEN** the application context starts at the time this change lands
- **THEN** no production `Executor`, `TaskExecutor`, or `@EnableAsync` configuration is introduced or modified by this change
- **AND** the decorator class exists in the observability package available for future features to wire when they introduce an executor

#### Scenario: Package-level note documents the requirement

- **WHEN** a contributor reads the observability package's class-level documentation (either `package-info.java` or the Javadoc of a chosen existing class in that package)
- **THEN** they encounter a note stating that any new `Executor` / `TaskExecutor` / `@Async` configuration must wire the MDC decorator
- **AND** the note explains the consequence (request-scoped MDC keys disappear from worker-thread logs)

### Requirement: Backend `/actuator/prometheus` endpoint emits OpenMetrics exemplars on the `http.server.requests` histogram

The Spring Boot backend SHALL be configured so that its `/actuator/prometheus` endpoint can serve responses in OpenMetrics text format (`application/openmetrics-text`) and SHALL include exemplar lines on each histogram bucket of `http_server_requests_seconds_bucket` whenever a sample was recorded while an OTel span was active.

Each exemplar line SHALL carry a label named `trace_id` whose value is the 32-lowercase-hex W3C trace id of the active span at sample time. Exemplar lines SHALL also include a `span_id` label (16-lowercase-hex) when the active span context provides one.

The exemplar emission SHALL rely on the Spring Boot Actuator's built-in path: `PrometheusMetricsExportAutoConfiguration` constructs `PrometheusMeterRegistry` with an `ObjectProvider<io.prometheus.metrics.tracer.common.SpanContext>` and queries the bean (when present) on every observation. No bespoke per-meter instrumentation code SHALL be required at recording sites.

The exemplar emission SHALL be enabled by either an Actuator property under `management.*` or by a `@Configuration`-class-registered `SpanContext` bean — whichever the pinned Spring Boot version requires. Under Spring Boot 4.0.6 (the pinned version) no exemplar property exists; emission triggers on bean presence. The smallest dependency providing an OTel-agent-aware `SpanContext` (`io.prometheus:prometheus-metrics-tracer-otel-agent`, shaded against the agent's bootstrap OTel API) MAY be added to the runtime classpath — it is not transitively present via `micrometer-registry-prometheus`.

#### Scenario: OpenMetrics scrape against a running backend returns exemplar lines
- **GIVEN** the backend is running with the OTel Java agent attached and at least one HTTP request has been served while a span was active
- **WHEN** an operator issues `curl -H 'Accept: application/openmetrics-text; version=1.0.0' http://localhost:8080/actuator/prometheus`
- **THEN** the response body contains at least one line of the form `http_server_requests_seconds_bucket{...,le="..."} <count> # {trace_id="<32-hex>"} <value> <timestamp>` for the served request

#### Scenario: Plain Prometheus exposition still works for non-OpenMetrics consumers
- **GIVEN** the backend is running
- **WHEN** an operator issues `curl -H 'Accept: text/plain; version=0.0.4' http://localhost:8080/actuator/prometheus`
- **THEN** the response is valid Prometheus text exposition with no `#` exemplar lines and is accepted by `promtool check metrics`

#### Scenario: Samples recorded outside any active span carry no exemplar
- **GIVEN** the backend records a histogram observation with no OTel span on the current thread
- **WHEN** Prometheus next scrapes the endpoint
- **THEN** the corresponding bucket line in the response carries no exemplar suffix

### Requirement: Prometheus container has exemplar storage enabled and scrapes the backend in OpenMetrics format

The `prometheus` service in `docker-compose.yml` SHALL launch with `--enable-feature=exemplar-storage` in its `command:` array, preserving the image's default config and storage flags (so scrape config and TSDB path continue to resolve).

Prometheus SHALL store at least the default exemplar storage capacity (100,000 exemplars) in memory. No additional retention tuning is required by this slice.

The `backend` scrape job in `infra/observability/prometheus/prometheus.yml` SHALL be configured so that it negotiates the OpenMetrics content type from the Actuator endpoint (i.e. exemplars are not stripped by the scrape).

#### Scenario: Prometheus exposes exemplars via the query_exemplars API
- **GIVEN** Prometheus has been running for at least one scrape interval after the backend has served a request under an active span
- **WHEN** an operator issues `curl 'http://localhost:9090/api/v1/query_exemplars?query=http_server_requests_seconds_bucket&start=<NOW-5m>&end=<NOW>'`
- **THEN** the response JSON has `status=success` and `data` contains at least one exemplar object whose `labels` map includes a `trace_id` key with a 32-hex value

#### Scenario: Prometheus restart with the feature flag present yields no startup error
- **GIVEN** the docker-compose file has `--enable-feature=exemplar-storage` in the `prometheus` service `command:`
- **WHEN** `docker-compose --profile observability up -d prometheus` is run from a clean state
- **THEN** the container reaches a running state and `curl http://localhost:9090/-/ready` returns HTTP 200 within 30 seconds

### Requirement: Grafana Prometheus datasource provisioning links exemplars to the Tempo datasource

The provisioned datasource file `infra/observability/grafana/provisioning/datasources/prometheus.yaml` SHALL declare `jsonData.exemplarTraceIdDestinations` with at minimum one entry whose `name` is `trace_id` and whose `datasourceUid` is `tempo` (the UID under which the Tempo datasource is provisioned per slice 5).

The datasource entry SHALL retain `editable: false` so a Grafana UI edit cannot drift the wiring.

The Grafana container SHALL be restarted to pick up the provisioning change; this requirement SHALL be documented in the slice README delta.

#### Scenario: Grafana datasource API reports the exemplar link
- **GIVEN** Grafana has been (re)started after the provisioning change
- **WHEN** an operator issues `curl -u admin:admin http://localhost:3000/api/datasources/name/Prometheus`
- **THEN** the response JSON contains `jsonData.exemplarTraceIdDestinations` whose entries include `{ "name": "trace_id", "datasourceUid": "tempo" }`

### Requirement: `backend-overview` dashboard enables exemplars on the request-latency panel

The dashboard JSON at `infra/observability/grafana/dashboards/backend-overview.json` SHALL set `options.exemplar = true` (or the panel-schema-current key for "show exemplars") on exactly one panel — the panel whose primary query is the `http_server_requests_seconds_bucket` latency histogram for backend HTTP requests.

Enabling exemplars on other panels is out of scope for this slice and SHALL NOT be done as part of this change.

#### Scenario: Grafana dashboard loads with exemplars enabled on the latency panel
- **GIVEN** Grafana has been (re)started with the updated dashboard JSON
- **WHEN** an operator opens the `Backend overview` dashboard
- **THEN** the request-latency histogram panel renders with exemplar diamonds when at least one matching exemplar exists in the visible time window
- **AND** clicking a diamond opens a panel pivot UI offering "Query with Tempo" using the exemplar's `trace_id`

### Requirement: End-to-end test proves the request → exemplar → trace pivot

A Playwright spec at `e2e/tests/observability.metric-exemplars.spec.ts` SHALL drive a single authenticated `POST /api/v1/posts` request from a real browser session and SHALL assert the metric→trace pivot end-to-end.

The test SHALL:
- authenticate, then issue the post-create call (re-authenticating if the slow setup risks the 2-second access-token TTL),
- poll the Prometheus exemplar API `http://localhost:9090/api/v1/query_exemplars` for `http_server_requests_seconds_bucket{uri=~".*/api/v1/posts"}` within a 60-second budget at 1-second intervals,
- on success, extract a `trace_id` from a returned exemplar,
- GET `http://localhost:3200/api/traces/<traceId>` and assert the returned trace contains at least one span whose `resource.service.name` equals `backend`.

The test SHALL be skipped (not failed) when the observability profile is not running; the slice README delta SHALL document the run loop.

#### Scenario: Posting once yields an exemplar that resolves in Tempo
- **GIVEN** the observability profile is up (Prometheus, Tempo, Collector, Grafana) and the backend is running under the OTel Java agent
- **WHEN** the test issues one authenticated `POST /api/v1/posts`
- **THEN** within 60 seconds the Prometheus exemplar API returns at least one exemplar whose `trace_id` label is a 32-hex string
- **AND** within a further 30 seconds the Tempo trace at that id contains at least one `resource.service.name=backend` span

#### Scenario: Observability profile down → test is skipped
- **GIVEN** the docker-compose observability profile is not running (Prometheus or Tempo is unreachable)
- **WHEN** the spec runs
- **THEN** the spec is marked skipped with a message naming the unreachable service, and the test run does not fail

### Requirement: README documents the local exemplar run loop and known constraints

The slice's contribution to the project README (or its observability subsection) SHALL document:
- the `docker-compose --profile observability` run loop required to exercise exemplars locally,
- the Grafana restart requirement when the Prometheus datasource provisioning changes,
- the click-path: `Backend overview → request latency panel → click an exemplar diamond → Tempo trace view`,
- the FE-exemplars deferral (one sentence is sufficient: the Collector's prometheus exporter does not synthesize exemplars from FE OTLP histograms in this slice).

#### Scenario: README enumerates the click-path and the restart caveat
- **WHEN** a reader follows the README's observability section after this slice lands
- **THEN** the reader is told how to bring the stack up, where to click in Grafana to see exemplars, and that a Grafana restart is required when datasource provisioning changes
- **AND** the FE-exemplars deferral is mentioned in one sentence so the absence is not surprising

### Requirement: Frontend Web Vitals histograms carry explicit bucket boundaries aligned with SLO thresholds

The `frontend/src/observability/meter.ts` module SHALL configure the OTel `web_vitals_lcp` and `web_vitals_inp` Histogram instruments with explicit bucket boundaries that include the slice's SLO thresholds (2500 ms for LCP, 200 ms for INP), so that the Prometheus recording rules can read precise slow-fraction series via the `le="2500"` and `le="200"` buckets. The boundaries SHALL be set via the OTel JS SDK's instrument-level explicit-bucket mechanism (per-instrument `advice.explicitBucketBoundaries`, or an equivalent `view` registered on the `MeterProvider` configured with `ExplicitBucketHistogramAggregation`).

The bucket boundaries SHALL be:

- `web_vitals_lcp`: `[500, 1000, 1500, 2000, 2500, 3500, 5000, 7500, 10000]` (milliseconds)
- `web_vitals_inp`: `[25, 50, 75, 100, 150, 200, 300, 500, 1000]` (milliseconds)

The `web_vitals_cls`, `web_vitals_fcp`, and `web_vitals_ttfb` instruments SHALL keep the OTel SDK default boundaries — this slice does not modify their histogram grid.

#### Scenario: LCP histogram exposes a `le="2500"` bucket at the Collector scrape endpoint

- **GIVEN** the observability profile is up and metrics are enabled in the browser
- **AND** at least one browser session has loaded the app and the OTel metrics exporter has flushed
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response body contains at least one line matching `web_vitals_lcp_bucket{...,le="2500",...}` with `service_name="frontend"`

#### Scenario: INP histogram exposes a `le="200"` bucket at the Collector scrape endpoint

- **GIVEN** the observability profile is up and metrics are enabled in the browser
- **AND** at least one interaction has been recorded by the `web-vitals` `onINP` callback
- **AND** the OTel metrics exporter has flushed
- **WHEN** a reader issues `GET http://localhost:8889/metrics`
- **THEN** the response body contains at least one line matching `web_vitals_inp_bucket{...,le="200",...}` with `service_name="frontend"`

#### Scenario: Bucket boundaries are configured at the instrument or view level, not as a manual histogram-record loop

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** the LCP and INP histograms are configured with explicit boundaries via either an `advice` parameter on the Histogram instrument or a `View` registered on the `MeterProvider` with `ExplicitBucketHistogramAggregation`
- **AND** no per-callback bucket math is performed in user space

#### Scenario: CLS, FCP, TTFB histograms remain unmodified by this slice

- **WHEN** a reader inspects `frontend/src/observability/meter.ts`
- **THEN** no explicit bucket boundaries are configured for the `web_vitals_cls`, `web_vitals_fcp`, or `web_vitals_ttfb` instruments

### Requirement: Frontend SLO recording rules compute LCP and INP slow-fractions over canonical windows

A Prometheus rule file at `infra/observability/prometheus/rules/fe-slo-recording.yml` SHALL declare recording rules that compute per-SLO slow-request ratios for the two frontend timing SLOs (LCP, INP) over the canonical windows used by the multi-window burn-rate alerts. Recording-rule names SHALL follow the Prometheus `<level>:<metric>:<operation>` convention and SHALL keep the `job:` prefix for symmetry with backend SLO recording rules, even though the underlying samples carry `job="collector"`. Rule expressions SHALL filter on `service_name="frontend"`.

#### Scenario: LCP slow-fraction is recorded at every required window

- **WHEN** Prometheus evaluates `fe-slo-recording.yml`
- **THEN** series `job:slo_lcp:slow_ratio_rate<W>` exist (one sample per evaluation interval) for `W` in {`5m`, `30m`, `1h`, `6h`}
- **AND** each series is defined as `1 - (sum(rate(web_vitals_lcp_bucket{service_name="frontend", le="2500"}[<window>])) / sum(rate(web_vitals_lcp_count{service_name="frontend"}[<window>])))`

#### Scenario: INP slow-fraction is recorded at every required window

- **WHEN** Prometheus evaluates `fe-slo-recording.yml`
- **THEN** series `job:slo_inp:slow_ratio_rate<W>` exist (one sample per evaluation interval) for `W` in {`5m`, `30m`, `1h`, `6h`}
- **AND** each series is defined as `1 - (sum(rate(web_vitals_inp_bucket{service_name="frontend", le="200"}[<window>])) / sum(rate(web_vitals_inp_count{service_name="frontend"}[<window>])))`

#### Scenario: Recording-rule names follow the Prometheus convention

- **WHEN** any rule name in `fe-slo-recording.yml` is inspected
- **THEN** the name matches the pattern `job:<slo identifier>:slow_ratio_rate<window>` where `<slo identifier>` is `slo_lcp` or `slo_inp`

### Requirement: Multi-window burn-rate alerts cover the LCP SLO

The LCP SLO is `95% of page loads have web_vitals_lcp < 2500 ms` over a `30d` window. Two alert rules SHALL fire from this SLO — a fast-burn and a slow-burn page — each correlating a long-window burn rate with a short-window burn rate. Every alert SHALL carry `severity`, `slo`, and `service` labels for downstream routing and grouping. The 3d ticket alert is omitted, matching the backend latency SLOs.

#### Scenario: Fast-burn page fires when 1h and 5m burn rates both exceed 14.4

- **WHEN** `job:slo_lcp:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_lcp:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `LcpSloFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="lcp"`, and `service="frontend"`

#### Scenario: Slow-burn page fires when 6h and 30m burn rates both exceed 6

- **WHEN** `job:slo_lcp:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_lcp:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `LcpSloSlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="lcp"`, and `service="frontend"`

#### Scenario: No LCP alert fires under steady-state synthetic traffic

- **WHEN** synthetic series feed `fe-slo-tests.yml` with constant fast-LCP traffic (all samples within `le="2500"`) for 24 simulated hours
- **THEN** neither `LcpSloFastBurn` nor `LcpSloSlowBurn` enters `firing` state

### Requirement: Multi-window burn-rate alerts cover the INP SLO

The INP SLO is `95% of interactions have web_vitals_inp < 200 ms` over a `30d` window. Two alert rules SHALL fire from this SLO — a fast-burn and a slow-burn page — using the same burn-rate constants as the LCP SLO. Every alert SHALL carry `severity`, `slo`, and `service` labels. The 3d ticket alert is omitted.

#### Scenario: Fast-burn page fires when 1h and 5m INP burn rates both exceed 14.4

- **WHEN** `job:slo_inp:slow_ratio_rate1h` exceeds `14.4 * (1 - 0.95)` AND `job:slo_inp:slow_ratio_rate5m` exceeds `14.4 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `InpSloFastBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="inp"`, and `service="frontend"`

#### Scenario: Slow-burn page fires when 6h and 30m INP burn rates both exceed 6

- **WHEN** `job:slo_inp:slow_ratio_rate6h` exceeds `6 * (1 - 0.95)` AND `job:slo_inp:slow_ratio_rate30m` exceeds `6 * (1 - 0.95)` for the alert's `for:` duration
- **THEN** the alert `InpSloSlowBurn` is in `firing` state in Prometheus
- **AND** the alert carries the labels `severity="page"`, `slo="inp"`, and `service="frontend"`

#### Scenario: No INP alert fires under steady-state synthetic traffic

- **WHEN** synthetic series feed `fe-slo-tests.yml` with constant fast-INP traffic (all samples within `le="200"`) for 24 simulated hours
- **THEN** neither `InpSloFastBurn` nor `InpSloSlowBurn` enters `firing` state

### Requirement: `promtool test rules` proves the frontend SLO alerting logic against synthetic series

A test fixture at `infra/observability/prometheus/rules/fe-slo-tests.yml` SHALL feed crafted time series into the FE recording and alerting rules and assert which alerts are in which state at which simulated time. Every alerting-rule scenario for the FE SLOs in this spec SHALL correspond to at least one stanza in the fixture. CI SHALL run `promtool test rules` against this fixture (alongside the existing backend `slo-tests.yml`) and SHALL fail the build on any test failure.

#### Scenario: The fixture lives next to the rule files

- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `fe-slo-tests.yml` alongside `fe-slo-recording.yml`, `fe-slo-alerting.yml`, and the existing backend rule files

#### Scenario: Every FE-SLO alerting scenario is covered by a test stanza

- **WHEN** the fixture is read
- **THEN** for each of `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` there is at least one test stanza that asserts the alert fires under matching synthetic input
- **AND** for each of those alerts there is at least one steady-state stanza that asserts no firing

#### Scenario: CI runs the FE rule tests and fails on a regression

- **WHEN** CI runs against a branch where any FE SLO alert no longer fires (or fires spuriously) for its covered scenario
- **THEN** the `promtool test rules` step exits non-zero and the build fails
- **AND** the failure points at the specific test stanza that regressed

### Requirement: README documents the frontend SLO surface

The repository's root `README.md` Frontend RUM subsection (added in slice 6) SHALL gain a paragraph naming the four FE SLO alerts (`LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`), citing their SLO targets (LCP 95% < 2500 ms, INP 95% < 200 ms over 30 d), pointing at the SLO row of the `Frontend overview` dashboard, and reminding the operator that Prometheus needs a restart after editing rule files (mirroring the guidance from the slice 8 alerting subsection).

#### Scenario: README cites the four FE alert names

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text contains the literal strings `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` (each at least once)

#### Scenario: README cites the SLO targets

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text mentions the literal strings `95%`, `2500`, and `200` in the context of the LCP and INP SLOs

#### Scenario: README reminds the operator that Prometheus needs a restart after rule changes

- **WHEN** a reader inspects the README's Frontend RUM subsection
- **THEN** the text states that Prometheus must be restarted for `rule_files:` changes to take effect

### Requirement: Webhook sink service is provisioned under the `observability` docker-compose profile

A single `webhook-sink` service runs under the `observability` docker-compose profile. It is the canonical local-dev destination for routed Alertmanager firings, standing in for a real PagerDuty / Opsgenie / Slack receiver. The container image MUST be built from sources tracked in the repository at `infra/observability/webhook-sink/`, with a multi-stage Dockerfile pinned to a specific base image tag.

#### Scenario: Observability profile starts the webhook sink container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-webhook-sink` container is started in addition to the other observability containers
- **AND** the container exposes its HTTP server on host port `8081` (mapped to container port `8080`)
- **AND** Alertmanager reaches the sink at `http://webhook-sink:8080` on the shared docker network

#### Scenario: Webhook sink source code lives in the repository
- **WHEN** the `infra/observability/webhook-sink/` directory is listed
- **THEN** it contains a server source file, a `package.json` (or equivalent dependency manifest), a `Dockerfile`, and a short `README.md` describing the container's contract
- **AND** the `Dockerfile` is multi-stage (a build stage followed by a thin runtime stage) and pins its base image to an explicit tag (not `latest`)

#### Scenario: Default invocation does not start the webhook sink
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-webhook-sink` container is NOT started (the service is gated by the `observability` profile)

### Requirement: Webhook sink exposes severity-keyed delivery endpoints and a queryable received-payload surface

The webhook sink container MUST accept Alertmanager webhook payloads on two severity-keyed paths and expose a query surface that tests can use to assert which payloads were received in what order.

#### Scenario: Page endpoint accepts Alertmanager webhook payloads
- **WHEN** an HTTP `POST` is made to `http://webhook-sink:8080/page` with an Alertmanager webhook JSON body (`receiver`, `status`, `alerts: [...]`)
- **THEN** the sink responds with HTTP `2xx`
- **AND** the payload is appended to the sink's in-memory ring of received payloads, tagged with the receiving path (`page`) and a server-side receive timestamp

#### Scenario: Ticket endpoint accepts Alertmanager webhook payloads
- **WHEN** an HTTP `POST` is made to `http://webhook-sink:8080/ticket` with an Alertmanager webhook JSON body
- **THEN** the sink responds with HTTP `2xx`
- **AND** the payload is appended to the sink's in-memory ring tagged with `ticket`

#### Scenario: Received-payloads endpoint returns a queryable view
- **WHEN** an HTTP `GET` is made to `http://webhook-sink:8080/received`
- **THEN** the sink responds with HTTP `200` and a JSON body containing every payload in the ring, in receive order, each annotated with its receiving path and receive timestamp
- **AND** the response supports an `?after=<unix-millis>` query parameter that filters out payloads received before the given timestamp

#### Scenario: In-memory ring is bounded
- **WHEN** more payloads are received than the configured ring capacity
- **THEN** the oldest payloads are dropped silently
- **AND** the ring capacity is at least 64 (large enough that an interactive session in parallel with an e2e test does not crowd out the test's payloads inside one test run)

### Requirement: Every backend and frontend alert carries a `runbook_url` annotation

Every alerting rule defined under `infra/observability/prometheus/rules/` MUST include a `runbook_url` annotation pointing at a Markdown file under `infra/observability/runbooks/`. This is the contract that an on-call person who gets paged has a triage entry point.

#### Scenario: Backend SLO and liveness alerts declare a runbook_url annotation
- **WHEN** `infra/observability/prometheus/rules/slo-alerting.yml` is loaded
- **THEN** each of the alerts `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, and `BackendDown` declares an `annotations.runbook_url:` field
- **AND** the value is a GitHub blob URL whose path component ends in `/infra/observability/runbooks/<AlertName>.md` (matching the alert's `alert:` name exactly)

#### Scenario: Frontend SLO alerts declare a runbook_url annotation
- **WHEN** `infra/observability/prometheus/rules/fe-slo-alerting.yml` is loaded
- **THEN** each of the alerts `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` declares an `annotations.runbook_url:` field
- **AND** the value is a GitHub blob URL whose path component ends in `/infra/observability/runbooks/<AlertName>.md`

### Requirement: Per-alert runbook stubs live under `infra/observability/runbooks/`

The repository MUST carry one Markdown runbook stub per alert defined in the rule files. Each stub is short (one screen, not a long-form document) and establishes the contract that real incident learnings have a home in the repo.

#### Scenario: Every alert has a runbook stub at the expected path
- **WHEN** the `infra/observability/runbooks/` directory is listed
- **THEN** it contains exactly the files `ApiAvailabilityFastBurn.md`, `ApiAvailabilitySlowBurn.md`, `ApiAvailabilityBudgetBurn.md`, `FeedReadLatencyFastBurn.md`, `FeedReadLatencySlowBurn.md`, `PostCreateLatencyFastBurn.md`, `PostCreateLatencySlowBurn.md`, `BackendDown.md`, `LcpSloFastBurn.md`, `LcpSloSlowBurn.md`, `InpSloFastBurn.md`, and `InpSloSlowBurn.md`

#### Scenario: Each runbook stub declares the canonical sections
- **WHEN** any of the runbook stub files is opened
- **THEN** the file contains H2 (or H1) headings for `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in that order)
- **AND** every heading has at least one non-empty paragraph or bullet beneath it (no empty section)

### Requirement: End-to-end test proves the routing → webhook delivery → inhibition pipeline

An end-to-end test under `e2e/tests/observability.alerting.spec.ts` MUST prove that a synthetic alert POSTed to Alertmanager's `/api/v2/alerts` endpoint is routed to the correct webhook-sink path according to its `severity` label, that the alert's `runbook_url` annotation is preserved through routing, and that the BackendDown→SLO inhibition rule suppresses SLO alerts when BackendDown is also firing. The spec MUST self-skip when the observability profile is not running.

#### Scenario: Page-severity alert is routed to the page endpoint
- **WHEN** the spec POSTs a synthetic alert with `labels.severity="page"` and `annotations.runbook_url="<some-url>"` to `http://localhost:9093/api/v2/alerts`
- **THEN** the spec observes a matching payload at `GET http://localhost:8081/received?after=<test-start>` on the `/page` path within a 30-second polling budget
- **AND** the payload's `alerts[].annotations.runbook_url` equals the value originally POSTed

#### Scenario: Ticket-severity alert is routed to the ticket endpoint
- **WHEN** the spec POSTs a synthetic alert with `labels.severity="ticket"`
- **THEN** the spec observes a matching payload at `GET http://localhost:8081/received` on the `/ticket` path within the same polling budget
- **AND** no payload is observed on the `/page` path for that alert

#### Scenario: BackendDown inhibits SLO alerts
- **WHEN** the spec POSTs a `BackendDown` alert and an `ApiAvailabilityFastBurn` alert together (both with `severity="page"`) and waits for the polling budget plus Alertmanager's `group_wait` (10s)
- **THEN** the spec observes the `BackendDown` payload at the `/page` path
- **AND** the spec does NOT observe the `ApiAvailabilityFastBurn` payload at either path while the `BackendDown` alert is still active

#### Scenario: Spec self-skips when the observability profile is not running
- **WHEN** the spec's `beforeAll` cannot reach `http://localhost:9093/-/ready` or `http://localhost:8081/healthz` within a short probe timeout
- **THEN** every test in the file is marked skipped (not failed)
- **AND** the skip reason names which surface was unreachable

### Requirement: Postgres loads the `pg_stat_statements` shared library at startup

The `postgres` service in `docker-compose.yml` SHALL be configured so the running Postgres process loads the `pg_stat_statements` extension library at startup. The mechanism SHALL be a `command:` override on the service that sets `shared_preload_libraries=pg_stat_statements` (other server defaults preserved). The `postgres:16-alpine` image already ships the library, so no image change is required.

#### Scenario: docker-compose declares the shared_preload_libraries override
- **WHEN** a reader inspects the `postgres` service definition in `docker-compose.yml`
- **THEN** the service declares a `command:` (or equivalent) that runs `postgres` with `-c shared_preload_libraries=pg_stat_statements`
- **AND** the override is present unconditionally (not gated by the `observability` profile — the library is cheap to load and the extension is only exercised when the exporter scrapes it)

#### Scenario: Running container exposes the extension as installed
- **WHEN** an operator runs `docker compose exec postgres psql -U <app-user> -d social -c "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'"` against a fresh data directory
- **THEN** the query returns exactly one row whose `extname` is `pg_stat_statements`

### Requirement: A first-boot init script creates the `pg_stat_statements` extension

The repository SHALL provide a SQL init script at `infra/observability/postgres/init/01-pg-stat-statements.sql` that runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`. The script SHALL be mounted into the postgres container at `/docker-entrypoint-initdb.d/01-pg-stat-statements.sql` (read-only) so the official `postgres` image executes it on first boot against an empty data directory.

#### Scenario: Init script file exists in the repository
- **WHEN** a reader inspects `infra/observability/postgres/init/`
- **THEN** it contains a file named `01-pg-stat-statements.sql`
- **AND** the file's contents include exactly the SQL statement `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` (whitespace and comments allowed)

#### Scenario: docker-compose mounts the init script into the postgres container
- **WHEN** a reader inspects the `postgres` service's `volumes:` block in `docker-compose.yml`
- **THEN** there is a bind mount of `./infra/observability/postgres/init/01-pg-stat-statements.sql` to `/docker-entrypoint-initdb.d/01-pg-stat-statements.sql`
- **AND** the mount is read-only (`:ro`)

#### Scenario: Init script runs on first boot against an empty data directory
- **WHEN** an operator runs `docker compose down -v && docker compose up -d postgres`
- **THEN** the official Postgres entrypoint executes the mounted init script during initialisation
- **AND** subsequent queries against the `social` database can see the `pg_stat_statements_*` system views without further action

### Requirement: `postgres-exporter` is provisioned under the `observability` docker-compose profile

A single `postgres-exporter` service runs under the `observability` profile, exposing Prometheus-format metrics about the running Postgres instance on port `9187`. The container image SHALL be `quay.io/prometheuscommunity/postgres-exporter` pinned to an explicit tag (not `latest`). The exporter SHALL authenticate to Postgres using the same credentials the application uses in dev (a future production deploy would split this to a `pg_monitor`-granted role).

#### Scenario: Observability profile starts the postgres-exporter container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-postgres-exporter` container is started in addition to the other observability containers
- **AND** the container's `/metrics` endpoint is reachable from the prometheus container at `http://postgres-exporter:9187/metrics`

#### Scenario: Default invocation does not start postgres-exporter
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-postgres-exporter` container is NOT started

#### Scenario: postgres-exporter image is pinned by tag
- **WHEN** the docker-compose `postgres-exporter` service definition is read
- **THEN** the `image:` field is `quay.io/prometheuscommunity/postgres-exporter:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: postgres-exporter is configured to connect to the local postgres
- **WHEN** the docker-compose `postgres-exporter` service definition is read
- **THEN** it declares a `DATA_SOURCE_URI` (or equivalent split env vars `DATA_SOURCE_USER` / `DATA_SOURCE_PASS` / `DATA_SOURCE_NAME`) that targets the local `postgres` service on the shared docker network
- **AND** the service declares `depends_on: [postgres]` so the exporter does not start before Postgres is ready

### Requirement: `postgres-exporter` projects `pg_stat_statements` via a custom-queries file

The repository SHALL include `infra/observability/postgres-exporter/queries.yaml` declaring custom-query projections that surface a curated subset of `pg_stat_statements` columns as Prometheus metrics. The file SHALL be mounted into the postgres-exporter container and referenced via the `--extend.query-path` flag (or `PG_EXPORTER_EXTEND_QUERY_PATH` env var). The set of columns surfaced SHALL be bounded to keep Prometheus label cardinality manageable.

#### Scenario: Custom-queries file exists and declares pg_stat_statements projection
- **WHEN** a reader inspects `infra/observability/postgres-exporter/queries.yaml`
- **THEN** the file declares a metric set named `pg_stat_statements` (or equivalent identifier) that projects per-statement counters
- **AND** the projected metrics include `calls`, `total_exec_time`, `mean_exec_time`, and `rows`
- **AND** the SQL underlying the projection truncates the `query` text to at most 200 characters (to bound label cardinality)
- **AND** the SQL limits the row set surfaced to at most the top 100 statements by `total_exec_time` (to bound emitted-series count)

#### Scenario: docker-compose mounts the custom-queries file and configures the exporter to load it
- **WHEN** a reader inspects the `postgres-exporter` service in `docker-compose.yml`
- **THEN** the service mounts `./infra/observability/postgres-exporter/queries.yaml` into the container (path consistent with the exporter's expectations) read-only
- **AND** the service is configured (via flag or env var) to load that file as its extend-query path

### Requirement: Prometheus scrapes `postgres-exporter` as a new job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL include a scrape job for the postgres-exporter container. The job SHALL be additive to the existing scrape jobs (the existing `backend` and `collector` jobs are unchanged in name, target, and interval).

#### Scenario: Prometheus config declares the postgres-exporter scrape job
- **WHEN** a reader inspects `infra/observability/prometheus/prometheus.yml`
- **THEN** `scrape_configs:` contains an entry with `job_name: postgres-exporter`
- **AND** the entry targets `postgres-exporter:9187`
- **AND** the entry's `scrape_interval` is `15s` (matching the existing `backend` job)
- **AND** the entry's `metrics_path` is `/metrics` (the exporter's default)

#### Scenario: Prometheus scrapes the exporter when the observability profile is up
- **WHEN** the `observability` profile is running and a reader queries `http://localhost:9090/api/v1/targets`
- **THEN** the `postgres-exporter` target appears with `health: "up"` after one scrape interval

### Requirement: Grafana provisions a `Database overview` dashboard

The repository SHALL include `infra/observability/grafana/dashboards/database-overview.json` declaring a Grafana dashboard that visualises Postgres internals. The dashboard SHALL be picked up automatically by the existing dashboards-provisioning glob (no provisioning YAML change required). Panels SHALL be sourced from `postgres-exporter` metrics; no panel SHALL require ad-hoc PromQL knowledge from the operator to read.

#### Scenario: Dashboard JSON file exists alongside the existing siblings
- **WHEN** a reader inspects `infra/observability/grafana/dashboards/`
- **THEN** it contains `database-overview.json` alongside `backend-overview.json` and `frontend-overview.json`

#### Scenario: Dashboard contains the core panel set
- **WHEN** Grafana loads the dashboard
- **THEN** the dashboard contains at least one panel each for: connection count vs. `max_connections`, transactions per second (commit and rollback), cache hit ratio, tuples affected (insert/update/delete/fetch), deadlock rate, database size, and a top-N table of slow queries from `pg_stat_statements`

#### Scenario: Slow-query table draws from pg_stat_statements custom-queries series
- **WHEN** a reader inspects the slow-query table panel
- **THEN** the panel's PromQL queries reference series projected from `pg_stat_statements` (e.g. `pg_stat_statements_calls_total`, `pg_stat_statements_total_exec_time_seconds_total`, or equivalent names emitted by the custom-queries file)
- **AND** the table is ordered by total execution time across the dashboard time range, descending

### Requirement: Database alert rules live in `infra/observability/prometheus/rules/database-alerts.yml`

The repository SHALL include a Prometheus rules file at `infra/observability/prometheus/rules/database-alerts.yml` declaring database-tier infra alerts. The file SHALL be loaded by Prometheus via the existing `rule_files:` glob in `prometheus.yml` (no glob change required).

#### Scenario: Rules file exists in the expected directory
- **WHEN** a reader inspects `infra/observability/prometheus/rules/`
- **THEN** it contains `database-alerts.yml` alongside the existing SLO rule files

#### Scenario: Prometheus loads the rules at startup
- **WHEN** Prometheus starts with the observability profile up
- **THEN** `http://localhost:9090/api/v1/rules` reports the `database-alerts` rule group with at least the alerts named in this spec

### Requirement: A `PostgresConnectionSaturation` alert covers connection pressure

The repository's `database-alerts.yml` SHALL declare an alerting rule named `PostgresConnectionSaturation` that fires when the running Postgres approaches its connection limit. The alert SHALL carry severity `page` (so it routes via the existing severity tree from slice 11 to the page-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/PostgresConnectionSaturation.md`.

#### Scenario: Alert is declared with the saturation expression
- **WHEN** a reader inspects `database-alerts.yml`
- **THEN** the file declares an alert named `PostgresConnectionSaturation`
- **AND** the alert's `expr` measures the ratio `pg_stat_database_numbackends{datname="social"} / on() pg_settings_max_connections` exceeding `0.8`
- **AND** the alert's `for:` clause is `5m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `PostgresConnectionSaturation` alert
- **THEN** the alert's `labels:` block contains `severity: page`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/PostgresConnectionSaturation.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description`

### Requirement: A `PostgresDeadlocks` alert covers deadlock occurrences

The repository's `database-alerts.yml` SHALL declare an alerting rule named `PostgresDeadlocks` that fires when one or more deadlocks are recorded by Postgres in the recent 5-minute window. The alert SHALL carry severity `ticket` (routing to the ticket-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/PostgresDeadlocks.md`.

#### Scenario: Alert is declared with the deadlock-rate expression
- **WHEN** a reader inspects `database-alerts.yml`
- **THEN** the file declares an alert named `PostgresDeadlocks`
- **AND** the alert's `expr` is `increase(pg_stat_database_deadlocks{datname="social"}[5m]) > 0` (the v0.17.x exporter emits `pg_stat_database_deadlocks` without a `_total` suffix; the test fixture below pins the exact name)
- **AND** the alert has no `for:` clause (single occurrence is sufficient to file a ticket)

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `PostgresDeadlocks` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/PostgresDeadlocks.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description`

### Requirement: Runbook stubs exist for the two database alerts

The repository SHALL include Markdown runbook stubs at `infra/observability/runbooks/PostgresConnectionSaturation.md` and `infra/observability/runbooks/PostgresDeadlocks.md`, matching the shape of the slice-11 stubs (Symptoms / Impact / Triage / Mitigation / Escalation).

#### Scenario: Stubs exist with the canonical section shape
- **WHEN** a reader inspects `infra/observability/runbooks/`
- **THEN** the directory contains `PostgresConnectionSaturation.md` and `PostgresDeadlocks.md`
- **AND** each file contains the section headings `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in any reasonable order and heading level)

### Requirement: `promtool test rules` covers the database alerts

The repository SHALL include `infra/observability/prometheus/rules/database-tests.yml` exercising both database alerts against synthetic series. The fixture SHALL be discovered by the existing `promtool test rules` invocation that already covers the SLO rule tests. The fixture SHALL assert both the firing condition and the presence of the `runbook_url` annotation.

#### Scenario: Test fixture lives next to the rule file
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `database-tests.yml` alongside `database-alerts.yml`

#### Scenario: Each database alert has at least one fires-as-expected test case
- **WHEN** the fixture is read
- **THEN** `PostgresConnectionSaturation` has a stanza feeding synthetic `pg_stat_database_numbackends` and `pg_settings_max_connections` series that drive the ratio above 0.8 for at least 5 minutes, and asserts the alert is in `firing` state at that simulated time with `severity: page` and a non-empty `runbook_url` annotation
- **AND** `PostgresDeadlocks` has a stanza feeding a synthetic `pg_stat_database_deadlocks_total` series that increases by at least 1 within a 5-minute window, and asserts the alert is in `firing` state with `severity: ticket` and a non-empty `runbook_url` annotation

#### Scenario: Each database alert has at least one steady-state-no-fire test case
- **WHEN** the fixture is read
- **THEN** `PostgresConnectionSaturation` has a stanza where the ratio stays below 0.8 and the alert is NOT in `firing` state
- **AND** `PostgresDeadlocks` has a stanza where the deadlock counter is flat and the alert is NOT in `firing` state

### Requirement: Backend integration test proves the exporter pipeline end-to-end

A backend integration test SHALL prove the `postgres-exporter` → metrics surface end-to-end against a real Postgres. The test SHALL use testcontainers to bring up Postgres with `shared_preload_libraries=pg_stat_statements` and the init script applied, plus a sibling postgres-exporter container pointed at it, drive real DB traffic, then HTTP-fetch the exporter's `/metrics` endpoint and assert presence of the key series.

#### Scenario: Test brings up postgres with pg_stat_statements preloaded
- **WHEN** the integration test starts the testcontainers Postgres
- **THEN** the container is started with `shared_preload_libraries=pg_stat_statements` set
- **AND** the `pg_stat_statements` extension is registered in the test database after startup

#### Scenario: Test brings up a sibling postgres-exporter container
- **WHEN** the integration test starts the postgres-exporter container
- **THEN** the container uses the same pinned image tag as `docker-compose.yml`
- **AND** the container is configured with the same `queries.yaml` file used in the compose configuration
- **AND** the container's `/metrics` endpoint is reachable from the test JVM

#### Scenario: Test asserts the exporter emits the key series after real traffic
- **WHEN** the test drives a handful of read and write queries against the test Postgres and then fetches `http://<exporter>:9187/metrics`
- **THEN** the response body contains at least one sample of `pg_stat_database_xact_commit{datname="..."}` (the exporter emits the counter without a `_total` suffix)
- **AND** the response body contains at least one sample of a `pg_stat_database_numbackends` series
- **AND** the response body contains at least one sample of a series projected from `pg_stat_statements` by the custom-queries file (e.g. `pg_stat_statements_calls` or the equivalent name declared in `queries.yaml`)

### Requirement: README documents the local database-observability run loop

The repository README's observability section SHALL gain a "Database internals" subsection that names the new exporter, the new dashboard, the alert pair, and the one-time volume-rebuild step required for `pg_stat_statements` to register on existing local installations.

#### Scenario: README documents the database-observability run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9090/api/v1/targets` as the place to verify the `postgres-exporter` scrape target is healthy
- **AND** the README names the `Database overview` dashboard and how to navigate to it from Grafana
- **AND** the README documents the two new alerts (`PostgresConnectionSaturation`, `PostgresDeadlocks`) and notes that they ride the existing severity routing to the webhook sink
- **AND** the README calls out the one-time `docker compose down -v` step (or the equivalent `CREATE EXTENSION` exec) required for `pg_stat_statements` to register on a pre-existing local data directory
- **AND** the README explicitly notes that slow-query log shipping to Loki is deferred and that `pg_stat_statements` covers the "which query is slow" question for now

### Requirement: `cadvisor` is provisioned under the `observability` docker-compose profile

A single `cadvisor` service SHALL run under the `observability` profile, exposing per-container resource metrics in Prometheus exposition format on port `8080` (published to host as `8085` to avoid colliding with the backend's host-side `8080`). The container image SHALL be `gcr.io/cadvisor/cadvisor` pinned to an explicit tag (not `latest`). The service SHALL mount the read-only host paths cAdvisor needs to read cgroup and Docker daemon state.

#### Scenario: Observability profile starts the cadvisor container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-cadvisor` container is started in addition to the other observability containers
- **AND** the container's `/metrics` endpoint is reachable from the prometheus container at `http://cadvisor:8080/metrics`

#### Scenario: Default invocation does not start cadvisor
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-cadvisor` container is NOT started

#### Scenario: cadvisor image is pinned by tag
- **WHEN** the docker-compose `cadvisor` service definition is read
- **THEN** the `image:` field is `gcr.io/cadvisor/cadvisor:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: cadvisor declares the host mounts and device passthroughs it needs
- **WHEN** the docker-compose `cadvisor` service definition is read
- **THEN** the service mounts the host's `/`, `/sys`, `/var/lib/docker/`, and `/dev/disk/` paths into the container as read-only (`:ro`)
- **AND** the service mounts the host's `/var/run/docker.sock` into the container (the Docker socket is bidirectional by nature, so the mount is `:rw`); without this mount cAdvisor cannot resolve cgroup ids to container names and the `name` label every dashboard panel and alert rule depends on stays empty
- **AND** the service exposes `/dev/kmsg` to the container via the compose `devices:` block so cAdvisor can read kernel OOM-kill notifications from the ring buffer (without this `container_oom_events_total` is populated only with zero samples)
- **AND** the service publishes container port `8080` to a host port that does not collide with any other service on the local machine (the backend runs on host `:8080`)

### Requirement: Every existing compose service declares `deploy.resources.limits`

Every service defined in `docker-compose.yml` (including the existing `postgres`, `prometheus`, `grafana`, `tempo`, `loki`, `collector`, `alertmanager`, `webhook-sink`, `postgres-exporter`, and the new `cadvisor`) SHALL declare an explicit memory limit and CPU limit via the `deploy.resources.limits` block. The limits SHALL be sized comfortably above local-dev steady-state working sets but bounded enough that a runaway container trips its own alert before swamping the host. Without these limits, the container saturation alerts in this slice cannot fire.

#### Scenario: Every service declares both a memory and a CPU limit
- **WHEN** a reader inspects each service block in `docker-compose.yml`
- **THEN** the service contains a `deploy.resources.limits` block (or the equivalent compose v2 `mem_limit` + `cpus` keys, depending on the syntax the repository settles on at implementation)
- **AND** both `memory` and `cpus` are set to non-empty values
- **AND** no service is missing a limit declaration

#### Scenario: `postgres` limits apply under both the default and observability profiles
- **WHEN** an operator runs `docker-compose up -d postgres` (no observability profile)
- **THEN** the running `social-postgres` container has the limit declared in `docker-compose.yml` applied
- **AND** the limit is comfortable for local-dev steady state (at least 1 GiB memory, at least 2 CPU equivalents)

#### Scenario: Limits are documented in compose comments
- **WHEN** a reader inspects the limit declarations in `docker-compose.yml`
- **THEN** at least one comment explains that the limits exist to make the cAdvisor saturation alerts meaningful (otherwise `container_spec_memory_limit_bytes` is unbounded and CFS throttling never triggers)

### Requirement: Prometheus scrapes `cadvisor` as a new job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL include a scrape job for the cadvisor container. The job SHALL be additive to the existing scrape jobs (the existing `backend`, `collector`, and `postgres-exporter` jobs are unchanged in name, target, and interval).

#### Scenario: Prometheus config declares the cadvisor scrape job
- **WHEN** a reader inspects `infra/observability/prometheus/prometheus.yml`
- **THEN** `scrape_configs:` contains an entry with `job_name: cadvisor`
- **AND** the entry targets `cadvisor:8080`
- **AND** the entry's `scrape_interval` is `15s` (matching the existing `backend` job)
- **AND** the entry's `metrics_path` is `/metrics` (the cAdvisor default)

#### Scenario: Prometheus scrapes cadvisor when the observability profile is up
- **WHEN** the `observability` profile is running and a reader queries `http://localhost:9090/api/v1/targets`
- **THEN** the `cadvisor` target appears with `health: "up"` after one scrape interval

### Requirement: Grafana provisions an `Infrastructure overview` dashboard

The repository SHALL include `infra/observability/grafana/dashboards/infrastructure-overview.json` declaring a Grafana dashboard that visualises per-container resource use. The dashboard SHALL be picked up automatically by the existing dashboards-provisioning glob (no provisioning YAML change required). All panels SHALL be sourced from cAdvisor metrics; no panel SHALL require ad-hoc PromQL knowledge from the operator to read.

#### Scenario: Dashboard JSON file exists alongside the existing siblings
- **WHEN** a reader inspects `infra/observability/grafana/dashboards/`
- **THEN** it contains `infrastructure-overview.json` alongside `backend-overview.json`, `frontend-overview.json`, and `database-overview.json`

#### Scenario: Dashboard contains the core panel set
- **WHEN** Grafana loads the dashboard
- **THEN** the dashboard contains at least one panel each for: per-container CPU usage, per-container CPU throttling ratio, per-container memory working set vs. limit, per-container network receive bytes, per-container network transmit bytes, per-container restart count over the last hour, and per-container OOM event count over the last hour

#### Scenario: All cAdvisor PromQL filters exclude empty-name cgroup-hierarchy series
- **WHEN** a reader inspects each PromQL expression in the dashboard JSON
- **THEN** every expression that references a `container_*` metric filters with `name!=""` (or the equivalent label match)
- **AND** no panel's PromQL query groups by a label that would include the path-style cgroup hierarchy (which would inflate cardinality)

### Requirement: Container alert rules live in `infra/observability/prometheus/rules/container-alerts.yml`

The repository SHALL include a Prometheus rules file at `infra/observability/prometheus/rules/container-alerts.yml` declaring container-tier infra alerts. The file SHALL be loaded by Prometheus via the existing `rule_files:` configuration in `prometheus.yml`.

#### Scenario: Rules file exists in the expected directory
- **WHEN** a reader inspects `infra/observability/prometheus/rules/`
- **THEN** it contains `container-alerts.yml` alongside the existing SLO and database rule files

#### Scenario: Prometheus loads the container rules at startup
- **WHEN** Prometheus starts with the observability profile up
- **THEN** `http://localhost:9090/api/v1/rules` reports the `container-alerts` rule group with at least the alerts named in this spec

#### Scenario: prometheus.yml references the new rule file
- **WHEN** a reader inspects `rule_files:` in `prometheus.yml`
- **THEN** the list includes `rules/container-alerts.yml` alongside the existing `slo-*`, `fe-slo-*`, and `database-alerts` entries

### Requirement: A `ContainerCpuThrottling` alert covers sustained CFS throttling

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerCpuThrottling` that fires when a container is throttled against its CFS quota for a sustained period. The alert SHALL carry severity `ticket` (routing via the existing severity tree from slice 11 to the ticket-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerCpuThrottling.md`.

#### Scenario: Alert is declared with the throttling-ratio expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerCpuThrottling`
- **AND** the alert's `expr` measures the per-container ratio `sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m]))` exceeding `0.25`
- **AND** the alert's `for:` clause is `10m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerCpuThrottling` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerCpuThrottling.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

### Requirement: A `ContainerMemoryNearLimit` alert covers approaching-OOM memory pressure

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerMemoryNearLimit` that fires when a container's working set approaches its declared memory limit. The alert SHALL carry severity `ticket` and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerMemoryNearLimit.md`.

#### Scenario: Alert is declared with the memory-ratio expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerMemoryNearLimit`
- **AND** the alert's `expr` measures the per-container ratio `container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""}` exceeding `0.9`
- **AND** the alert's `for:` clause is `5m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerMemoryNearLimit` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerMemoryNearLimit.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

#### Scenario: Alert silently no-ops on un-limited containers
- **WHEN** the cluster contains a container that has no memory limit declared (so `container_spec_memory_limit_bytes` reports as `0`)
- **THEN** the alert expression evaluates to a non-finite ratio that does not satisfy `> 0.9`
- **AND** the alert does NOT fire for that container

### Requirement: A `ContainerOomKilled` alert covers OOM-kill events

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerOomKilled` that fires when one or more OOM-kill events are recorded by cAdvisor in the recent 15-minute window. The alert SHALL carry severity `page` (routing to the page-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerOomKilled.md`.

#### Scenario: Alert is declared with the OOM-event expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerOomKilled`
- **AND** the alert's `expr` is `increase(container_oom_events_total{name!=""}[15m]) > 0`
- **AND** the alert has no `for:` clause (a single OOM is sufficient to page)

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerOomKilled` alert
- **THEN** the alert's `labels:` block contains `severity: page`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerOomKilled.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

### Requirement: Runbook stubs exist for the three container alerts

The repository SHALL include Markdown runbook stubs at `infra/observability/runbooks/ContainerCpuThrottling.md`, `infra/observability/runbooks/ContainerMemoryNearLimit.md`, and `infra/observability/runbooks/ContainerOomKilled.md`, matching the shape of the slice-11 stubs (Symptoms / Impact / Triage / Mitigation / Escalation).

#### Scenario: Stubs exist with the canonical section shape
- **WHEN** a reader inspects `infra/observability/runbooks/`
- **THEN** the directory contains `ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, and `ContainerOomKilled.md`
- **AND** each file contains the section headings `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in any reasonable order and heading level)

### Requirement: `promtool test rules` covers the container alerts

The repository SHALL include `infra/observability/prometheus/rules/container-tests.yml` exercising all three container alerts against synthetic series. The fixture SHALL be discovered by the existing `promtool test rules` invocation that already covers the SLO and database rule tests. The fixture SHALL assert both the firing condition, the steady-state non-firing condition, and the presence of the `runbook_url` annotation for every alert.

#### Scenario: Test fixture lives next to the rule file
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `container-tests.yml` alongside `container-alerts.yml`

#### Scenario: Each container alert has at least one fires-as-expected test case
- **WHEN** the fixture is read
- **THEN** `ContainerCpuThrottling` has a stanza feeding synthetic `container_cpu_cfs_throttled_periods_total` and `container_cpu_cfs_periods_total` series for a named container that drive the ratio above 0.25 for at least 10 minutes, and asserts the alert is in `firing` state at that simulated time with `severity: ticket` and a non-empty `runbook_url` annotation
- **AND** `ContainerMemoryNearLimit` has a stanza feeding synthetic `container_memory_working_set_bytes` and `container_spec_memory_limit_bytes` series for a named container that drive the ratio above 0.9 for at least 5 minutes, and asserts the alert is in `firing` state with `severity: ticket` and a non-empty `runbook_url` annotation
- **AND** `ContainerOomKilled` has a stanza feeding a synthetic `container_oom_events_total` series for a named container that increases by at least 1 within a 15-minute window, and asserts the alert is in `firing` state with `severity: page` and a non-empty `runbook_url` annotation

#### Scenario: Each container alert has at least one steady-state-no-fire test case
- **WHEN** the fixture is read
- **THEN** `ContainerCpuThrottling` has a stanza where the throttling ratio stays below 0.25 and the alert is NOT in `firing` state
- **AND** `ContainerMemoryNearLimit` has a stanza where the working-set / limit ratio stays below 0.9 and the alert is NOT in `firing` state
- **AND** `ContainerOomKilled` has a stanza where `container_oom_events_total` is flat and the alert is NOT in `firing` state

#### Scenario: ContainerMemoryNearLimit fixture covers the un-limited-container case
- **WHEN** the fixture is read
- **THEN** `ContainerMemoryNearLimit` has a stanza where `container_spec_memory_limit_bytes` is `0` for a container while its working set is non-zero, and the alert is NOT in `firing` state for that container (ratio is non-finite, expression does not match)

### Requirement: Backend integration test proves the cAdvisor pipeline end-to-end

A backend integration test SHALL prove the cAdvisor → metrics surface end-to-end. The test SHALL use testcontainers to bring up cAdvisor with the same read-only host mounts the compose service uses, drive a small workload so cAdvisor has non-empty containers to report on, then HTTP-fetch the cAdvisor `/metrics` endpoint and assert presence of the metric families this slice depends on. The test MAY be gated behind a system property if needed for CI-runner compatibility.

#### Scenario: Test brings up cAdvisor as a sibling testcontainer
- **WHEN** the integration test starts the cAdvisor testcontainer
- **THEN** the container uses the same pinned image tag as `docker-compose.yml`
- **AND** the container is started with the same read-only host mounts the compose service declares
- **AND** the container's `/metrics` endpoint is reachable from the test JVM

#### Scenario: Test asserts the cAdvisor scrape exposes the required metric families
- **WHEN** the test fetches `http://<cadvisor>:8080/metrics`
- **THEN** the response body contains at least one sample of each of the following metric families: `container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes`, and `container_oom_events_total`
- **AND** at least one of each metric family carries a non-empty `name` label (proving the per-container series are present, not only the cgroup-hierarchy series)

#### Scenario: Test gating is documented if the test is not always-on
- **WHEN** the test class is read
- **THEN** any conditional gating (e.g. `@EnabledIfSystemProperty`, `@DisabledOnOs`, or environment-variable checks) is paired with a comment explaining the gate (CI runner does not run the observability profile, or platform-specific Docker socket constraints)

### Requirement: README documents the local container-observability run loop

The repository README's observability section SHALL gain a "Container infrastructure" subsection that names the new cAdvisor service, the new dashboard, the alert trio, the resource-limit pass on existing services, and the explicit non-goals (no `node_exporter` for the host, no `process-exporter` for the host JVM, backend not containerized in this slice).

#### Scenario: README documents the container-observability run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9090/api/v1/targets` as the place to verify the `cadvisor` scrape target is healthy
- **AND** the README names the `Infrastructure overview` dashboard and how to navigate to it from Grafana
- **AND** the README documents the three new alerts (`ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`) and notes that they ride the existing severity routing to the webhook sink
- **AND** the README explains the resource-limit declarations and notes that the alerts cannot fire without limits
- **AND** the README explicitly notes the deferred items: `node_exporter` would be added per node in a real prod deploy via a Kubernetes DaemonSet, `process-exporter` for the host JVM is not added because Micrometer already covers JVM internals, and containerizing the backend is a separate architectural change

### Requirement: The in-cluster backend image bakes the OTel agent so the attach mechanic matches the host loop

The OCI image produced by `./gradlew bootBuildImage` SHALL include the `opentelemetry-javaagent.jar` at a known in-image path AND SHALL set the container's process environment so the agent attaches at JVM startup without the operator needing to set any per-deploy flag. Concretely, the image SHALL set `JAVA_TOOL_OPTIONS=-javaagent:<in-image-path-to-the-agent-jar>` so a vanilla `java -jar <app.jar>` invocation inside the container attaches the agent identically to how the host loop attaches it.

#### Scenario: Image carries the agent jar at a known path
- **WHEN** an operator inspects the layers of the image produced by `./gradlew bootBuildImage`
- **THEN** the image contains a file named `opentelemetry-javaagent.jar` at a stable, documented path (e.g. `/workspace/agent/opentelemetry-javaagent.jar`)

#### Scenario: Image sets JAVA_TOOL_OPTIONS to attach the agent
- **WHEN** an operator runs `docker inspect <image>` and inspects `Config.Env`
- **THEN** the env list contains an entry of the form `JAVA_TOOL_OPTIONS=-javaagent:<path>` whose `<path>` matches the agent jar's in-image path

#### Scenario: Agent attaches at pod start without per-Deployment flag
- **WHEN** the backend pod is Running and the operator runs `kubectl logs -n social deploy/backend` against the first few seconds of startup
- **THEN** the logs include the OpenTelemetry Java agent's standard "[otel.javaagent ...] OpenTelemetry Javaagent" banner
- **AND** the Deployment manifest does NOT declare a `-javaagent:` arg under `command:` or `args:` (the env-driven attach is the slice's mechanism)

### Requirement: An in-cluster backend pod sends OTLP to the in-cluster collector Service

When the backend runs inside the local k3s cluster (the side-channel path introduced by `add-local-k3s-backend`), its OpenTelemetry Java agent SHALL send OTLP traffic to the in-cluster OpenTelemetry Collector Service at `collector.social.svc.cluster.local:4318` (OTLP/HTTP). The Deployment manifest SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` to this exact value. The host-run backend's OTLP transport (`localhost:4318` via the build-wired defaults) SHALL be unaffected — the host loop continues to ship to the compose collector directly.

This requirement is transitional with respect to the collector's exporter target, not its receiver target: the in-cluster collector relays incoming spans to the compose collector via the VM-host alias for the duration of this slice. The `bridge-collectors-to-obs-cluster` slice replaces the relay target without touching this requirement.

#### Scenario: In-cluster backend Deployment sets the OTLP endpoint to the in-cluster Service
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318`

#### Scenario: Host-run backend OTLP transport is unchanged
- **WHEN** a reader inspects `backend/src/main/resources/application.yaml` and `backend/build.gradle.kts` for OTel-related defaults
- **THEN** the host-run agent's `OTEL_EXPORTER_OTLP_ENDPOINT` resolution is unchanged from the prior slice
- **AND** running `./gradlew bootRun` produces an agent process that sends OTLP to `http://localhost:4318` as before

#### Scenario: Both paths land in the compose collector during this slice
- **WHEN** an operator runs both the host backend (`./gradlew bootRun`) and the in-cluster backend (`just backend-apply`) simultaneously with the `observability` compose profile up
- **AND** the operator generates traffic against both
- **THEN** the compose collector's `otelcol_receiver_accepted_spans` (or equivalent) metric increments for both sources
- **AND** Tempo shows traces originating from both `service.instance.id` values
- **AND** the in-cluster backend's spans reach Tempo via the in-cluster collector relay (NOT directly from the backend pod)

### Requirement: The in-cluster collector relays traces to the compose collector via the VM-host alias

The in-cluster OpenTelemetry Collector introduced by this slice SHALL include exactly one trace exporter pointing at the compose collector's published OTLP/gRPC port (`host.lima.internal:4317`, `tls.insecure: true`). This relay is transitional: the `bridge-collectors-to-obs-cluster` slice replaces the exporter target with the obs cluster's OTLP receiver. The relay is the slice's mechanism for preserving end-to-end visibility through the transition — the compose collector continues to do every other thing it does today (browser FE traces / metrics / logs, host BE filelog), and now also receives in-cluster BE traces from the relay instead of directly.

#### Scenario: Collector ConfigMap declares a single OTLP exporter targeting the compose host alias
- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the `exporters:` block declares exactly one OTLP exporter
- **AND** the exporter's `endpoint` is `host.lima.internal:4317`
- **AND** the exporter's `tls.insecure` is `true`

#### Scenario: Spans flow end-to-end through the relay
- **WHEN** the in-cluster backend is running and traffic is generated against it
- **AND** the operator inspects `kubectl -n social logs deploy/collector --tail=200`
- **THEN** the collector logs report OTLP receive activity (non-zero accepted spans)
- **AND** the operator queries the compose collector container's logs OR the `social-collector` container's `otelcol_receiver_accepted_spans` metric
- **AND** the compose collector also reports increasing accepted-span counts from the in-cluster relay

#### Scenario: Redaction policy is preserved through the relay
- **WHEN** the in-cluster backend serves a request whose path includes a UUID, opaque-hex segment, or numeric id (e.g. `/api/v1/users/c0ffee00-1234-5678-9abc-deadbeef0000/profile`)
- **AND** the resulting span lands in Tempo via the relay
- **THEN** the span's `name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full` fields show the high-cardinality segment replaced with the literal token `{id}`

