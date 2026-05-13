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

## Prerequisites

- Java 21
- Node (version pinned in `frontend/.nvmrc`) and pnpm (for the frontend)
- Docker (for Postgres and Testcontainers)
