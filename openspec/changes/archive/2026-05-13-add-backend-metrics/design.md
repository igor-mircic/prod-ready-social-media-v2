## Context

Code state verified against the tree at change-draft time:

- `backend/build.gradle.kts` already declares
  `implementation(libs.spring.boot.starter.actuator)`. The Actuator
  starter is loaded; what is missing is a *registry* binding that
  translates Micrometer's in-memory meters into a scrape format.
- `backend/src/main/resources/application.yaml` already declares
  `management.endpoints.web.exposure.include: health,info` and
  `management.endpoint.health.show-details: never`. The change
  extends `exposure.include` to also include `prometheus` and adds
  a `management.metrics.tags` block.
- `backend/gradle/libs.versions.toml` uses a flat version catalog;
  Spring-managed deps have no version pin. The new
  `micrometer-registry-prometheus` library follows the same
  convention.
- `backend/src/main/java/com/prodready/social/useraccounts/SecurityConfig.java`
  enumerates the allowlist as two `String[]` constants
  (`PERMIT_ALL_POSTS`, `PERMIT_ALL_GETS`) consumed by a literal
  loop. `GET /actuator/health` is already in `PERMIT_ALL_GETS`.
  Adding `/actuator/prometheus` is one line. The literal-list
  convention is itself a `user-accounts` requirement (see Decision
  6).
- `backend/src/main/java/com/prodready/social/feed/FeedFanoutService.java`
  is `@Service @Transactional(propagation = MANDATORY)` at the class
  level with four public methods (`onPostCreated`, `onPostDeleted`,
  `onFollow`, `onUnfollow`). `@Timed` at the class level is the
  cleanest annotation site.
- `backend/src/main/java/com/prodready/social/feed/FeedService.java`
  exposes `findPage(...)` as its sole public entry point.
- `backend/src/main/java/com/prodready/social/posts/PostService.java`
  exposes `create(...)` and `delete(...)`; only `create` is timed in
  this slice (delete is fast and uncritical).
- `backend/src/main/java/com/prodready/social/follows/FollowService.java`
  exposes `follow(...)`, `unfollow(...)`, `getFollowStats(...)`; only
  `follow` is timed in this slice (`follow` carries the backfill
  cost, the others do not).
- `docker-compose.yml` at the repo root currently declares only the
  `postgres` service. There are no `profiles:` blocks anywhere in
  the file; this change introduces the convention.
- `README.md` reserves `infra/` for "Infrastructure-as-code (added
  by a future scaffold change)". `infra/observability/` is the
  first occupant.
- The existing `*IT.java` integration tests under
  `backend/src/test/java/com/prodready/social/` follow a consistent
  Testcontainers-Postgres + full-Spring-context pattern with a base
  class (see `FeedControllerIT`, `PostsControllerIT`,
  `FollowsControllerIT` for the shape). `MetricsActuatorIT` will
  follow the same pattern.

## Goals / Non-Goals

**Goals:**

- Ship the metrics pillar of observability — Micrometer +
  Prometheus + Grafana — with one provisioned dashboard that
  renders RED metrics on every controller plus four hand-
  instrumented business timers.
- Add no behaviour change to any HTTP endpoint, no new database
  migration, and no frontend change.
- Make the slice self-contained: a developer can run
  `docker-compose --profile observability up`, drive any HTTP
  traffic against the backend, and see numbers move on the
  dashboard within one scrape interval.
- Establish the `infra/observability/` directory as the home for
  observability provisioning so slices 2 and 3 have an obvious
  place to land.
- Establish the `docker-compose --profile observability` pattern
  so slices 2 and 3 can extend the same opt-in surface.

**Non-goals:**

- Structured JSON logs (slice 2).
- Distributed tracing or any OpenTelemetry agent (slice 3).
- Alerting, SLOs, or burn-rate panels.
- A separate management port for Actuator.
- Production-grade auth on `/actuator/prometheus`.
- Log shipping to Loki or any sink.
- Frontend telemetry / RUM / web-vitals.
- A load-test harness to populate the dashboards with realistic
  traffic.

## Decisions

### 1. Three sequenced changes, not one big "observability" change

Reasoning: each pillar (metrics / logs / traces) is independently
reviewable, independently testable, and independently valuable.
Metrics is the bedrock — both downstream pillars dashboard *against*
Grafana and Prometheus once they exist. Bundling all three would
make for a ~10–15-file PR touching the build, the security chain,
Logback, an OTel agent, and a third-party trace backend
simultaneously — a review surface where mistakes hide. The
sequenced approach also lets a future reader read the three change
proposals in order to understand the design evolution.

### 2. Pull-based Prometheus over push-based OTLP for metrics

The two industry-standard options:

- **Pull (Prometheus scrape)**: app exposes `/actuator/prometheus`;
  Prometheus polls every N seconds. Default Spring Boot integration.
  Zero collector required.
- **Push (OTLP)**: app exports metrics over OTLP to a collector
  which forwards to a backend. More modern; unified pipeline with
  traces.

We choose pull. Reasoning: the Spring Boot integration is
out-of-the-box turnkey; the collector becomes necessary for traces
in slice 3 anyway, but having it on the *metrics* path on day one
is one more moving part without a corresponding win. The Grafana
dashboards do not see the wire protocol and would render the same
panels off either source. If a deploy target ever demands OTLP-only
metrics, this is a swap of `micrometer-registry-prometheus` for
`opentelemetry-micrometer` and a re-pointing of Prometheus's data
source — the dashboards survive.

### 3. OTel agent and Tempo deferred to slice 3

Slice 1 ships nothing OTel-related. The `-javaagent:` flag, the
trace exporter config, the Tempo container, and the trace-to-log
correlation link in Grafana all land together in slice 3 because
they only make sense together.

### 4. Custom `@Timed` annotations on four hot paths only

The four chosen sites:

| Site                                      | Why                                                                                                                        |
|-------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `FeedFanoutService.{onPostCreated,onPostDeleted,onFollow,onUnfollow}` | Synchronous fanout is the trapdoor decision documented in `add-home-feed`; this latency is the metric that proves whether it stays sync or has to go async. |
| `FeedService.findPage`                    | The home-feed read is the busiest read path; the keyset query's index-only plan needs an observable latency.               |
| `PostService.create`                      | The composer's user-facing latency; bounds the fanout latency from above.                                                  |
| `FollowService.follow`                    | Carries the backfill cap-100 cost; everything else in follows is O(1).                                                     |

Sites *not* chosen: `PostService.delete`, `FollowService.unfollow`,
`FollowService.getFollowStats`, `AuthTokenService.*`,
`LoginService.*`, `SignupService.*`. These are uncritical or already
covered by HTTP-server timing. Adding more annotations is cheap but
adds reviewable surface area; the listed four are the deliberate
"first dashboard panels."

### 5. No high-cardinality tags. Ever.

The most common production observability incident is a developer
adding `userId` (or similar unbounded id) as a Micrometer tag, then
discovering Prometheus has 12 GB of in-memory series and the OOM
killer is unhappy. This change:

- uses only `@Timed("…")` *without* any `extraTags` block;
- relies on auto-instrumentation's bounded `uri` / `method` /
  `status` tags on HTTP metrics (Spring auto-maps `/api/v1/users/{userId}`
  to the literal template, NOT the resolved id);
- the four custom timers are tagged only by class + method (implicit
  from the timer name), nothing per-request.

The `MetricsActuatorIT` does not assert this directly (it's a
negative property), but the design note + code review enforce it.
Slice 2 / 3 will inherit the rule.

### 6. Actuator stays on the main port; allowlist additions are explicit

Production-shape would run Actuator on a separate management port
(`management.server.port=8081`) so the public load balancer cannot
route to `/actuator/prometheus` or `/actuator/health` at all. We
deliberately do not do this in slice 1 because:

- a separate port adds two configurations (one for prod, one for
  local-dev where the dev wants `:8080` to serve everything);
- the local Prometheus and the local backend both run on the host
  loopback, so a second port is friction with no security gain in
  the local-dev profile we're shipping;
- the `user-accounts` capability already pins an "explicit
  allowlist" requirement — adding `/actuator/prometheus` to that
  list is the right *spec-level* action, and the literal one-line
  change is auditable in PR diff.

The trade-off is recorded as a known follow-up. A future "harden
backend for deployment" change will introduce the management-port
split and remove the actuator allowlist entries.

### 7. `infra/observability/` directory, not `observability/` at repo root

`README.md` explicitly reserves `infra/` and explains the
"reserved directories are not pre-created" convention. This change
creates `infra/observability/` and fills the reservation
*usefully* — a Prometheus config, Grafana provisioning, and a JSON
dashboard are exactly the kind of declarative IaC-adjacent content
the README anticipated. Future changes that add Terraform / Pulumi
can land in `infra/iac/`, and a future helm-chart change can land
in `infra/helm/`. Each sub-directory under `infra/` describes a
different infrastructure concern.

### 8. Profile-gated docker-compose, default off

`docker-compose --profile observability up` is the opt-in. The
default `docker-compose up` continues to start *only* `postgres`,
matching what the existing README documents. Reasoning: many local
dev flows (frontend tweaking, e2e harness boot) do not need
Prometheus and Grafana. Forcing them on by default would burn
~200 MB of host RAM and ~15s of startup time per dev session for
zero gain.

A consequence: the `prometheus` service's scrape target is
`host.docker.internal:8080`, **not** `backend:8080`, because the
backend runs on the host (Gradle bootRun) in local dev — the
backend is not (yet) containerised. If a future change containerises
the backend, this scrape target moves into the same compose
network.

### 9. Anonymous viewer access in Grafana for local dev

`GF_AUTH_ANONYMOUS_ENABLED=true` + `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer`
means a dev hitting http://localhost:3000 lands directly on the
dashboard, no login. Production would never do this; the
proposal's non-goals list flags it. A future "harden observability
for deployment" change will swap to an OIDC or
basic-auth gate.

### 10. One curated dashboard, not many

Slice 1 ships **one** dashboard: `Backend overview`. It carries:

- HTTP server panels (auto-instrumented):
  - request rate by `uri`, stacked area;
  - 4xx-rate by `uri`, stacked area;
  - 5xx-rate by `uri`, stacked area;
  - p50 / p95 / p99 duration by `uri`, line chart.
- DB pool panels (HikariCP auto-bound):
  - active connections gauge;
  - idle connections gauge;
  - pending threads gauge (the saturation alarm in disguise).
- JVM panels:
  - heap used (area, split by pool);
  - GC pause time rate;
  - thread count.
- Custom business-timer panels:
  - p95 duration of `feed.fanout.duration`;
  - p95 duration of `feed.read.duration`;
  - p95 duration of `posts.create.duration`;
  - p95 duration of `follows.follow.duration`.

Rationale: one well-thought-out dashboard is more useful than five
half-thought-out ones. Future changes can split (e.g. a dedicated
"feed-fanout deep-dive" dashboard when slice 3's traces give us
spans to dig into).

### 11. Test approach: a single Testcontainers IT, not unit-level mocking

`MetricsActuatorIT.java` boots the full Spring context against a
Testcontainers Postgres (the same shape as every other `*IT.java` in
the repo) and:

- asserts `/actuator/prometheus` returns 200 unauthenticated;
- asserts the expected metric *families* are present in the
  scrape body (we assert names, not values, to keep the test
  hermetic);
- drives one authenticated HTTP call, then re-scrapes, and asserts
  the corresponding `http_server_requests_seconds_count` increased
  by 1;
- asserts `/actuator/env` returns 401 (allowlist is narrow).

We avoid Mockito-mocking the MeterRegistry. Mocked tests would
prove only "we called increment()" — they would NOT prove the
endpoint actually responds in the Prometheus text format, that
the allowlist is correctly extended, or that the `@Timed`
annotation is wired (which silently no-ops without
`TimedAspect`). An IT is the only way to prove the integration.

### 12. README updates kept narrow

The README's existing "Local development" section already
documents `docker-compose up -d postgres`. The new "Local
observability" section adds the profile-up command and the two
URLs, and points readers at the provisioned dashboard. We do NOT
duplicate the prometheus or grafana config — the YAML/JSON in
`infra/observability/` is the source of truth.

## Risks / Trade-offs

- **The `@Timed` annotation silently does nothing without
  `TimedAspect`.** This is the single most-likely review miss.
  `MetricsConfig` registering the aspect bean is named explicitly in
  the tasks. The IT proves the wiring (the
  `feed_fanout_duration_seconds_count` family must appear after a
  driven HTTP call). If it doesn't, the test fails loudly.
- **Anonymous Grafana is fine for local dev, dangerous in prod.**
  Documented as non-goal and as a known follow-up in this design.
- **`host.docker.internal` is Mac/Windows-Docker-Desktop-specific.**
  Linux Docker handles this differently. The proposal targets the
  user's Mac dev environment (verified from the
  `/Users/igor/...` working-directory shape). The Prometheus config
  will include a comment documenting how a Linux user would
  override (`extra_hosts: ["host.docker.internal:host-gateway"]` on
  the prometheus service, or `network_mode: host`). Documented for
  the local dev loop; not a portability blocker.
- **Adding `@Timed` to four hot-path services adds a tiny per-call
  overhead.** Micrometer's `Timer` is on the order of low hundreds
  of nanoseconds per call. At this scale, immaterial. Worth
  acknowledging because future slices may instrument tighter loops
  where the overhead is non-trivial.
- **Grafana's provisioning format evolves.** Pinning
  `grafana/grafana:11.2.0` (not `:latest`) means a Grafana upgrade
  is a deliberate change, not an accidental break.
- **Dashboard JSON is verbose and review-noisy.** A 600-line JSON
  file lands in PR diff. This is the trade-off for dashboards-as-
  code — the upside (no clickops, the dashboard is reproducible) is
  worth it. Reviewers should skim, not line-read, the dashboard
  JSON.

## Open questions

None blocking. Two minor judgement calls that the implementation
can settle without spec ambiguity:

- Whether to also expose `/actuator/health/liveness` and
  `/actuator/health/readiness` probes. These are turn-key in Spring
  Boot. Default decision: leave as-is in slice 1 (health is already
  exposed); add liveness / readiness in a future "harden for
  deployment" change.
- Whether to also bind the `processor.UptimeMetrics` and
  `processor.ProcessorMetrics` Micrometer binders explicitly. They
  are on by default in current Spring Boot, but a future Spring
  upgrade could change defaults. Default decision: rely on the
  defaults; if `process_cpu_usage` is missing from the IT
  assertion, pin the binders.
