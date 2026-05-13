# add-backend-logs — tasks

## 1. Backend: enable structured console logging in `application.yaml`

- [x] 1.1 Open `backend/src/main/resources/application.yaml`. Under
  the top-level `logging:` key (add the key if absent — currently
  there is no `logging:` block), add
  `structured.format.console: ecs`.
- [x] 1.2 Under `logging.structured.json.add`, add
  `service.environment: local`. The ECS formatter will lift this
  into a `service.environment` field on every JSON object.
- [x] 1.3 Confirm that `service.name` is *not* hand-set here —
  Spring Boot's ECS formatter derives it from
  `spring.application.name` (already `backend`). Do not duplicate.
- [x] 1.4 Sanity-check: `./gradlew :backend:bootRun` (with Postgres
  up) and inspect stdout — every line should be one JSON object
  containing at minimum `@timestamp`, `log.level`,
  `service.name="backend"`, `service.environment="local"`,
  `process.thread.name`, `log.logger`, `message`, `ecs.version`.

## 2. Backend: `observability/AccessLogMarkers.java`

- [x] 2.1 Create `backend/src/main/java/com/prodready/social/observability/AccessLogMarkers.java`
  as a final class with a private constructor.
- [x] 2.2 Declare `public static final String` constants for the
  MDC keys (`MDC_REQUEST_ID = "request.id"`,
  `MDC_USER_ID = "user.id"`) and for the access-log marker fields
  (`ECS_HTTP_METHOD = "http.request.method"`,
  `ECS_URL_PATH = "url.path"`,
  `ECS_HTTP_STATUS = "http.response.status_code"`,
  `ECS_EVENT_DURATION = "event.duration"`,
  `ECS_EVENT_DATASET = "event.dataset"`,
  `EVENT_DATASET_BACKEND_ACCESS = "backend.access"`,
  `FIELD_DURATION_MS = "duration_ms"`,
  `HEADER_REQUEST_ID = "X-Request-Id"`).
- [x] 2.3 No logic in this class. It exists so that no other
  filter source file inlines a magic string.

## 3. Backend: `observability/RequestIdFilter.java`

- [x] 3.1 Create `backend/src/main/java/com/prodready/social/observability/RequestIdFilter.java`
  extending `org.springframework.web.filter.OncePerRequestFilter`.
- [x] 3.2 In `doFilterInternal`, read the `X-Request-Id` request
  header. If non-null and non-blank, use it as the request id.
  Otherwise generate `UUID.randomUUID().toString()`.
- [x] 3.3 `MDC.put(AccessLogMarkers.MDC_REQUEST_ID, requestId)`
  before calling `chain.doFilter(...)`.
- [x] 3.4 Set `response.setHeader(AccessLogMarkers.HEADER_REQUEST_ID,
  requestId)` BEFORE `chain.doFilter` (the response may be
  committed by the controller).
- [x] 3.5 Wrap `chain.doFilter` in `try / finally`. In the
  `finally` block call
  `MDC.remove(AccessLogMarkers.MDC_REQUEST_ID)` — the Tomcat
  thread will be reused for the next request.
- [x] 3.6 Do NOT length-cap or validate the inbound header. (Per
  Decision 6 — production would, this slice does not.)

## 4. Backend: `observability/UserContextLogFilter.java`

- [x] 4.1 Create `backend/src/main/java/com/prodready/social/observability/UserContextLogFilter.java`
  extending `OncePerRequestFilter`.
- [x] 4.2 In `doFilterInternal`, read
  `SecurityContextHolder.getContext().getAuthentication()`. If the
  authentication is non-null, is `instanceof
  UsernamePasswordAuthenticationToken`, has `isAuthenticated()`
  true, AND its principal is an instance of `UserPrincipal`, call
  `MDC.put(AccessLogMarkers.MDC_USER_ID, principal.getId().toString())`.
- [x] 4.3 Wrap `chain.doFilter` in `try / finally`. Clear the
  MDC key in `finally` regardless of whether `put` was called.
- [x] 4.4 If no authentication is present, do NOT put any
  placeholder (`MDC.put("user.id", "anonymous")` would be wrong).
  Anonymous requests should emit a JSON object that simply omits
  the `user.id` field.

## 5. Backend: `observability/RequestLoggingFilter.java`

- [x] 5.1 Create `backend/src/main/java/com/prodready/social/observability/RequestLoggingFilter.java`
  extending `OncePerRequestFilter`. Declare a `private static final
  Logger ACCESS_LOG = LoggerFactory.getLogger("backend.access")`.
- [x] 5.2 Short-circuit: if the request URI is exactly
  `/actuator/health` or `/actuator/prometheus`, call
  `chain.doFilter(...)` and return without timing or logging.
  (Per Decision 7.)
- [x] 5.3 Record `long startNanos = System.nanoTime()` before
  `chain.doFilter`. Wrap the chain call in `try / finally`.
- [x] 5.4 In `finally`, compute `durationNanos = System.nanoTime()
  - startNanos`. Resolve the route template via Spring's
  `RequestMappingInfoHandlerMapping` matched-pattern attribute:
  read `request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE)`;
  if non-null use it, else fall back to `request.getRequestURI()`.
  The matched pattern is what Micrometer's
  `http_server_requests_seconds_*` uses as its `uri` tag, so
  metrics ↔ access log share a key.
- [x] 5.5 Emit the access-log line via
  `ACCESS_LOG.atInfo()` using the SLF4J 2.x fluent API, with these
  key-value pairs added via `.addKeyValue(key, value)`:
  - `event.dataset` → `backend.access`
  - `http.request.method` → `request.getMethod()`
  - `url.path` → the matched template (from step 5.4)
  - `http.response.status_code` → `response.getStatus()`
  - `event.duration` → `durationNanos` (as a Long, ECS-canonical
    nanoseconds)
  - `duration_ms` → `durationNanos / 1_000_000L` (as a Long, for
    humans)

  Finish with `.log("")` (no message body — the structured fields
  are the line). The `request.id` and `user.id` MDC fields will
  appear in the JSON envelope automatically.
- [x] 5.6 If `chain.doFilter` throws, the `finally` block still
  emits the line; `response.getStatus()` reflects whatever
  Spring's `DefaultErrorAttributes` resolved to (typically 500).

## 6. Backend: `observability/ObservabilityWebConfig.java`

- [x] 6.1 Create `backend/src/main/java/com/prodready/social/observability/ObservabilityWebConfig.java`
  annotated `@Configuration`.
- [x] 6.2 Declare three `@Bean` methods returning
  `FilterRegistrationBean<...>`:
  - `requestIdFilterRegistration()` → wraps `new RequestIdFilter()`,
    `setOrder(-200)`, `addUrlPatterns("/*")`.
  - `requestLoggingFilterRegistration()` → wraps
    `new RequestLoggingFilter()`, `setOrder(-150)`,
    `addUrlPatterns("/*")`. (See `design.md` Decision 3: placed
    *outside* the Spring Security chain so 401/403 responses still
    emit an access-log line.)
  - `userContextLogFilterRegistration()` → wraps
    `new UserContextLogFilter()`, `setOrder(0)`,
    `addUrlPatterns("/*")`.
- [x] 6.3 Add a class-level Javadoc comment documenting the
  ordering rationale (per `design.md` Decision 3 and 4) — name
  Spring Security's default order (`-100`) and the relative
  position of each filter.
- [x] 6.4 Do not touch `useraccounts/SecurityConfig.java`. No
  allowlist entry, no `addFilterAfter`, no security-chain coupling.

## 7. Backend: integration test `StructuredLoggingIT`

- [x] 7.1 Create `backend/src/test/java/com/prodready/social/observability/StructuredLoggingIT.java`
  following the existing `*IT.java` shape (`@SpringBootTest(webEnvironment
  = SpringBootTest.WebEnvironment.RANDOM_PORT)`, `@Testcontainers`,
  Postgres container, `TestRestTemplate` or `WebTestClient`).
- [x] 7.2 Provide a `@BeforeEach` that redirects `System.out` to a
  `ByteArrayOutputStream`. Provide an `@AfterEach` that restores
  the original stream (whether the test passed or threw). Use the
  same idiom as
  `https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.logging.structured`
  references — capture stdout deterministically.
- [x] 7.3 Test `everyLineIsJsonWithBaseEcsFields`: log one line via
  a `LoggerFactory.getLogger(getClass()).info("smoke")` call,
  flush, parse the captured stdout line as JSON, assert the
  presence of `@timestamp`, `log.level == "INFO"`,
  `service.name == "backend"`,
  `service.environment == "local"`, `process.thread.name`,
  `log.logger`, `message == "smoke"`, `ecs.version`.
- [x] 7.4 Test `authenticatedControllerCallEmitsAccessLogLine`:
  signup + login a user via the existing test helpers; call
  `GET /api/v1/auth/me` with the bearer token; assert that
  exactly one of the captured JSON lines has
  `event.dataset == "backend.access"` AND
  `http.request.method == "GET"` AND
  `url.path == "/api/v1/auth/me"` AND
  `http.response.status_code == 200` AND
  carries non-null `event.duration` (Long) and `duration_ms` (Long)
  AND carries `user.id` matching the signed-in user's id AND
  carries `request.id` (any non-blank value).
- [x] 7.5 Test `urlPathFieldIsRouteTemplateNotResolvedPath`: hit
  `GET /api/v1/users/{someUuid}`; assert the corresponding
  `backend.access` JSON line has `url.path == "/api/v1/users/{userId}"`
  (the matched pattern), NOT the resolved UUID. (This is the
  cardinality footgun mirror of the slice-1 Micrometer
  requirement.)
- [x] 7.6 Test `anonymousProtectedRouteEmits401WithoutUserId`: hit
  any authenticated route (`GET /api/v1/auth/me`) with no
  Authorization header; assert the matching `backend.access` JSON
  line has `http.response.status_code == 401` AND has a
  `request.id` field AND has NO `user.id` field.
- [x] 7.7 Test `actuatorPrometheusIsNotAccessLogged`: hit
  `GET /actuator/prometheus`; assert that NO captured JSON line
  has `event.dataset == "backend.access"` (Decision 7). The
  endpoint must still respond 200; this only asserts on the log
  shape.
- [x] 7.8 Test `responseHeaderMatchesRequestIdField`: hit any
  endpoint; capture the `X-Request-Id` response header; assert the
  corresponding `backend.access` JSON line has
  `request.id` equal to that header value.
- [x] 7.9 Test `inboundRequestIdHeaderIsHonoured`: hit any endpoint
  with `X-Request-Id: client-supplied-abc`; assert both the
  response header AND the `backend.access` JSON line carry
  `client-supplied-abc`.
- [x] 7.10 Test `mdcIsClearedBetweenRequests`: in one test method,
  (a) hit a controller endpoint and capture its `request.id`;
  (b) on the same JVM, log directly from the test thread
  (`LoggerFactory.getLogger(getClass()).info("between")`); (c)
  assert the captured "between" JSON line has NO `request.id`
  field and NO `user.id` field — proves the upstream filters
  cleared MDC and the test thread (Tomcat's worker after request
  completion) is clean. NOTE: this works because the test thread
  is the JUnit thread (not a Tomcat worker) — assert on stdout
  capture, not on any specific worker thread.

## 8. README

- [x] 8.1 Edit the top-level `README.md`. Under the existing
  `## Local observability` section (added in slice 1), add a
  subsection `### Structured logs`.
- [x] 8.2 Document the JSON-on-stdout shape with one example
  line copy-pasted from a real bootRun stdout (after a sample
  `GET /api/v1/auth/me` 200 call). Show the `request.id`,
  `user.id`, `event.dataset` fields.
- [x] 8.3 Document the `X-Request-Id` round-trip with a `curl
  -i http://localhost:8080/api/v1/auth/me ...` example showing
  the response header.
- [x] 8.4 Document the grep-by-request-id pattern using `jq`:
  `./gradlew :backend:bootRun 2>&1 | jq 'select(.["request.id"]
  == "<value>")'`.
- [x] 8.5 Add a one-sentence forward-pointer: "`trace.id` and
  `span.id` slots are reserved by the ECS formatter and will
  start populating once the slice-3 (distributed tracing)
  change lands."

## 9. Verification

- [x] 9.1 Run `./gradlew :backend:test` and confirm the new
  `StructuredLoggingIT` class passes all 8 test methods (7.3
  through 7.10).
- [x] 9.2 Run `./gradlew :backend:bootRun` (Postgres up), in a
  second terminal `curl -i http://localhost:8080/api/v1/auth/me`,
  and visually confirm:
  - stdout emits two JSON lines for the request (controller-
    level + the `backend.access` line);
  - the `X-Request-Id` response header is present and matches the
    `request.id` JSON field;
  - the `backend.access` line carries `url.path`,
    `http.request.method`, `http.response.status_code`,
    `event.duration`, `duration_ms`, `request.id`;
  - `user.id` is absent on this anonymous call (Bearer token
    missing).
- [x] 9.3 Run `curl -s http://localhost:8080/actuator/prometheus
  > /dev/null` and confirm NO `backend.access` line was emitted
  for the scrape (Decision 7).
- [x] 9.4 Run `./gradlew :backend:spotlessCheck` and confirm no
  formatting violations were introduced.
- [x] 9.5 Run `./gradlew :backend:bootJar` and `:backend:check` to
  confirm the full backend gradle pipeline still passes end-to-
  end.
