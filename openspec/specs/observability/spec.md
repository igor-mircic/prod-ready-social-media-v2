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

#### Scenario: Build wires the documented OTEL_* defaults

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the `bootRun` and `test` task configurations declare environment-variable defaults for each of `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER`
- **AND** the values match those listed above.

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

The repository's `docker-compose.yml` SHALL declare one new service `tempo` under `profiles: ["observability"]` using the image `grafana/tempo:2.6.1`, mounting `./infra/observability/tempo/tempo.yaml` to `/etc/tempo.yaml`, exposing host ports `3200:3200` (HTTP API), `4317:4317` (OTLP gRPC), and `4318:4318` (OTLP HTTP), and starting with `-config.file=/etc/tempo.yaml`. The existing `grafana` service's `depends_on` list SHALL be extended to include `tempo` (in addition to the existing `prometheus` dependency from slice 1). The default `docker-compose up` invocation (with no profile flag) SHALL continue to start only `postgres`.

The repository SHALL include `infra/observability/tempo/tempo.yaml` declaring an OTLP receiver enabled on both gRPC (`0.0.0.0:4317`) and HTTP (`0.0.0.0:4318`), local-filesystem WAL and blocks storage under `/var/tempo`, the HTTP API on `0.0.0.0:3200`, and a 1-hour block retention. The file SHALL carry an inline comment marking the local-filesystem storage choice as a learning-project default and forward-referencing object-storage backends for production.

The repository SHALL include `infra/observability/grafana/provisioning/datasources/tempo.yaml` declaring one datasource named `Tempo` of type `tempo` at URL `http://tempo:3200`, with `editable: false` and `isDefault: false` (the Prometheus datasource from slice 1 remains the default). The file SHALL carry an inline comment forward-referencing slice 4: the `tracesToLogs` correlation block will be populated once Loki is provisioned as a datasource.

#### Scenario: Default invocation still starts only postgres (preserved across slice 3)

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Observability profile starts tempo alongside prometheus and grafana

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, and `tempo` services all start
- **AND** Tempo's HTTP API on `http://localhost:3200/ready` returns a 200 once the container has finished initial startup.

#### Scenario: Tempo configuration declares OTLP receivers and local storage

- **WHEN** a reader inspects `infra/observability/tempo/tempo.yaml`
- **THEN** the file enables an OTLP receiver listening on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP)
- **AND** the file declares local-filesystem WAL and blocks storage rooted at `/var/tempo`
- **AND** the file exposes Tempo's HTTP API on `0.0.0.0:3200`
- **AND** the file carries an inline comment marking local-filesystem storage as a learning-project default.

#### Scenario: Grafana datasource provisioning declares Tempo as non-default

- **WHEN** a reader inspects `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one datasource named `Tempo` of type `tempo`
- **AND** the URL is `http://tempo:3200`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file carries an inline comment forward-referencing the slice-4 `tracesToLogs` block.

#### Scenario: Backend overview dashboard gains a Recent traces panel

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard declares one new panel titled `Recent traces`
- **AND** the panel's datasource is `Tempo`
- **AND** the panel's query targets `{ resource.service.name = "backend" }` in TraceQL.

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
