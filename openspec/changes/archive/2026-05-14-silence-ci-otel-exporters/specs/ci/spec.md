## ADDED Requirements

### Requirement: CI workflow disables OTLP network exporters for the OpenTelemetry Java agent

The CI workflow at `.github/workflows/ci.yml` SHALL set
`OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`, and
`OTEL_LOGS_EXPORTER=none` at the workflow level (a top-level `env:`
block, outside any individual job) so that every step in every job
that boots a JVM with the OpenTelemetry Java agent attached
inherits the variables. The agent itself SHALL continue to load —
the workflow SHALL NOT disable the agent via
`OTEL_SDK_DISABLED=true` or `-Dotel.javaagent.enabled=false` — so
in-process span creation and the `trace.id` / `span.id` MDC keys
the backend log layout depends on continue to be populated.

#### Scenario: Workflow env block declares the three OTel exporter variables

- **WHEN** a reader opens `.github/workflows/ci.yml`
- **THEN** the file declares a top-level `env:` block at the
  workflow root (outside any `jobs:` entry)
- **AND** the block contains
  `OTEL_TRACES_EXPORTER: none`,
  `OTEL_METRICS_EXPORTER: none`, and
  `OTEL_LOGS_EXPORTER: none`.

#### Scenario: Workflow does NOT disable the OTel agent itself

- **WHEN** a reader inspects the workflow's env block, any job's
  env block, or any step's command
- **THEN** no env var named `OTEL_SDK_DISABLED` is set to `true`
- **AND** no `-Dotel.javaagent.enabled=false` JVM argument is
  passed to any backend JVM invocation.

#### Scenario: Backend job's test JVM does not log OTLP connection errors

- **WHEN** the `backend (test + openapi drift)` job runs the
  `Run backend tests` step
- **THEN** the step's log does NOT contain
  `Failed to export spans` from `io.opentelemetry.exporter.internal.http.HttpExporter`
- **AND** the step's log does NOT contain
  `ConnectException: Failed to connect to localhost/[0:0:0:0:0:0:0:1]:4318`.

#### Scenario: Backend job's OpenAPI-spec JVM does not log OTLP connection errors

- **WHEN** the `backend (test + openapi drift)` job runs the
  `Generate OpenAPI spec` step
- **THEN** the step's log does NOT contain
  `Failed to export spans` from `io.opentelemetry.exporter.internal.http.HttpExporter`.

#### Scenario: e2e job's bootJar process does not log OTLP connection errors

- **WHEN** the `e2e (${{ matrix.browser }})` job runs the
  `Run Playwright` step and the harness's `globalSetup` boots
  the backend bootJar
- **THEN** the bootJar's log output does NOT contain
  `Failed to export spans` from `io.opentelemetry.exporter.internal.http.HttpExporter`.

#### Scenario: Backend log lines in CI still carry trace.id and span.id

- **WHEN** the `backend (test + openapi drift)` job runs and the
  test JVM emits any application log line through the project's
  logback / ECS layout
- **THEN** the line's structured JSON contains a `trace.id` field
- **AND** the line's structured JSON contains a `span.id` field
- **AND** the values are populated by the still-loaded OTel
  agent (not empty strings).

#### Scenario: Dev loop is unaffected

- **WHEN** a developer runs the backend locally with
  `docker compose --profile observability up` and starts the
  application JVM without the GitHub Actions env vars in scope
- **THEN** the OTel agent uses its default OTLP endpoint
  (`localhost:4318`)
- **AND** the dev compose collector receives spans as before.
