## ADDED Requirements

### Requirement: Backend writes ECS JSON log events to an env-var-gated file in addition to stdout

The `backend/` project SHALL extend
`backend/src/main/resources/application.yaml` so that, when the
environment variable `LOG_FILE_PATH` is set to a non-empty value, every
log event is appended as one ECS JSON line to the file at that path in
addition to the existing stdout emission. The file output SHALL use
`logging.structured.format.file: ecs` so the file lines are
byte-identical to the corresponding stdout lines. When `LOG_FILE_PATH`
is unset or empty, no file appender SHALL engage and the dev loop SHALL
be byte-identical to slice 2 / slice 3 behaviour. The file appender
SHALL NOT introduce a `logback-spring.xml`, a `logback.xml`, or any
dependency on `net.logstash.logback:logstash-logback-encoder` (the
existing slice-2 prohibitions are preserved).

#### Scenario: File appender does not engage by default

- **GIVEN** the backend is started with no `LOG_FILE_PATH` environment
  variable set
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** no file is created at any path the backend controls.

#### Scenario: File appender writes ECS JSON when `LOG_FILE_PATH` is set

- **GIVEN** the backend is started with
  `LOG_FILE_PATH=/some/writable/path/backend.json`
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** the same event appears as one ECS JSON line appended to
  `/some/writable/path/backend.json`
- **AND** the two lines are byte-identical.

#### Scenario: File lines carry the full ECS field set including correlation fields

- **GIVEN** the backend is started with a non-empty `LOG_FILE_PATH`
- **WHEN** an authenticated client calls `GET /api/v1/auth/me` with a
  valid bearer token for user U
- **THEN** the file contains one line with
  `event.dataset == "backend.access"`
- **AND** that line carries the base ECS fields (`@timestamp`,
  `log.level`, `service.name`, `service.environment`,
  `process.thread.name`, `log.logger`, `message`, `ecs.version`)
- **AND** that line carries a non-blank `request.id`
- **AND** that line carries a `user.id` equal to U's id as a string
- **AND** that line carries a 32-character lowercase hex `trace.id`
- **AND** that line carries a 16-character lowercase hex `span.id`.

#### Scenario: No `logback-spring.xml` is introduced (preserved across slice 4)

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml` nor
  `logback.xml`
- **AND** `backend/build.gradle.kts` declares no dependency on
  `net.logstash.logback:logstash-logback-encoder`.

### Requirement: OpenTelemetry Collector is provisioned under the `observability` docker-compose profile with two pipelines

The repository's `docker-compose.yml` SHALL declare one new service
`collector` under `profiles: ["observability"]` using the image
`otel/opentelemetry-collector-contrib:0.111.0`, mounting
`./infra/observability/collector/collector-config.yaml` to
`/etc/otelcol-contrib/config.yaml` and
`./infra/observability/logs:/var/log/backend:ro`, exposing host ports
`4317:4317` (OTLP gRPC) and `4318:4318` (OTLP HTTP), and starting with
`--config=/etc/otelcol-contrib/config.yaml`.

The repository SHALL include
`infra/observability/collector/collector-config.yaml` declaring:

- one OTLP receiver listening on `0.0.0.0:4317` (gRPC) and
  `0.0.0.0:4318` (HTTP);
- one `filelog` receiver tailing `/var/log/backend/*.json` and
  parsing each line as a JSON object (so the ECS fields land as
  attributes on the Loki log entry);
- one `otlp/tempo` exporter targeting `tempo:4317` with TLS
  disabled (in-network call);
- one `loki` exporter targeting `http://loki:3100/loki/api/v1/push`;
- one `batch` processor with default settings, shared by both
  pipelines;
- a `traces` pipeline wiring `otlp` receiver → `batch` processor →
  `otlp/tempo` exporter;
- a `logs` pipeline wiring `filelog` receiver → `batch` processor →
  `loki` exporter.

The Collector configuration SHALL set the Loki exporter's
`labels.attributes` so that each shipped log line carries
`service_name`, `event.dataset`, and `log.level` as Loki labels (the
remaining ECS fields are kept inside the JSON body and queried via
`| json` at read time, so the Loki label cardinality stays bounded).

#### Scenario: Observability profile starts collector alongside the existing services

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, `tempo`,
  `collector`, and `loki` services all start
- **AND** the Collector's OTLP HTTP endpoint at
  `http://localhost:4318/v1/traces` accepts a POST.

#### Scenario: Default invocation still starts only postgres (preserved across slice 4)

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Collector configuration declares the two pipelines

- **WHEN** a reader inspects
  `infra/observability/collector/collector-config.yaml`
- **THEN** the file declares an OTLP receiver bound on
  `0.0.0.0:4317` and `0.0.0.0:4318`
- **AND** the file declares a `filelog` receiver whose `include` glob
  matches `/var/log/backend/*.json` and whose operators parse each line
  as JSON
- **AND** the file declares an `otlp/tempo` exporter targeting
  `tempo:4317`
- **AND** the file declares a `loki` exporter targeting
  `http://loki:3100/loki/api/v1/push`
- **AND** the `service.pipelines.traces` section wires OTLP receiver →
  batch → `otlp/tempo` exporter
- **AND** the `service.pipelines.logs` section wires `filelog`
  receiver → batch → `loki` exporter.

#### Scenario: Loki label set is bounded

- **WHEN** a reader inspects the `loki` exporter section of
  `infra/observability/collector/collector-config.yaml`
- **THEN** the `labels.attributes` (or equivalent) declares exactly
  the labels `service_name`, `event.dataset`, and `log.level`
- **AND** no high-cardinality attribute (`request.id`, `user.id`,
  `trace.id`, `span.id`) appears as a Loki label.

### Requirement: Loki is provisioned under the `observability` docker-compose profile as a Grafana datasource

The repository's `docker-compose.yml` SHALL declare one new service
`loki` under `profiles: ["observability"]` using the image
`grafana/loki:3.2.0`, mounting
`./infra/observability/loki/loki-config.yaml` to
`/etc/loki/local-config.yaml`, with no host port binding (Loki is
reachable only from inside the docker network), and starting with
`-config.file=/etc/loki/local-config.yaml`. The existing `grafana`
service's `depends_on` list SHALL be extended to include both `loki`
and `collector` (in addition to the existing `prometheus` and `tempo`
dependencies from slices 1 and 3).

The repository SHALL include `infra/observability/loki/loki-config.yaml`
declaring a single-binary Loki configuration with local-filesystem
storage rooted at `/loki`, the HTTP API on `0.0.0.0:3100`, schema
config compatible with Loki 3.x, and retention disabled. The file
SHALL carry an inline comment marking the local-filesystem storage
and disabled retention as learning-project defaults and
forward-referencing object-storage backends and a retention period
for production.

The repository SHALL include
`infra/observability/grafana/provisioning/datasources/loki.yaml`
declaring one datasource named `Loki` of type `loki` at
`http://loki:3100`, with `editable: false` and `isDefault: false`
(the slice-1 Prometheus datasource remains the default). The file
SHALL declare a `derivedFields` block that turns any non-blank
`trace.id` field in a Loki log line into a clickable link to the
Tempo datasource using the URL template `${__value.raw}`. The
matching regex SHALL key on the literal JSON key
`"trace.id":"<value>"` so that the link only appears when a real
`trace.id` is present (no link on lines emitted outside a span).

#### Scenario: Loki container starts under the observability profile

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `loki` service starts
- **AND** the Loki HTTP API responds 200 to a `/ready` request from
  inside the docker network at `http://loki:3100/ready`
- **AND** no host port is bound to the loki container.

#### Scenario: Loki configuration uses local-filesystem storage with disabled retention

- **WHEN** a reader inspects `infra/observability/loki/loki-config.yaml`
- **THEN** the file declares local-filesystem storage rooted at
  `/loki`
- **AND** the file binds the HTTP API on `0.0.0.0:3100`
- **AND** the file disables retention
- **AND** the file carries an inline comment marking these as
  learning-project defaults.

#### Scenario: Grafana datasource provisioning declares Loki as non-default with logs-to-traces correlation

- **WHEN** a reader inspects
  `infra/observability/grafana/provisioning/datasources/loki.yaml`
- **THEN** the file declares one datasource named `Loki` of type
  `loki`
- **AND** the URL is `http://loki:3100`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file declares a `derivedFields` entry whose regex
  matches the literal JSON key `"trace.id":"<value>"` in a log line
  body
- **AND** that `derivedFields` entry targets the slice-3 `Tempo`
  datasource by name.

#### Scenario: Backend overview dashboard gains a Recent logs panel

- **WHEN** a reader inspects
  `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard declares one new panel titled `Recent logs`
- **AND** the panel's datasource is `Loki`
- **AND** the panel's query targets `{service_name="backend"}` and
  parses each line with `| json` to surface the ECS field set.

### Requirement: README documents the local log-shipping run loop

The repository's `README.md` SHALL include a `### Log shipping`
subsection under the existing `## Local observability` section, after
the existing `### Distributed tracing` subsection. The subsection SHALL
document:

- that `docker-compose --profile observability up -d` now also brings
  up the `collector` and `loki` services,
- that the developer SHALL export
  `LOG_FILE_PATH=./infra/observability/logs/backend.json` before
  `./gradlew bootRun` to enable the file appender that the Collector
  tails (an example shell line),
- that the slice-3 Tempo direct OTLP host ports (`4317`, `4318`) are
  retired by this slice in favour of the Collector and that Tempo's
  `http://localhost:3200` HTTP API binding stays for direct curl
  debugging,
- the `tracesToLogs` workflow: clicking a `trace.id` in a Tempo span
  view in Grafana opens the matching Loki log lines for that request,
- the `logsToTraces` workflow: clicking a `trace.id` in a Loki log
  line in Grafana opens the matching Tempo span tree,
- a one-line note that the slice-3 manual "copy `trace.id` and paste
  into Tempo search" workflow still works.

#### Scenario: README documents the log-shipping run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Log shipping` subsection under
  `## Local observability`
- **AND** the subsection states that
  `docker-compose --profile observability up -d` brings up
  `collector` and `loki`
- **AND** the subsection shows an example shell line that exports
  `LOG_FILE_PATH` before `./gradlew bootRun`
- **AND** the subsection documents the `tracesToLogs` workflow as a
  one-click pivot from a Tempo span to Loki log lines
- **AND** the subsection documents the `logsToTraces` workflow as a
  one-click pivot from a Loki log line to a Tempo span tree
- **AND** the subsection notes that Tempo's OTLP host port bindings
  are retired and that its `3200` HTTP API binding remains.

### Requirement: Integration test proves the file log-output surface end-to-end in-process

The `backend/` project SHALL include a Testcontainers integration
test
`backend/src/test/java/com/prodready/social/observability/LogFileOutputIT.java`
that boots the full Spring context against a Testcontainers Postgres
with `LOG_FILE_PATH` set to a JUnit-managed temporary file and the
OTel Java agent attached (the `test` task already carries the
`-javaagent:` flag from slice 3). The test SHALL assert:

- every line written to the temp file parses as one JSON object
  carrying the base ECS fields;
- one authenticated `GET /api/v1/auth/me` request results in a line
  in the temp file with `event.dataset == "backend.access"` carrying
  populated `request.id` (non-blank), `user.id` (matching the
  authenticated user), `trace.id` (32-character lowercase hex), and
  `span.id` (16-character lowercase hex) fields;
- the same line is byte-identical between the temp file and the
  captured stdout for the test run (proves the file output is an
  additive surface, not a replacement, and that no formatter
  divergence has been introduced);
- when `LOG_FILE_PATH` is unset for a second test case, no file is
  written to the directory the test created (proves the default dev
  loop remains stdout-only).

The test SHALL NOT boot a Loki container, SHALL NOT boot a
Collector container, and SHALL NOT make any network call to
`http://localhost:4318`, `http://localhost:3100`, or any other
observability-stack endpoint. The wire path from file to Loki is a
manual smoke through the README run loop.

#### Scenario: Log file output integration test covers each listed assertion

- **WHEN** a reader inspects `LogFileOutputIT.java`
- **THEN** every assertion bullet listed above corresponds to at
  least one `@Test` method
- **AND** the test class contains no reference to a Loki container,
  no reference to a Collector container, no `Testcontainers`
  declaration of `grafana/loki` or
  `otel/opentelemetry-collector-contrib`, and no HTTP call to port
  `4318`, `3100`, or `4317`.

## MODIFIED Requirements

### Requirement: Tempo is provisioned under the `observability` docker-compose profile and as a Grafana datasource

The repository's `docker-compose.yml` SHALL declare one service
`tempo` under `profiles: ["observability"]` using the image
`grafana/tempo:2.6.1`, mounting
`./infra/observability/tempo/tempo.yaml` to `/etc/tempo.yaml`,
exposing host port `3200:3200` (HTTP API only — the OTLP receiver
host port bindings from slice 3 are retired by slice 4 in favour of
the Collector taking over `4317:4317` and `4318:4318`), and starting
with `-config.file=/etc/tempo.yaml`. Tempo's OTLP receivers continue
to listen inside the container on `4317` and `4318` and are
reachable from inside the docker network as `tempo:4317` and
`tempo:4318` (the Collector's `otlp/tempo` exporter targets
`tempo:4317`). The existing `grafana` service's `depends_on` list
SHALL include `tempo` (in addition to the slice-1 `prometheus` and
the slice-4 `loki` and `collector` dependencies). The default
`docker-compose up` invocation (with no profile flag) SHALL continue
to start only `postgres`.

The repository SHALL include `infra/observability/tempo/tempo.yaml`
declaring an OTLP receiver enabled on both gRPC (`0.0.0.0:4317`) and
HTTP (`0.0.0.0:4318`), local-filesystem WAL and blocks storage under
`/var/tempo`, the HTTP API on `0.0.0.0:3200`, and a 1-hour block
retention. The file SHALL carry an inline comment marking the
local-filesystem storage choice as a learning-project default and
forward-referencing object-storage backends for production.

The repository SHALL include
`infra/observability/grafana/provisioning/datasources/tempo.yaml`
declaring one datasource named `Tempo` of type `tempo` at URL
`http://tempo:3200`, with `editable: false` and `isDefault: false`
(the Prometheus datasource from slice 1 remains the default). The
file SHALL declare a `tracesToLogs` (or equivalent
`tracesToLogsV2` per Grafana version) correlation block targeting
the slice-4 `Loki` datasource by name, keyed on the `trace.id` span
tag so that opening a Tempo span in Grafana presents a one-click
pivot to the matching Loki log lines.

#### Scenario: Default invocation still starts only postgres (preserved across slice 4)

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Observability profile starts tempo alongside the other observability services

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, `tempo`,
  `collector`, and `loki` services all start
- **AND** Tempo's HTTP API on `http://localhost:3200/ready` returns
  a 200 once the container has finished initial startup
- **AND** no process on the host is listening on ports `4317` or
  `4318` other than the slice-4 Collector container's bindings.

#### Scenario: Tempo configuration declares OTLP receivers and local storage

- **WHEN** a reader inspects `infra/observability/tempo/tempo.yaml`
- **THEN** the file enables an OTLP receiver listening on
  `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP)
- **AND** the file declares local-filesystem WAL and blocks storage
  rooted at `/var/tempo`
- **AND** the file exposes Tempo's HTTP API on `0.0.0.0:3200`
- **AND** the file carries an inline comment marking
  local-filesystem storage as a learning-project default.

#### Scenario: Grafana datasource provisioning declares Tempo as non-default with traces-to-logs correlation

- **WHEN** a reader inspects
  `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one datasource named `Tempo` of type
  `tempo`
- **AND** the URL is `http://tempo:3200`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file declares a `tracesToLogs` (or `tracesToLogsV2`)
  correlation entry whose `datasourceUid` (or named target)
  references the slice-4 `Loki` datasource
- **AND** the file does NOT carry the slice-3 inline comment
  forward-referencing the slice-4 `tracesToLogs` block (the block
  is now present, not forward-referenced).

#### Scenario: Backend overview dashboard retains the Recent traces panel

- **WHEN** a reader inspects
  `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard still declares the slice-3 panel titled
  `Recent traces`
- **AND** the panel's datasource is `Tempo`
- **AND** the panel's query targets
  `{ resource.service.name = "backend" }` in TraceQL.
