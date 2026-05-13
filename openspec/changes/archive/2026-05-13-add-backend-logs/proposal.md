# add-backend-logs

## Why

Slice 1 of observability landed the **metrics** pillar (Micrometer +
Prometheus + Grafana). What's still missing is the **logs** pillar:
the backend currently emits Logback's default *human-readable* text
shape, with no correlation fields, no JSON, and no per-request
identifier. The practical consequences today:

- A reader looking at a production incident has no way to grep a
  single request's lifetime — there is no `request_id` to pivot on.
- Dashboard panels in `Backend overview` show that p95 of
  `POST /api/v1/posts` spiked. There is no way to jump from that
  spike to the specific log lines from the slow requests; logs and
  metrics share no join key.
- When slice 3 (distributed tracing) lands, the OTel Java agent
  will populate `trace_id` and `span_id` into Logback's MDC, and
  any log shipper (slice 4) will expect to lift those fields out of
  *structured* JSON. The slice-3 wiring is much smaller if logs
  are already JSON before the agent attaches.

This change introduces the second of three observability slices.
The deliverable is that, after this change, every log line the
backend emits is one ECS-format JSON object on stdout, carries a
generated `request.id`, carries `user.id` when the request was
authenticated, reserves the ECS-canonical `trace.id` and `span.id`
slots (empty until slice 3), and includes a single
`event.dataset=backend.access` line per HTTP request summarising
method / route / status / duration. No metric, no HTTP response
body, no database schema, and no UI behaviour changes.

**Why Spring Boot 4's native structured logging and not
`logstash-logback-encoder` or a hand-rolled `logback-spring.xml`?**
Spring Boot 3.4 introduced first-class structured logging via the
`logging.structured.format.console` property; Spring Boot 4 (the
runtime we're on at 4.0.6) inherits and extends it. Setting
`logging.structured.format.console: ecs` is one line of YAML; it
emits Elastic Common Schema JSON for free, picks up every MDC
entry into the JSON envelope automatically, and gives us a
documented escape hatch (`StructuredLogFormatter` bean) if we ever
need to customise a field. Pulling in `logstash-logback-encoder`
would add a transitive dependency, require a `logback-spring.xml`
to wire the encoder, and end up reinventing what the platform now
ships. The trade-off — that ECS is a slightly more verbose wire
format than the bare Logstash JSON shape — is recorded in
`design.md` Decision 1.

**Why ECS (Elastic Common Schema) and not the Logstash flat
format?** ECS is the de-facto industry naming standard:
`http.request.method`, `url.path`, `http.response.status_code`,
`user.id`, `trace.id`, `event.duration`, `service.name` are
stable, documented, and consumed by Grafana / Loki / Elastic /
Datadog / OpenSearch out of the box without remapping. Logstash
format uses `level`, `message`, `loggerName`, `@timestamp` and is
shorter on the wire but pushes the naming decision into the
shipper / dashboard layer. For a learning project that intends to
land slice 4 (Loki) and slice 3 (Tempo) on top of these logs, ECS
takes the naming question off the table at the source.

**Why three separate filters and not one?** The MDC fields that
should carry per-log-line have different "earliest available"
points in the servlet chain. `request.id` is generated at request
entry, before authentication. `user.id` can only be read once
Spring Security has populated the `SecurityContext`. The access-
log line at request exit needs both. The three-filter design
(`RequestIdFilter`, `UserContextLogFilter`, `RequestLoggingFilter`)
captures this dependency in ordering rather than in branching
inside one filter, which is both easier to read and easier to
extend in slice 3 (the OTel agent inserts its own MDC propagation
between these).

## What Changes

- **Backend — enable structured console logging** by adding
  `logging.structured.format.console: ecs` to
  `backend/src/main/resources/application.yaml`. Spring Boot 4's
  built-in `EcsStructuredLogFormatter` emits one JSON object per log
  event on stdout, lifting every MDC entry on the current thread
  into the JSON envelope. No `logback-spring.xml`, no extra
  dependency.
- **Backend — pin `service.name` and `service.environment`** under
  `logging.structured.json.add` (or via a small
  `StructuredLogFormatter` bean — `design.md` Decision 2 records
  the choice). `service.name=backend` matches the Micrometer
  common tag of the same name from slice 1.
- **Backend — `observability/RequestIdFilter.java`** new servlet
  filter (`OncePerRequestFilter`, order `-200` so it runs before
  the Spring Security chain). On request entry it reads any
  inbound `X-Request-Id` header (allow upstream proxies / clients
  to provide one), falls back to a generated UUID, puts the value
  in MDC as `request.id`, emits the same value on the response as
  the `X-Request-Id` header so clients can correlate, and clears
  MDC in `finally`. The header round-trip is the user-visible
  surface of this change.
- **Backend — `observability/RequestLoggingFilter.java`** new
  servlet filter (order `-150`, between `RequestIdFilter` and the
  Spring Security chain so it wraps both happy- and security-
  denied paths in a single timer). Wraps the chain with a start-
  nanos timer. On exit, emits one log line at INFO with marker
  `event.dataset=backend.access` carrying `http.request.method`,
  `url.path`, `http.response.status_code`, `event.duration`
  (nanoseconds, ECS canonical) and a derived `duration_ms` for
  human readability. Reads `request.id` from MDC and `user.id`
  from a request attribute (mirrored by `UserContextLogFilter` —
  see `design.md` Decision 5). Skips logging for `/actuator/health`
  and `/actuator/prometheus` to keep the per-15s Prometheus scrape
  out of the log volume.
- **Backend — `observability/UserContextLogFilter.java`** new
  servlet filter (order `0`, runs after the Spring Security filter
  chain at default `-100`). Reads
  `SecurityContextHolder.getContext().getAuthentication()`; if the
  principal is a `UserPrincipal`, puts `user.id` in MDC AND
  mirrors it into a request attribute so the outer
  `RequestLoggingFilter` can include it in the access-log line.
  Clears MDC in `finally`. Anonymous / failed-auth requests carry
  no `user.id` field, which is the correct shape.
- **Backend — `observability/ObservabilityWebConfig.java`** new
  `@Configuration` class registering the three filters as
  `FilterRegistrationBean`s with explicit `setOrder(...)` values.
  `design.md` Decision 3 records why ordering is done at
  registration time and not via `@Order` on the filter classes.
- **Backend — `observability/AccessLogMarkers.java`** small
  constants class for the ECS field names and the
  `event.dataset` marker string. Keeps string literals out of
  filter code.
- **Backend — integration test
  `observability/StructuredLoggingIT.java`** boots the full
  context against Testcontainers Postgres and asserts:
  - lines on stdout parse as JSON (one object per line);
  - every line carries `@timestamp`, `log.level`, `service.name`,
    `service.environment`, `process.thread.name`, `log.logger`,
    `message`;
  - a request through any authenticated controller emits one
    `event.dataset=backend.access` line carrying
    `http.request.method`, `url.path` (the route template, not
    the resolved path), `http.response.status_code`,
    `event.duration`, `duration_ms`, `request.id`, and `user.id`;
  - an unauthenticated `GET /actuator/prometheus` does NOT emit
    a `backend.access` line (skipped by design);
  - the `X-Request-Id` response header matches the `request.id`
    JSON field in the access log line;
  - a client-supplied inbound `X-Request-Id` is honoured (the
    same value appears in the access log AND in the response
    header);
  - an unauthenticated request to a protected route emits a
    `backend.access` line with `http.response.status_code=401`
    and NO `user.id` field;
  - a thread that logs *outside* a servlet request emits a JSON
    line with NO `request.id` or `user.id` (proves MDC is
    cleared between requests — the Tomcat thread reuse footgun).
- **README.md** gains a **Local structured logs** subsection
  under the existing **Local observability** section, documenting
  the `request.id` correlation pattern (e.g., `docker compose
  logs backend | jq 'select(.request.id == "...")'`) and noting
  that `trace.id` / `span.id` will start populating when slice 3
  (tracing) lands.

### Explicit non-goals (deferred to follow-ups)

- **Log shipping to Loki, Elasticsearch, or any sink.** Logs
  continue to render to stdout only. Slice 4 of observability
  owns Loki + Grafana Alloy.
- **Distributed tracing or any OpenTelemetry agent.** `trace.id`
  / `span.id` slots are reserved by the ECS formatter but are not
  populated by anything in this slice. Slice 3 wires the agent.
- **Per-line `user.id` outside the servlet request lifecycle.**
  Logs emitted by background schedulers, the Flyway migration
  loop, or the application bootstrap carry neither `request.id`
  nor `user.id`. Adding context to non-request work is a follow-
  up the moment we have a scheduler.
- **Log volume controls, sampling, or rate limiting.** Logs are
  emitted at the level Logback's defaults dictate. No
  `logging.level.*` overrides beyond the existing config.
- **Redaction or sensitive-field filtering.** No log line
  currently carries a password or a bearer token (verified
  against `BearerTokenAuthenticationFilter` and the auth
  controllers); we are not introducing a redaction filter for a
  problem that does not yet exist.
- **Logback access logs via Tomcat's `AccessLogValve`.** The
  application-level `RequestLoggingFilter` is the only access
  log surface. Tomcat's built-in valve stays disabled. They emit
  to different files, in different formats, and having both
  doubles the noise.
- **Front-end / SPA log shipping.** The React app's
  `console.error` output is not addressed in this slice.
- **Audit logs.** Security-relevant events (login, logout,
  refresh, signup) are not separated into a distinct audit
  stream. They land in the access log like any other request.
  An audit-grade stream is a future change.
- **CI assertion on JSON shape.** The new IT proves the format
  in a JVM. We do not add a CI step that greps `gradle test`
  stdout for JSON.

## Capabilities

### Modified Capabilities

- `observability` — gains four new requirements (structured-
  console-format, MDC correlation fields, access-log surface,
  filter ordering / lifecycle). The existing slice-1
  requirements (Prometheus scrape, common Micrometer tags,
  `TimedAspect`, business timers, dashboard / Prometheus / Grafana
  provisioning) are untouched.

### Touched-but-not-modified Capabilities (cited for clarity)

- `user-accounts` — the new filters do NOT modify the deny-by-
  default `SecurityFilterChain` allowlist; no new endpoints are
  exposed. `RequestIdFilter` and `RequestLoggingFilter` run
  *outside* the Spring Security filter chain (orders `-200` and
  `100` straddle Security's `-100`). `UserContextLogFilter` runs
  *inside* the chain via servlet-filter ordering, reads the
  populated `SecurityContext`, but does not alter authentication
  state.
- `posts`, `follows`, `feed`, `api-contract`, `frontend-scaffold`,
  `frontend-styling`, `monorepo-layout`, `backend-scaffold`,
  `ci`, `e2e` — no changes.

## Impact

- **Backend:**
  - Modified: `backend/src/main/resources/application.yaml` —
    `logging.structured.format.console: ecs` and
    `logging.structured.json.add.service.environment: local`
    (or equivalent under `logging.structured.json.customizer`).
  - New: `backend/src/main/java/com/prodready/social/observability/RequestIdFilter.java`.
  - New: `backend/src/main/java/com/prodready/social/observability/UserContextLogFilter.java`.
  - New: `backend/src/main/java/com/prodready/social/observability/RequestLoggingFilter.java`.
  - New: `backend/src/main/java/com/prodready/social/observability/ObservabilityWebConfig.java`.
  - New: `backend/src/main/java/com/prodready/social/observability/AccessLogMarkers.java`.
  - New: `backend/src/test/java/com/prodready/social/observability/StructuredLoggingIT.java`.
- **Infra:** No changes. `infra/observability/` from slice 1 is
  not touched.
- **docker-compose.yml:** No changes.
- **README.md** at repo root — a new **Local structured logs**
  subsection under **Local observability**.
- **OpenSpec specs:**
  - Modified at archive time: `openspec/specs/observability/spec.md`
    — four new requirements appended.
- **CI:** No new jobs. The existing backend IT job picks up
  `StructuredLoggingIT` automatically.
- **Database:** No migrations. No schema changes.
- **Dependencies:** No new libraries. Spring Boot's structured-
  logging support is already present in the existing
  `spring-boot-starter-webmvc` / actuator surface.
- **Frontend / e2e:** No changes. The new `X-Request-Id`
  response header is purely informational; nothing in the SPA or
  Playwright harness consumes it in this slice.
