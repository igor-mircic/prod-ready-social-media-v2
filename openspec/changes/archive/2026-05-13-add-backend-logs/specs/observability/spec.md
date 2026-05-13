## ADDED Requirements

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
