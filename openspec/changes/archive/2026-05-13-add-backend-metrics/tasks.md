## 1. Backend: add Micrometer Prometheus registry

- [x] 1.1 Add `micrometer-registry-prometheus = { module = "io.micrometer:micrometer-registry-prometheus" }` to `backend/gradle/libs.versions.toml` under `[libraries]`. Do NOT pin a version — Spring Boot's BOM manages it.
- [x] 1.2 Add `implementation(libs.micrometer.registry.prometheus)` to `backend/build.gradle.kts` next to the existing `libs.spring.boot.starter.actuator` line.
- [x] 1.3 Run `./gradlew :backend:dependencies --configuration runtimeClasspath | grep micrometer` and confirm `micrometer-registry-prometheus` appears with a resolved version.

## 2. Backend: extend `application.yaml`

- [x] 2.1 Edit `backend/src/main/resources/application.yaml`'s `management:` block. Change `endpoints.web.exposure.include: health,info` to `endpoints.web.exposure.include: health,info,prometheus`.
- [x] 2.2 Add a `management.metrics.tags:` block declaring exactly two tags: `application: prod-ready-social-media-backend` and `service: backend`.
- [x] 2.3 Leave `management.endpoint.health.show-details: never` unchanged. Do NOT enable `show-details: always` (it leaks DB / disk info to anonymous callers given the existing allowlist).
- [x] 2.4 Sanity-check by running `./gradlew :backend:bootRun` (with Postgres up) and `curl -s http://localhost:8080/actuator/prometheus | head -40` returns Prometheus text format and contains lines tagged `application="prod-ready-social-media-backend"` and `service="backend"`.

## 3. Backend: `observability/MetricsConfig.java` — register `TimedAspect`

- [x] 3.1 Create new package `backend/src/main/java/com/prodready/social/observability/`.
- [x] 3.2 Create `observability/MetricsConfig.java` annotated `@Configuration`. Declare a `@Bean public TimedAspect timedAspect(MeterRegistry registry) { return new TimedAspect(registry); }`. Without this bean, every `@Timed` annotation in tasks 4–7 is silently a no-op — this is the single most common metrics-wiring gotcha.
- [x] 3.3 No other beans in this class. Common tags from task 2.2 are picked up automatically by Micrometer's auto-config; do NOT add a `MeterRegistryCustomizer` for them.

## 4. Backend: `@Timed` on `FeedFanoutService`

- [x] 4.1 Open `backend/src/main/java/com/prodready/social/feed/FeedFanoutService.java`. Add `@Timed("feed.fanout.duration")` at the class level (alongside the existing `@Service` and `@Transactional` annotations).
- [x] 4.2 Add the import for `io.micrometer.core.annotation.Timed`.
- [x] 4.3 Confirm by reading the class: all four public methods (`onPostCreated`, `onPostDeleted`, `onFollow`, `onUnfollow`) inherit the class-level annotation — no per-method annotation needed.
- [x] 4.4 Do NOT pass an `extraTags = {...}` array. The default timer carries only `class` / `method` / `exception` tags — all bounded.

## 5. Backend: `@Timed` on `FeedService.findPage`

- [x] 5.1 Open `backend/src/main/java/com/prodready/social/feed/FeedService.java`. Add `@Timed("feed.read.duration")` at the method level on `findPage(...)`.
- [x] 5.2 Add the import for `io.micrometer.core.annotation.Timed`.

## 6. Backend: `@Timed` on `PostService.create`

- [x] 6.1 Open `backend/src/main/java/com/prodready/social/posts/PostService.java`. Add `@Timed("posts.create.duration")` at the method level on `create(...)`. Leave `delete(...)` un-timed in this slice.
- [x] 6.2 Add the import for `io.micrometer.core.annotation.Timed`.

## 7. Backend: `@Timed` on `FollowService.follow`

- [x] 7.1 Open `backend/src/main/java/com/prodready/social/follows/FollowService.java`. Add `@Timed("follows.follow.duration")` at the method level on `follow(...)`. Leave `unfollow(...)` and `getFollowStats(...)` un-timed in this slice.
- [x] 7.2 Add the import for `io.micrometer.core.annotation.Timed`.

## 8. Backend: `SecurityConfig` allowlist additions

- [x] 8.1 Open `backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`. Add the two strings `"/actuator/info"` and `"/actuator/prometheus"` to the `PERMIT_ALL_GETS` array literal, in alphabetical order alongside the existing `"/actuator/health"`.
- [x] 8.2 Do NOT add any other Actuator endpoint. Verify `/actuator/env`, `/actuator/beans`, `/actuator/loggers` etc. are NOT in the array.
- [x] 8.3 The class-level Javadoc comment explaining CSRF disablement is unchanged. Optionally add a one-line `// TODO(prod): in production, run actuator on management.server.port and remove these allowlist entries.` near the new entries — this records Decision 6 from `design.md` at the code site.

## 9. Backend: integration test `MetricsActuatorIT`

- [x] 9.1 Create `backend/src/test/java/com/prodready/social/observability/MetricsActuatorIT.java` following the existing `*IT.java` shape (`@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)`, `@Testcontainers`, Postgres container, `TestRestTemplate` or `WebTestClient` for HTTP).
- [x] 9.2 Test `prometheusEndpoint_unauthenticated_returns200`: a GET to `/actuator/prometheus` with no `Authorization` header returns HTTP 200 and `Content-Type` starts with `text/plain` (Prometheus text format).
- [x] 9.3 Test `prometheusEndpoint_exposesExpectedMetricFamilies`: the scrape body contains each of these metric names (substring match is sufficient): `http_server_requests_seconds_count`, `hikaricp_connections_active`, `jvm_memory_used_bytes`, `feed_fanout_duration_seconds_count`, `feed_read_duration_seconds_count`, `posts_create_duration_seconds_count`, `follows_follow_duration_seconds_count`.
- [x] 9.4 Test `prometheusEndpoint_emitsCommonTags`: the scrape body contains at least one line with `application="prod-ready-social-media-backend"` AND at least one line with `service="backend"`.
- [x] 9.5 Test `actuatorEnv_unauthenticated_returns401`: a GET to `/actuator/env` with no `Authorization` header returns HTTP 401. This proves the allowlist did not over-open.
- [x] 9.6 Test `httpServerRequestsCounter_incrementsOnControllerCall`: (a) signup + login a user via the existing test helpers to get a bearer token; (b) scrape `/actuator/prometheus`, parse out the current value of `http_server_requests_seconds_count{uri="/api/v1/auth/me",method="GET",...}`; (c) call `GET /api/v1/auth/me` with the bearer token; (d) re-scrape; (e) assert the counter value is now strictly greater than the snapshotted value. Use `/api/v1/auth/me` because it is cheap and idempotent.
- [x] 9.7 Test `feedFanoutDurationTimer_recordsOnFanout`: (a) signup + login two users (Alice and Bob) via test helpers, get Alice's bearer token; (b) Alice calls `POST /api/v1/posts` with a non-empty body (this triggers `FeedFanoutService.onPostCreated` via the existing post-create flow); (c) scrape `/actuator/prometheus`; (d) assert `feed_fanout_duration_seconds_count` is at least 1 (the `@Timed` annotation fired). This is the smoke proof that `TimedAspect` from task 3 is correctly wired.

## 10. Infra: `infra/observability/` directory

- [x] 10.1 Create directory `infra/observability/prometheus/`. Inside, create `prometheus.yml` with one scrape job `backend` targeting `host.docker.internal:8080`, metrics path `/actuator/prometheus`, scrape interval `15s`. Include a `# NOTE:` comment block documenting the Linux-host override (`extra_hosts: ["host.docker.internal:host-gateway"]` on the prometheus service, or `network_mode: host`).
- [x] 10.2 Create directory `infra/observability/grafana/provisioning/datasources/`. Inside, create `prometheus.yaml` declaring `apiVersion: 1` and one datasource named `Prometheus` of type `prometheus`, URL `http://prometheus:9090`, set as `isDefault: true`, with `editable: false` (provisioned datasources should not be editable from the UI to avoid drift between repo and runtime).
- [x] 10.3 Create directory `infra/observability/grafana/provisioning/dashboards/`. Inside, create `dashboards.yaml` declaring `apiVersion: 1` and one provider named `default` of type `file`, pointing at the mounted path `/etc/grafana/dashboards` with `updateIntervalSeconds: 30` and `allowUiUpdates: false`.
- [x] 10.4 Create directory `infra/observability/grafana/dashboards/`. Inside, create `backend-overview.json` — the one provisioned dashboard. Panels (each panel a PromQL query):
  - **Request rate by URI** — `sum(rate(http_server_requests_seconds_count[1m])) by (uri)` as a stacked area.
  - **4xx rate by URI** — `sum(rate(http_server_requests_seconds_count{status=~"4.."}[1m])) by (uri)`.
  - **5xx rate by URI** — `sum(rate(http_server_requests_seconds_count{status=~"5.."}[1m])) by (uri)`.
  - **p50 / p95 / p99 latency by URI** — three lines: `histogram_quantile(0.50, sum(rate(http_server_requests_seconds_bucket[1m])) by (le, uri))`, same for 0.95, same for 0.99.
  - **HikariCP active** — `hikaricp_connections_active`.
  - **HikariCP idle** — `hikaricp_connections_idle`.
  - **HikariCP pending** — `hikaricp_connections_pending` (the saturation alarm).
  - **JVM heap used** — `sum(jvm_memory_used_bytes{area="heap"}) by (id)` stacked.
  - **JVM GC pause** — `rate(jvm_gc_pause_seconds_sum[1m]) / rate(jvm_gc_pause_seconds_count[1m])`.
  - **Feed fanout p95** — `histogram_quantile(0.95, sum(rate(feed_fanout_duration_seconds_bucket[5m])) by (le))`.
  - **Feed read p95** — same shape for `feed_read_duration_seconds_bucket`.
  - **Post create p95** — same shape for `posts_create_duration_seconds_bucket`.
  - **Follow p95** — same shape for `follows_follow_duration_seconds_bucket`.
  Use Grafana 11.x JSON schema. Pin `"schemaVersion"` to the value Grafana 11.2 emits when exporting (the implementer should hand-author or export once via clickops, then commit the JSON).
- [x] 10.5 No PromQL query in the dashboard SHALL reference any high-cardinality label (e.g. `userId`, `post_id`, `email`). Every `by (...)` clause restricts to bounded label sets only (`uri`, `method`, `status`, `area`, `id` from HikariCP / JVM, `le` for histograms).

## 11. `docker-compose.yml` — observability profile

- [x] 11.1 Edit `docker-compose.yml` at the repo root. Leave the existing `postgres` service definition and `postgres-data` volume unchanged.
- [x] 11.2 Add a new service `prometheus`:
  - `image: prom/prometheus:v2.55.1`
  - `container_name: social-prometheus`
  - `profiles: ["observability"]`
  - `ports: ["9090:9090"]`
  - `volumes: ["./infra/observability/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]`
  - On macOS (the target dev environment) `host.docker.internal` resolves automatically; on Linux the operator must add `extra_hosts: ["host.docker.internal:host-gateway"]` (documented in `prometheus.yml` per task 10.1).
- [x] 11.3 Add a new service `grafana`:
  - `image: grafana/grafana:11.2.0`
  - `container_name: social-grafana`
  - `profiles: ["observability"]`
  - `ports: ["3000:3000"]`
  - `environment:` `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`, `GF_USERS_DEFAULT_THEME=light`
  - `volumes:`
    - `./infra/observability/grafana/provisioning:/etc/grafana/provisioning:ro`
    - `./infra/observability/grafana/dashboards:/etc/grafana/dashboards:ro`
  - `depends_on: [prometheus]`
- [x] 11.4 Add a top-of-file comment block listing the new opt-in invocation: `# docker-compose --profile observability up -d prometheus grafana`.
- [x] 11.5 Confirm `docker-compose up -d postgres` (no profile) still starts only `postgres`. Confirm `docker-compose --profile observability up -d` starts all three (`postgres` + `prometheus` + `grafana`).

## 12. README: Local observability section

- [x] 12.1 Add a new H2 section `## Local observability` to `README.md` after the existing `## Posting locally` section and before `## Prerequisites`.
- [x] 12.2 Section contents: a one-line motivation; the invocation `docker-compose --profile observability up -d prometheus grafana`; the Grafana URL `http://localhost:3000` and a note that the default landing dashboard is `Backend overview`; the Prometheus URL `http://localhost:9090`; a one-line statement that anonymous viewer access is local-dev only.
- [x] 12.3 No screenshots. Pure text instructions; the reviewer will pull the change and verify locally.

## 13. End-to-end smoke verification (manual, pre-PR)

- [x] 13.1 Boot dependencies: `docker-compose --profile observability up -d` (this brings `postgres` + `prometheus` + `grafana`).
- [x] 13.2 Boot backend: `./gradlew :backend:bootRun` in another terminal.
- [x] 13.3 Drive a handful of HTTP calls: signup a user, login, hit `/api/v1/auth/me` 10x, post 3 times, follow another user.
- [x] 13.4 Open http://localhost:9090/targets and confirm the `backend` job's target is `UP`.
- [x] 13.5 Run a PromQL query in Prometheus UI: `http_server_requests_seconds_count` — confirm rows return tagged with `application=prod-ready-social-media-backend` and `service=backend`.
- [x] 13.6 Open http://localhost:3000 — confirm anonymous landing, navigate to the `Backend overview` dashboard, confirm all panels render data (not "No data"). The feed fanout panel will be empty until step 13.3 triggers a fanout; the others should populate.
- [x] 13.7 Tear down: `docker-compose --profile observability down`.

## 14. Run automated checks before requesting review

- [x] 14.1 `./gradlew :backend:spotlessApply` — format any new Java files.
- [x] 14.2 `./gradlew :backend:test` — confirm the existing test suite still passes (no regressions) AND `MetricsActuatorIT` from task 9 passes.
- [x] 14.3 `openspec validate add-backend-metrics --strict` — confirm the proposal, design, tasks, and specs validate against the OpenSpec schema.
- [x] 14.4 `git diff --stat` — sanity-check the change touches only the files this proposal listed under `## Impact`. Anything else is scope creep and should be peeled out into a separate change.
