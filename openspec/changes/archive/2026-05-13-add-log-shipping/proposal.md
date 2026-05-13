# add-log-shipping

## Why

Slices 1 (metrics), 2 (logs), and 3 (traces) of observability are landed. Each
emits its pillar to a different surface — metrics scraped by Prometheus, logs
rendered to stdout, traces shipped by the OTel Java agent to Tempo — and each
slice forward-referenced this one. The practical consequences today:

- A reader looking at a JSON log line in their terminal can see a populated
  `trace.id` field, but cannot click on it. To pivot to the corresponding span
  tree they must copy the id, open Grafana, switch to Tempo, and paste. The
  reverse pivot (Tempo span → log lines for the same request) is impossible:
  Tempo has no log datasource to link to.
- The four `@Timed` business hot paths from slice 1 emit metric histograms and
  generate spans, but a Grafana operator who sees a p99 spike on
  `feed.fanout.duration` cannot follow that spike into the log lines that
  produced it. The three pillars sit unconnected.
- The slice-3 README's `### Distributed tracing` subsection literally ends with
  a forward-pointer: *"the auto 'click `trace.id` in a log line → jump to
  Tempo' link will land in the next observability slice (log shipping with
  Loki) once the log datasource is provisioned."* That forward-pointer is
  dangling.

This change introduces the fourth observability slice — **log shipping** — by
adding two new services under the existing `observability` docker-compose
profile: an **OpenTelemetry Collector** that consolidates trace and log
shipping, and **Loki** as the log store. After this change, every ECS JSON
log line the backend emits is queryable in Grafana's Loki datasource alongside
the Tempo span tree for the same `trace.id`, and Grafana's `tracesToLogs` /
`logsToTraces` provisioning makes both pivots a single click.

**Why introduce the Collector now and not in a future slice?** The slice-3
design.md recorded the deferral explicitly: *"Slice 4 (log shipping with
Loki) is the natural moment to introduce the collector, because at that point
we already need a process between the application and Loki and may as well
consolidate trace + log shipping."* Two payoffs compound:
(1) the Collector becomes the single production-real shipping point — every
future telemetry concern (tail sampling, redaction, fan-out to additional
backends, span filtering) has a home; and (2) the agent's OTLP destination
moves from `agent → Tempo direct` to `agent → Collector → Tempo`, which
matches what real production deploys look like. Recorded in `design.md`
Decision 1.

**Why have the backend write logs to a file rather than ship them from
stdout?** The backend runs on the host (slice 1 established
`host.docker.internal:8080` for the Prometheus scrape) — it is NOT in
docker-compose. So `docker logs` does not apply: the backend's stdout is
whatever terminal the developer launched `./gradlew bootRun` in, which the
Collector container cannot read. The remaining options are (a) the backend
ships logs over OTLP — but slice 3 explicitly set `OTEL_LOGS_EXPORTER=none`
and slice 2 owns log emission; (b) a TCP/syslog appender from Logback — but
that couples the application to a logging-collector network address; or (c)
a Spring Boot file appender writing the same ECS JSON to a host directory
the Collector bind-mounts. Option (c) preserves slice 2's
"one ECS JSON object per log event on stdout" requirement (the file is an
additive surface, not a replacement), keeps the application stdout-only at
its boundary, and mirrors the production-real k8s shape where the runtime
captures stdout into a file and a node-level agent tails it. The file
output is **env-var gated** so the default `bootRun` dev loop is unchanged.
Recorded in `design.md` Decision 2.

**Why does the agent OTLP endpoint stay at `http://localhost:4318`?** Slice 3
set this default. Slice 4 changes *which container* listens on host port 4318
— the Collector instead of Tempo — but the agent's `OTEL_EXPORTER_OTLP_*`
environment variables are unchanged. Tempo loses its host port binding and
becomes reachable only from inside the docker network (the Collector talks
to it as `tempo:4317`). This avoids adding a flag to the application
build, keeps `backend/build.gradle.kts` slice-3 env-var defaults intact, and
preserves the "fail quietly when observability stack is down" behaviour the
agent already has. Recorded in `design.md` Decision 3.

## What Changes

- **Backend — `application.yaml` gains an env-var-gated file appender** in ECS
  JSON format:
  - `logging.structured.format.file: ecs` (file output uses the same
    ECS formatter as the existing stdout output, so byte-identical JSON
    appears on both surfaces).
  - `logging.file.name: ${LOG_FILE_PATH:}` (an empty default — Spring Boot
    treats an empty `logging.file.name` as "no file output", so the
    default dev loop is unchanged; setting `LOG_FILE_PATH=...` turns on
    the file appender).
  - The file appender SHALL NOT introduce `logback-spring.xml` or
    `logback.xml` (the existing slice-2 prohibition is preserved).
- **Backend — new integration test
  `observability/LogFileOutputIT.java`** new Testcontainers IT that boots the
  full Spring context with `LOG_FILE_PATH` set to a temp file and asserts:
  - the file contains one ECS JSON object per log event, terminated by a
    newline, parseable as JSON;
  - the base ECS fields (`@timestamp`, `log.level`, `service.name`,
    `service.environment`, `process.thread.name`, `log.logger`, `message`,
    `ecs.version`) are present on every line in the file;
  - an authenticated request emits one `event.dataset=backend.access` line
    in the file carrying populated `request.id`, `user.id`, `trace.id`,
    and `span.id` fields (proves slice-2 and slice-3 correlation fields
    flow through to the file appender, not just stdout);
  - the same authenticated request emits an identical line on stdout (the
    file output is additive, not a replacement).
- **Infra — new `infra/observability/collector/` directory**:
  - `collector-config.yaml` — OTel Collector configuration declaring
    one OTLP receiver (gRPC `0.0.0.0:4317`, HTTP `0.0.0.0:4318`),
    one filelog receiver tailing `/var/log/backend/*.json`, two exporters
    (`otlp/tempo` to `tempo:4317`, `loki` to `http://loki:3100/loki/api/v1/push`),
    and two pipelines (`traces: [otlp] → [otlp/tempo]`,
    `logs: [filelog] → [loki]`).
- **Infra — new `infra/observability/loki/` directory**:
  - `loki-config.yaml` — single-binary Loki configuration with
    local-filesystem storage under `/loki`, retention disabled (this
    is local dev), HTTP API on `3100`. Inline comment marks the
    local-filesystem storage as a learning-project default and
    forward-references object-storage backends for production.
- **Infra —
  `infra/observability/grafana/provisioning/datasources/loki.yaml`** new
  Grafana datasource provisioning file declaring `Loki` of type `loki`
  at `http://loki:3100`, `editable: false`, `isDefault: false` (Prometheus
  remains default). Carries a `derivedFields` block that turns any
  `trace.id` value in a Loki log line into a clickable link to the Tempo
  datasource (`logsToTraces`).
- **Infra —
  `infra/observability/grafana/provisioning/datasources/tempo.yaml`** the
  slice-3 file is modified to add a `tracesToLogs` correlation block
  pointing at the new Loki datasource. The slice-3 inline comment
  forward-referencing this slice is removed.
- **docker-compose.yml** gains two new services under
  `profiles: ["observability"]`:
  - `collector` — image `otel/opentelemetry-collector-contrib:0.111.0`,
    mounts `./infra/observability/collector/collector-config.yaml` and
    `./infra/observability/logs:/var/log/backend:ro` (the host directory
    the backend's `LOG_FILE_PATH` points at), exposes host ports
    `4317:4317` and `4318:4318`, runs
    `--config=/etc/otelcol-contrib/config.yaml`.
  - `loki` — image `grafana/loki:3.2.0`, mounts
    `./infra/observability/loki/loki-config.yaml`, runs
    `-config.file=/etc/loki/local-config.yaml`. No host port binding
    (only reachable from inside the docker network — Grafana queries
    Loki as `http://loki:3100`).
  - The existing `tempo` service loses its `4317:4317` and `4318:4318`
    host port bindings (only the docker network sees Tempo now; the
    `3200:3200` HTTP API binding stays for direct curl debugging).
  - The existing `grafana` service's `depends_on` list gains `loki` and
    `collector` (in addition to the existing `prometheus` and `tempo`
    dependencies).
- **Infra — `Backend overview` dashboard gains a "Recent logs" panel** in
  `infra/observability/grafana/dashboards/backend-overview.json`. The
  panel is a Loki query of `{service_name="backend"} | json` in logs
  view, filtered to `event.dataset = "backend.access"`. Single panel;
  this slice is plumbing, not dashboard design.
- **README.md** gains a `### Log shipping` subsection under the existing
  `## Local observability` section, after the existing
  `### Distributed tracing` subsection. Documents:
  - that `docker-compose --profile observability up -d` now also brings
    up `collector` and `loki`,
  - that the backend ships logs by writing to
    `./infra/observability/logs/backend.json` (the developer must export
    `LOG_FILE_PATH=./infra/observability/logs/backend.json` before
    `./gradlew bootRun` to enable the file appender),
  - the `tracesToLogs` workflow: click a `trace.id` in a Tempo span tree
    → land on the Loki log lines for the same request,
  - the `logsToTraces` workflow: click a `trace.id` in a Loki log line
    → land on the Tempo span tree,
  - that the slice-3 "copy `trace.id` and paste into Tempo search"
    workflow still works but is no longer necessary.

### Explicit non-goals (deferred to follow-ups)

- **Frontend / RUM tracing.** The React app emits no OTel spans and no
  log lines into Loki. Browser-side tracing remains a future change.
- **Tail-based sampling, head-based sampling, or redaction.** The
  Collector now exists, which is where these would live — but this
  slice ships them at defaults (100% sampling, no redaction). A future
  change can add sampling configuration without changing the wire path.
- **Alerting on log patterns or metric thresholds.** Prometheus
  Alertmanager is still not wired. Loki's ruler is not wired. A future
  change owns the data → action loop.
- **Async MDC propagation** of the manual `request.id` / `user.id` keys
  across thread boundaries. Today everything still runs on the request
  thread (fanout-on-write is sync). The pre-existing async-MDC gap from
  slice 2 is **not** fixed here. The OTel agent already propagates
  `trace.id` / `span.id` across thread boundaries via OTel `Context`,
  so off-request log lines carry trace context correctly; only the
  manual keys would be missing.
- **Authentication on Loki or the Collector's OTLP receiver.** Both
  run anonymous (reachable only from the docker network and the
  developer's loopback). Production would gate this.
- **Log retention policy.** Loki runs with retention disabled — this
  is a learning project; a real deploy would set a retention period
  and ship to object storage.
- **CI assertion that log lines land in Loki.** The new IT proves
  the in-process surface (the backend writes ECS JSON to the file).
  Loki and the Collector are not run as Testcontainers — that is a
  manual smoke through the README run loop. This matches the
  slice-3 precedent ("no Tempo container in IT").
- **Splitting the Collector into a separate `agent → gateway` pair.**
  A single Collector handles both receiver and exporter roles in this
  slice. Production would split into per-host agents and a central
  gateway. Recorded as known follow-up.

## Capabilities

### Modified Capabilities

- `observability` — gains five new requirements (env-var-gated file
  appender on the backend, Collector provisioning and pipelines, Loki
  provisioning, Grafana datasource + correlation provisioning for both
  log↔trace pivot directions, README run loop, integration test). The
  existing slice-1 requirements (Prometheus scrape, Micrometer common
  tags, `TimedAspect`, business timers, dashboard / Prometheus / Grafana
  provisioning), slice-2 requirements (ECS JSON console format,
  request-id filter, user-context filter, access-log filter,
  observability web config, structured-log IT), and slice-3 requirements
  (OTel agent attachment and pinning, OTLP exporter wiring, MDC key
  reconciliation, Tempo provisioning, tracing IT) are touched only as
  noted in `design.md` Decision 3 (Tempo loses its host port binding).

### Touched-but-not-modified Capabilities (cited for clarity)

- `user-accounts` — Loki, the Collector, and the file appender are
  invisible to the security chain. No new endpoints exposed; no
  `SecurityFilterChain` allowlist changes; `SecurityConfig.java` is
  not touched by this slice.
- `posts`, `follows`, `feed`, `api-contract`, `frontend-scaffold`,
  `frontend-styling`, `monorepo-layout`, `backend-scaffold`, `ci`,
  `e2e` — no changes. The log content emitted by these capabilities
  is unchanged; only the surface to which it is shipped is extended.

## Impact

- **Backend:**
  - Modified: `backend/src/main/resources/application.yaml` — add
    `logging.structured.format.file: ecs` and
    `logging.file.name: ${LOG_FILE_PATH:}`.
  - New: `backend/src/test/java/com/prodready/social/observability/LogFileOutputIT.java`.
- **Infra:**
  - New: `infra/observability/collector/collector-config.yaml`.
  - New: `infra/observability/loki/loki-config.yaml`.
  - New: `infra/observability/logs/` — directory bind-mounted into
    the Collector; gitignored except for a `.gitkeep`.
  - New: `infra/observability/grafana/provisioning/datasources/loki.yaml`.
  - Modified:
    `infra/observability/grafana/provisioning/datasources/tempo.yaml`
    — add `tracesToLogs` correlation block; remove the slice-3
    forward-reference comment.
  - Modified: `infra/observability/grafana/dashboards/backend-overview.json`
    — add one "Recent logs" panel.
- **docker-compose.yml** at repo root — two new services
  (`collector`, `loki`) under `profiles: ["observability"]`; the
  existing `tempo` service loses its `4317:4317` and `4318:4318`
  host port bindings; the existing `grafana` service's `depends_on`
  list is extended to include `loki` and `collector`. The default
  `docker-compose up` invocation continues to start only `postgres`.
- **README.md** at repo root — new `### Log shipping` subsection
  under `## Local observability`.
- **`.gitignore`** at repo root — gains
  `infra/observability/logs/*.json` so a developer's local backend
  output does not leak into git.
- **OpenSpec specs:**
  - Modified at archive time: `openspec/specs/observability/spec.md` —
    five new requirements appended.
- **CI:** No new jobs. The existing backend IT job picks up
  `LogFileOutputIT` automatically.
- **Database:** No migrations. No schema changes.
- **Dependencies:**
  - Two new Docker images
    (`otel/opentelemetry-collector-contrib:0.111.0`,
    `grafana/loki:3.2.0`) pulled only when the observability compose
    profile is activated. No new application or test classpath
    dependencies.
- **Frontend / e2e:** No changes. The backend's stdout output is
  unchanged; the file appender is additive and env-var gated. When
  `e2e/` boots the backend JAR, `LOG_FILE_PATH` is unset and the
  file appender does not engage — e2e behaviour is byte-identical
  to today.
