## Why

The backend has been growing steadily — auth, posts, follows, and a
fanout-on-write feed are all in main — but the system has **no
operational visibility**. There are no metrics endpoints, no
dashboards, and no way to answer questions like "is the feed read
slower than yesterday", "is the connection pool starved", or "did
that last deploy regress p95 latency on `POST /api/v1/posts`."
Logging is unstructured `System.out`-shaped output and the only
operational endpoint exposed today is `GET /actuator/health`.

This change introduces the first of three observability slices — the
**metrics** pillar — using the Spring-canonical stack: Micrometer in
the JVM, Prometheus as the pull-based time-series store, and Grafana
as the read surface. No behaviour of any existing HTTP endpoint
changes; nothing in the user-facing UI changes. The deliverable is
that, after this change, a developer running the local stack with
`docker-compose --profile observability up` can point a browser at
Grafana, see a provisioned "Backend overview" dashboard, and read
RED metrics (Rate / Errors / Duration) for every controller endpoint
plus HikariCP, JVM, and four hand-instrumented business timers
(`feed.fanout.duration`, `feed.read.duration`, `posts.create.duration`,
`follows.follow.duration`).

**Why this slice first?** Of the three observability pillars (metrics
/ logs / traces), metrics is the bedrock: every later operational
decision — sizing the HikariCP pool, choosing a sensible Bucket4j
rate-limit ceiling, validating that a refactor didn't regress
latency, or proving that a future async fanout worker is keeping up
with queue depth — assumes you can already read numbers off a
dashboard. Slice 2 (structured JSON logs + correlation field) and
slice 3 (OTel traces + Tempo) each plug into the Grafana installed
here.

**Why pull-based Prometheus and not push-based OTLP for metrics?**
Spring Boot's built-in Actuator integration with Micrometer's
Prometheus registry is the lowest-friction path: the app exposes
`/actuator/prometheus`, Prometheus scrapes it on a schedule, no
collector required. Push-based OTLP for metrics is a defensible
choice, but it forces an OTel Collector into the stack on day one
and adds a moving part this slice does not need. Slice 3 will
introduce the collector for traces — metrics can migrate to OTLP
later if a deploy target ever demands it; the dashboards do not
care about the wire protocol.

**Why a `docker-compose` profile (default off)?** A dev who is
working on a frontend bug does not want 200 MB of RAM eaten by a
Prometheus and a Grafana they will never look at. Profile-gating
means the new services do not start unless `--profile observability`
is passed.

## What Changes

- **Backend — add Micrometer Prometheus registry** by adding
  `io.micrometer:micrometer-registry-prometheus` to
  `backend/build.gradle.kts` (via `libs.versions.toml`).
  `spring-boot-starter-actuator` is already a dependency; the new
  registry is what makes `/actuator/prometheus` materialise.
- **Backend — extend `application.yaml`** to:
  - expose `prometheus` alongside the existing `health` and `info`
    on `management.endpoints.web.exposure.include`;
  - declare common Micrometer tags (`management.metrics.tags.application:
    prod-ready-social-media-backend`, `management.metrics.tags.service:
    backend`) so every emitted metric carries those labels and
    Prometheus / Grafana can filter by them;
  - enable HikariCP, JVM, system, and HTTP-server metric binders
    (most are on by default in Spring Boot; verify and pin
    explicitly).
- **Backend — `observability/MetricsConfig.java`** new class
  registering a `TimedAspect` bean. Without `TimedAspect`, the
  `@Timed` annotation is silently ignored on Spring beans — this is
  the gotcha the change documents.
- **Backend — `@Timed` annotations** on the four business hot paths:
  - `feed.fanout.duration` on `FeedFanoutService` public methods
    (`onPostCreated`, `onPostDeleted`, `onFollow`, `onUnfollow`);
  - `feed.read.duration` on `FeedService.findPage`;
  - `posts.create.duration` on `PostService.create`;
  - `follows.follow.duration` on `FollowService.follow`.

  Every `@Timed` is tagged with the method's class name only — no
  user id, no post id, no follow target id. High-cardinality tags
  are the Prometheus footgun and we deliberately avoid them.
- **Backend — `SecurityConfig` allowlist** gains exactly one new
  entry: `GET /actuator/prometheus`. `GET /actuator/health` is
  already allowlisted; `GET /actuator/info` is not exposed under
  `endpoints.web.exposure.include` by default in current config —
  this change exposes it AND adds it to the allowlist. Every other
  Actuator endpoint stays closed.
- **Infra — new `infra/observability/` directory** (fills the
  currently-reserved `infra/` slot in `README.md`):
  - `prometheus/prometheus.yml` — one scrape job for `backend` at
    `host.docker.internal:8080/actuator/prometheus`, 15-second
    scrape interval.
  - `grafana/provisioning/datasources/prometheus.yaml` — datasource
    auto-provisioning: declares `Prometheus` at
    `http://prometheus:9090`, set as the default datasource.
  - `grafana/provisioning/dashboards/dashboards.yaml` — dashboard
    provider pointing at `/etc/grafana/dashboards/`.
  - `grafana/dashboards/backend-overview.json` — one provisioned
    dashboard. Panels: request rate by URI, error rate by URI,
    p50/p95/p99 latency by URI, HikariCP active connections,
    HikariCP pending connections, JVM heap used, JVM GC pause time
    (rate), four business-timer p95 panels (fanout / read / create /
    follow). Dashboard is committed as JSON so it is reviewable in
    PR diffs.
- **docker-compose.yml** gains two services under
  `profiles: [observability]`:
  - `prometheus` — image `prom/prometheus:v2.55.1`, mounts
    `./infra/observability/prometheus/prometheus.yml`, port
    `9090:9090`.
  - `grafana` — image `grafana/grafana:11.2.0`, mounts
    `./infra/observability/grafana/provisioning` and
    `./infra/observability/grafana/dashboards`, port `3000:3000`,
    env `GF_AUTH_ANONYMOUS_ENABLED=true` and
    `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer` so the local dev loop does
    not need a login (production would NOT do this).
- **Backend — `MetricsActuatorIT.java`** new Testcontainers IT
  proving:
  - `GET /actuator/prometheus` without an `Authorization` header
    returns `200`;
  - the response body (Prometheus text format) contains each of
    these metric family names: `http_server_requests_seconds_count`,
    `hikaricp_connections_active`, `jvm_memory_used_bytes`,
    `feed_fanout_duration_seconds_count`,
    `feed_read_duration_seconds_count`,
    `posts_create_duration_seconds_count`,
    `follows_follow_duration_seconds_count`;
  - the response body contains the common tags
    (`application="prod-ready-social-media-backend"`,
    `service="backend"`) on at least one emitted line;
  - `GET /actuator/env` returns `401` (proves the allowlist is
    narrow and didn't accidentally open every Actuator endpoint);
  - hitting an authenticated controller endpoint (any seeded
    fixture call) increments
    `http_server_requests_seconds_count{uri="<that-uri>",method="<verb>",status="2xx-or-4xx"}`
    by exactly 1.
- **README.md** gains a **Local observability** section with the
  `docker-compose --profile observability up` invocation, the
  Grafana URL (http://localhost:3000), and the Prometheus URL
  (http://localhost:9090). Notes that the default Grafana view is
  anonymous (viewer-only) and points at the provisioned `Backend
  overview` dashboard.

### Explicit non-goals (deferred to follow-ups)

- **Structured JSON logs and MDC correlation fields.** Logs continue
  to render in their current Logback-default text shape. Slice 2 of
  observability owns the conversion to JSON + the `trace_id` field.
- **Distributed tracing.** No OpenTelemetry agent, no Tempo, no
  trace IDs anywhere. Slice 3 wires the agent and the trace
  backend.
- **Alerting.** Prometheus's Alertmanager is not wired. Dashboards
  for human eyeballs only. A future change owns SLOs and alerts.
- **Separate management port.** A real production deploy would run
  Actuator on `management.server.port=8081` so the public
  load-balancer cannot reach `/actuator/prometheus`. For slice 1 we
  keep one port and rely on the allowlist; the trade-off is
  recorded in `design.md` Decision 6 as known follow-up work.
- **Auth on `/actuator/prometheus`**. The endpoint is allowlisted
  (anonymous). Production would gate this with basic auth or a
  cloud network rule. Recorded as a known follow-up.
- **Loki, log aggregation, or any log shipping.** Logs stay on
  stdout. Slice 2 only changes the *shape* of those log lines, not
  where they go.
- **Frontend metrics, web-vitals, RUM.** The React app emits
  nothing observability-related. A separate later change could add
  browser-side telemetry.
- **Custom business KPIs.** No "daily-active-users" counter, no
  "posts-created-per-minute" gauge in this slice. The four
  `@Timed` annotations are *latency* timers (which also carry a
  count). Business KPI counters are a future change once we know
  what to measure.
- **Load test / Gatling / k6.** The dashboards will be flat in
  local dev because nothing generates synthetic traffic. The point
  of this slice is the plumbing.
- **Pre-aggregated SLO / error-budget panels.** No SLI definitions,
  no burn-rate alerts. Future work.
- **CI scraping or assertions on metrics during CI.** The existing
  Testcontainers IT proves the wiring; no Prometheus or Grafana
  runs in CI.

## Capabilities

### New Capabilities

- `observability` — the operational-telemetry capability. Owns the
  `/actuator/prometheus` endpoint, the four custom business
  timers, the `infra/observability/` Prometheus + Grafana
  provisioning, the `docker-compose` observability profile, the
  README run instructions, and the metrics-actuator integration
  test. Slices 2 and 3 (structured logs, distributed tracing) will
  extend this same capability with `MODIFIED` and `ADDED`
  requirements when they land.

### Modified Capabilities

- `user-accounts` — the deny-by-default `SecurityFilterChain`
  allowlist gains exactly one new entry: `GET /actuator/prometheus`.
  The literal list enumerated in the existing requirement is
  updated accordingly. The "allowlist is explicit, not derived"
  scenario is unchanged. No new code paths in `user-accounts/`
  beyond the one-line allowlist addition.

### Touched-but-not-modified Capabilities (cited for clarity)

- `posts`, `follows`, `feed` — gain a `@Timed` annotation each on
  their respective service classes. No public contract, no test
  semantics, and no HTTP behaviour changes. The annotation is a
  cross-cutting observability concern, not a feature requirement
  on those capabilities.
- `api-contract` — `/actuator/prometheus` is not part of the
  OpenAPI document (Actuator endpoints are deliberately excluded
  from springdoc-openapi by default). `openapi/openapi.json` does
  not regenerate.
- `ci`, `e2e`, `frontend-scaffold`, `frontend-styling`,
  `monorepo-layout`, `backend-scaffold` — no changes.

## Impact

- **Backend:**
  - Modified: `backend/gradle/libs.versions.toml` — add
    `micrometer-registry-prometheus` library coordinate (no version
    pin; managed by Spring Boot's BOM).
  - Modified: `backend/build.gradle.kts` — add the new dependency.
  - Modified: `backend/src/main/resources/application.yaml` —
    `management.endpoints.web.exposure.include` extended to
    `health,info,prometheus`; `management.metrics.tags.*` block
    added.
  - New: `backend/src/main/java/com/prodready/social/observability/MetricsConfig.java`
    — registers `TimedAspect`.
  - Modified: `backend/src/main/java/com/prodready/social/feed/FeedFanoutService.java`
    — each of the four public methods carries `@Timed("feed.fanout.duration")`.
  - Modified: `backend/src/main/java/com/prodready/social/feed/FeedService.java`
    — `findPage` carries `@Timed("feed.read.duration")`.
  - Modified: `backend/src/main/java/com/prodready/social/posts/PostService.java`
    — `create` carries `@Timed("posts.create.duration")`.
  - Modified: `backend/src/main/java/com/prodready/social/follows/FollowService.java`
    — `follow` carries `@Timed("follows.follow.duration")`.
  - Modified: `backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`
    — `PERMIT_ALL_GETS` array gains `/actuator/prometheus` (and
    `/actuator/info` is added at the same time to match the
    extended `exposure.include`).
  - New: `backend/src/test/java/com/prodready/social/observability/MetricsActuatorIT.java`.
- **Infra:**
  - New: `infra/observability/prometheus/prometheus.yml`.
  - New: `infra/observability/grafana/provisioning/datasources/prometheus.yaml`.
  - New: `infra/observability/grafana/provisioning/dashboards/dashboards.yaml`.
  - New: `infra/observability/grafana/dashboards/backend-overview.json`.
- **docker-compose.yml** at repo root — two new services
  (`prometheus`, `grafana`) under `profiles: ["observability"]`.
  The existing `postgres` service is unchanged.
- **README.md** at repo root — new "Local observability" section.
- **OpenSpec specs:**
  - New: `openspec/specs/observability/spec.md` (at archive time).
  - Modified: `openspec/specs/user-accounts/spec.md` — allowlist
    literal list extended by one entry.
- **CI:** No new jobs. The existing backend IT job picks up the new
  `MetricsActuatorIT` automatically.
- **Database:** No migrations. No schema changes.
- **Dependencies:** One new library
  (`io.micrometer:micrometer-registry-prometheus`, version managed
  by Spring Boot's BOM); two new Docker images
  (`prom/prometheus:v2.55.1`, `grafana/grafana:11.2.0`) pulled only
  when the observability compose profile is activated.
- **Frontend / e2e:** No changes.
