## Context

Slices 1, 2, and 3 of observability landed three pillars — metrics, logs,
traces — on three different surfaces. Metrics are scraped from
`/actuator/prometheus`; logs render to stdout in ECS JSON; traces ship
from the OTel Java agent directly to Tempo over OTLP/HTTP. Each pillar
forward-referenced this slice as the moment at which logs would also be
shipped to a queryable store (Loki), and the slice-3 design.md explicitly
deferred the OpenTelemetry Collector to "the natural moment to consolidate
trace + log shipping."

The constraint that shapes most of the design: **the backend runs on the
host, not in docker-compose**. Slice 1 established
`host.docker.internal:8080` as the Prometheus scrape target precisely
because the backend lives outside compose (the dev loop is
`./gradlew bootRun` from the host shell). That decision is load-bearing
for daily development and is not revisited here. As a consequence:

- `docker logs <backend>` does not exist as a log source.
- Any in-compose service that wants to read backend logs must either
  receive them over the network (a coupling the application does not
  want) or read them from a host-mounted file (the option this slice
  picks).

The slice-3 environment variables on the OTel agent are unchanged in
production reality (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`).
The Collector takes over host port 4318 from Tempo, so the agent's view
of the world is unchanged — only the container behind the port changes.

## Goals / Non-Goals

**Goals:**

- Every backend ECS JSON log line is queryable in Grafana via Loki.
- A single `trace.id` value is the join key across logs and traces:
  - clicking a `trace.id` in a Tempo span view jumps to the matching
    Loki log lines (`tracesToLogs`);
  - clicking a `trace.id` in a Loki log line jumps to the matching
    Tempo span tree (`logsToTraces`).
- Introduce the OpenTelemetry Collector as the single production-real
  shipping point. Subsequent observability concerns (tail sampling,
  redaction, fan-out, span filtering) have a home without further
  re-plumbing.
- The default `./gradlew bootRun` dev loop is byte-identical to today:
  stdout-only logging, no surprise file output, no warnings about a
  Collector that is not running. Engaging the file appender is a
  conscious env-var opt-in.
- The slice-3 contract is preserved: no application-source dependency
  on `io.opentelemetry.*`, no `logback-spring.xml`, no parallel-emit
  via OTLP logs.

**Non-Goals:**

- Frontend / RUM tracing or browser-emitted log lines into Loki.
- Tail-based or head-based sampling — the Collector ships at 100% in
  both directions.
- Log redaction or PII filtering.
- Alerting (Alertmanager wiring, Loki ruler).
- Backfill of the slice-2 async MDC propagation gap for `request.id` /
  `user.id`.
- Splitting the Collector into a `agent → gateway` pair.
- Loki retention policy or object-storage backend.
- A CI assertion that log lines land in Loki (manual smoke only).
- Authentication on Loki or the Collector OTLP receiver.

## Decisions

### Decision 1: Introduce the OpenTelemetry Collector as the consolidation point

**Chosen:** Add one new `collector` service under the
`observability` docker-compose profile, using
`otel/opentelemetry-collector-contrib:0.111.0` (the contrib
distribution carries the `filelog` receiver and the `loki` exporter,
which the core distribution does not). The Collector exposes two
pipelines: `traces` (OTLP in → OTLP out to Tempo) and `logs`
(filelog in → Loki out). Host ports `4317:4317` (OTLP gRPC) and
`4318:4318` (OTLP HTTP) point at the Collector.

**Alternative A: keep the agent direct, ship logs via Promtail or
Alloy.** Two parallel shipping paths, two separate config surfaces,
no consolidation point for future cross-cutting concerns (sampling,
redaction). Promtail is end-of-life per Grafana; Alloy is the
forward-looking pick, but it has no story for receiving OTLP traces,
so traces would still need a separate path. Rejected because the
consolidation payoff is the whole reason slice 3 deferred the
Collector to here.

**Alternative B: agent ships logs over OTLP via the
`opentelemetry-appender-logback` artifact.** Replaces stdout as the
emission surface, violates the slice-2 requirement that every event
renders as one ECS JSON line on stdout. Slice 3 already set
`OTEL_LOGS_EXPORTER=none` precisely to prevent this. Rejected to
preserve the slice-2 contract.

**Alternative C: use Grafana Alloy as the single shipper.** Alloy
has a `loki.source.file` component, and an `otelcol.receiver.otlp`
component for traces. So it can play the same role as the Collector.
Two reasons to pick the Collector instead: (1) production realism —
the Collector is the lingua franca of OTel deploys; "ship to a
Collector" is what real org pipelines do, and learning the YAML
shape transfers; (2) the slice-3 design.md literally named "OTel
Collector" as the planned slice-4 mechanism. Switching mechanism
now would force a design-doc retcon. Recorded but not chosen.

### Decision 2: Backend writes ECS JSON to a file (env-var gated) for log capture

**Chosen:** Add `logging.structured.format.file: ecs` and
`logging.file.name: ${LOG_FILE_PATH:}` to
`backend/src/main/resources/application.yaml`. When `LOG_FILE_PATH`
is set (e.g., `./infra/observability/logs/backend.json`), Spring
Boot's file appender writes the same ECS JSON to that file alongside
the stdout output. When unset (the default), no file output occurs.
The Collector container bind-mounts that host directory at
`/var/log/backend:ro` and tails it via its filelog receiver.

**Alternative A: `docker logs` of the backend container.** Would
work if the backend ran in compose, but it does not. Putting the
backend in compose would disrupt the dev loop, which is load-bearing
(`./gradlew bootRun` is the daily-driver feedback signal). Rejected.

**Alternative B: TCP / syslog appender from Logback to the Collector.**
Couples the application to a network address that is logging
infrastructure. Slice 2's design.md explicitly chose stdout over a
network appender for exactly this reason — "the application does
not know who reads its logs." Rejected to preserve that principle.

**Alternative C: OTLP logs from the OTel agent.** The agent's
`OTEL_LOGS_EXPORTER` can be set to `otlp`. Slice 3 set it to `none`
on purpose: the slice-2 stdout emission would either be silenced
(violating slice 2) or duplicated (one event = two surfaces). The
file appender is an additive surface; the OTLP logs option is a
replacement. Rejected to preserve the slice-2 single-emission-per-event
contract.

**Alternative D: redirect stdout to a file via shell redirection
(`./gradlew bootRun > backend.json`).** Works for one developer's
one terminal session; breaks the moment anyone runs `bootRun` under
an IDE, behind nohup, or via a different shell. Brittle; not
documentable as a single canonical run loop. Rejected.

**Trade-off accepted:** the same ECS JSON line is now emitted on
two surfaces when the file appender engages — stdout AND the file.
The slice-2 spec said "exactly one JSON object per log event on
stdout" — this is unchanged (one event still produces one stdout
line). The file is an additive surface, not a replacement, and the
spec is not violated.

### Decision 3: Collector takes over host port 4318; agent env vars unchanged; Tempo loses host port binding

**Chosen:** The Collector's OTLP HTTP receiver listens on
`0.0.0.0:4318` inside the container; docker-compose maps host
`4318:4318` → Collector. Tempo's OTLP receivers continue to listen
inside the Tempo container on `4317` and `4318` but lose their
docker-compose host port bindings — Tempo is reachable only as
`tempo:4317` from inside the docker network (which is exactly what
the Collector's `otlp/tempo` exporter does). The OTel agent's
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` continues to
work unchanged: the agent thinks it is talking to Tempo, the
Collector receives the spans, the Collector forwards them.
`backend/build.gradle.kts` is not modified by this slice.

**Alternative A: keep Tempo on host port 4318, put the Collector on
a different port, change the agent's `OTEL_EXPORTER_OTLP_ENDPOINT` to
the Collector's port.** Would require modifying the slice-3
`backend/build.gradle.kts` defaults — every future change to those
defaults now has to remember the slice-3 vs slice-4 split. Worse
for cognitive load; offers no upside. Rejected.

**Alternative B: introduce an `OBSERVABILITY_MODE` environment
variable on the backend that flips between "direct to Tempo" and
"via Collector".** Two configurations now live forever in the
build, every future change has to pick a side, the README has to
document both. The whole point of slice 4 is that the Collector is
the production-real shape — there is no value in keeping the
"direct to Tempo" mode as a first-class option. Rejected.

**Alternative C: keep Tempo's host port binding for `curl`-based
debugging.** Tempo's `3200:3200` HTTP API binding stays, which is
the surface a developer would use for direct Tempo queries; the
OTLP receiver bindings (`4317`, `4318`) are not relevant to manual
debugging. So removing them costs nothing while keeping the
"Collector is the only OTLP host port" invariant clean. Accepted
as part of the chosen design.

**Failure mode preserved:** if the developer runs the backend
without `docker-compose --profile observability up -d`, the
Collector is not up, host port 4318 has nothing listening, and the
OTel agent's OTLP export silently fails the same way it silently
failed when Tempo was unreachable in slice 3. No new error surfaces
appear in the application.

### Decision 4: One Collector instance handles both pipelines (agent vs gateway is deferred)

**Chosen:** One `collector` service handles both the trace
pipeline (OTLP in → Tempo out) and the log pipeline (filelog in →
Loki out). In production this role would typically be split: a
per-host **agent** Collector (close to the application, mostly
batching and resource enrichment) talks to a central **gateway**
Collector (where sampling, redaction, and fan-out live). For local
dev with one application instance, the split is academic — both
roles run on the same machine.

**Alternative: split into two Collector instances now.** Cost: two
config files, two compose services, two restart concerns; no
benefit at this scale. The split is recorded as a known follow-up
in the proposal; switching to it later is a configuration change,
not a re-architecture (the Collector's wire protocols are the
same on both sides of the split).

### Decision 5: Test boundary mirrors slice 3 — in-process IT, no Loki container in CI

**Chosen:** A single Spring Boot Testcontainers IT
(`LogFileOutputIT.java`) boots the full Spring context with
`LOG_FILE_PATH` pointing at a JUnit temp file, drives one
authenticated request, and asserts:

- the file contains one ECS JSON object per log event,
  newline-terminated, parseable as JSON;
- base ECS fields (`@timestamp`, `log.level`, `service.name`,
  etc.) appear on every line in the file;
- one `event.dataset=backend.access` line carrying populated
  `request.id`, `user.id`, `trace.id`, `span.id` fields appears;
- the same line appears on stdout (file is additive, not a
  replacement).

The IT does NOT spin up Loki or the Collector. The full wire path
(file → Collector filelog receiver → Loki HTTP API) is a manual
smoke through the README run loop.

**Alternative: spin up Loki + Collector in Testcontainers and
query Loki via HTTP for the expected line.** Heavy: two new
containers in the CI critical path, network race conditions
between log emission and Loki ingestion, container image pulls on
every CI run. Slice 3 made the equivalent call ("no Tempo
container in CI") and that precedent should hold; reversing it in
slice 4 would be incoherent. The in-process IT catches the
failure modes that matter (app-side bugs in ECS field emission);
the Collector + Loki path is config-only and `docker-compose up`
fails fast if the YAML is bad. Rejected as a high-cost,
low-marginal-value addition.

**Defensive sweetener (accepted):** a one-line CI step that runs
`docker compose --profile observability config -q` validates that
the compose file plus the Collector / Loki YAML parse. Seconds,
not minutes. Documented in `tasks.md`.

### Decision 6: Log file format is byte-identical to stdout — no separate file formatter

**Chosen:** The file appender uses the same
`logging.structured.format.file: ecs` formatter as
`logging.structured.format.console: ecs`. Every event produces two
byte-identical JSON lines: one on stdout, one in the file. The
Collector's filelog receiver does no re-parsing or transformation
— it forwards the JSON line as the Loki log body.

**Alternative: file in a denser binary format, stdout in JSON.**
Cost: the Collector now has to parse two different formats; the
mental model of "what got written" diverges from "what got
shipped"; debugging requires reading two surfaces with two
parsers. Rejected.

**Alternative: file in JSON, stdout in plain text for human
readability.** Tempting (the slice-2 ECS JSON on stdout is hard to
read in a terminal). But it would re-open the "two formats" cost,
and the slice-2 design.md decided stdout is for downstream
consumers, not human eyeballs (the `jq` filter is the documented
human path). Rejected for the same reason slice 2 rejected it.

## Risks / Trade-offs

- **Risk:** Developer forgets to set `LOG_FILE_PATH` before
  `./gradlew bootRun`, sees no log lines in Loki, assumes Loki is
  broken. → **Mitigation:** README's `### Log shipping` subsection
  leads with the `export LOG_FILE_PATH=...` line. The Grafana
  "Recent logs" panel shows "no data" rather than a misleading
  partial view, which is the correct signal.

- **Risk:** The `infra/observability/logs/` host directory grows
  without bound over a long dev session. → **Mitigation:** Loki's
  filelog receiver does not rotate the source file (it is a
  reader). Spring Boot's file appender supports rotation via
  `logging.logback.rollingpolicy.*`; this slice does NOT enable
  rotation (rotation would change the filename the Collector tails
  and complicate the filelog receiver glob). A future change can
  add rotation once it is needed. For now, developers are expected
  to `rm` the file occasionally; the README mentions this.

- **Risk:** The bind-mount path
  `./infra/observability/logs:/var/log/backend:ro` differs between
  Linux and macOS hosts only in performance characteristics; on
  Windows (WSL2) it works but is slower. → **Mitigation:** Out of
  scope — this project targets macOS / Linux dev environments and
  the slice-1 `host.docker.internal` workaround for Linux is the
  only platform-specific concession the README will carry.

- **Risk:** Tempo's `4317`/`4318` host-port removal breaks a
  developer's workflow that was relying on them directly (curl
  testing, a personal script). → **Mitigation:** Tempo's
  `3200:3200` HTTP API binding stays for direct query/debug; this
  is the surface developers actually use for debugging. The OTLP
  receivers were always meant as the agent's destination, not as a
  human-facing surface. Documented in the README's migration note.

- **Risk:** The OTel Collector contrib image
  (`otel/opentelemetry-collector-contrib`) pulls in receivers and
  exporters this slice doesn't use. → **Mitigation:** The image is
  ~250MB; only pulled when the observability profile activates.
  Switching to a custom-built minimal Collector image would save
  bytes but cost maintenance. Accepted as the standard trade-off
  of "pick the contrib distribution."

- **Risk:** The Collector ships logs to Loki at a rate the
  application produces them. A spike in log volume could buffer
  inside the Collector. → **Mitigation:** This is local dev with
  one developer driving one backend; ingest rate is bounded by
  manual interaction. The Collector's `batch` processor (added in
  the config) caps batch size. Production-scale concerns are out
  of scope.

- **Trade-off accepted:** Every log event now produces two writes
  (stdout + file) when the file appender engages. Spring Boot's
  appenders run sequentially, so this is a small fixed cost on
  every log emission. Worth measuring at scale, irrelevant locally.

- **Trade-off accepted:** The Collector and Loki run anonymous.
  Any container on the docker network or any process on the
  developer's loopback can scrape them. Acceptable for local dev;
  production would gate this.
