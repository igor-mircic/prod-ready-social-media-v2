# observability — delta for add-backend-traces

## ADDED Requirements

### Requirement: OpenTelemetry Java agent attaches to every backend JVM at a pinned version

The `backend/` project SHALL pin the OpenTelemetry Java agent JAR coordinate `io.opentelemetry.javaagent:opentelemetry-javaagent` in `backend/gradle/libs.versions.toml` and SHALL declare a dedicated Gradle `agent` configuration in `backend/build.gradle.kts` that resolves the JAR. The configuration SHALL be isolated from `compileClasspath`, `runtimeClasspath`, and `testRuntimeClasspath` so the agent is never on the application classpath. A Gradle task SHALL copy the resolved JAR to `backend/build/otel/opentelemetry-javaagent.jar` so a stable, version-controlled path exists for the `-javaagent:` JVM flag.

The `bootRun`, `bootJar`, and `test` tasks SHALL each launch the JVM with `-javaagent:<path-to-opentelemetry-javaagent.jar>` so all three entry points (developer dev loop, e2e harness JAR launcher, integration-test JVM) attach the same byte-identical agent. Application source SHALL NOT import any class from the `io.opentelemetry.*`, `io.opentelemetry.api.*`, or `io.opentelemetry.instrumentation.*` package families.

#### Scenario: Agent JAR coordinate is pinned

- **WHEN** a reader inspects `backend/gradle/libs.versions.toml`
- **THEN** the file declares a coordinate for `io.opentelemetry.javaagent:opentelemetry-javaagent` with an explicit, non-`+`, non-`latest.release` version string.

#### Scenario: Agent configuration is isolated from runtime classpath

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the file declares a Gradle `Configuration` named `agent` (or equivalent) holding the agent JAR
- **AND** that configuration is NOT extended from, included by, or otherwise merged into `compileClasspath`, `runtimeClasspath`, or `testRuntimeClasspath`.

#### Scenario: All three JVM entry points attach the agent

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the `bootRun` task carries a JVM argument of the form `-javaagent:<path>/opentelemetry-javaagent.jar`
- **AND** the `bootJar` build path produces a launcher (or documents a launcher invocation in `e2e/`) that attaches the agent
- **AND** the `test` task carries the same `-javaagent:` argument.

#### Scenario: Application source has no compile-time dependency on the OTel SDK

- **WHEN** a reader greps `backend/src/main/java/` for `import io.opentelemetry`
- **THEN** the search returns zero matches.

### Requirement: Agent ships spans only; metrics and logs OTLP exporters are explicitly disabled

The backend's OTel agent SHALL be configured via environment variables (defaulted in `backend/build.gradle.kts` for `bootRun` and `test`, overridable at runtime) such that:

- `OTEL_SERVICE_NAME` is `backend` (matches the slice-1 Micrometer common tag),
- `OTEL_RESOURCE_ATTRIBUTES` includes `service.environment=local` and `deployment.environment=local` (matches the slice-2 `service.environment` log field),
- `OTEL_TRACES_EXPORTER` is `otlp`,
- `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf`,
- `OTEL_EXPORTER_OTLP_ENDPOINT` is `http://localhost:4318`,
- `OTEL_METRICS_EXPORTER` is `none` (slice 1 owns metrics via Prometheus pull; the agent SHALL NOT push duplicate metrics over OTLP),
- `OTEL_LOGS_EXPORTER` is `none` (slice 2 owns log emission on stdout; the agent SHALL NOT parallel-emit logs over OTLP).

#### Scenario: Build wires the documented OTEL_* defaults

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the `bootRun` and `test` task configurations declare environment-variable defaults for each of `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER`
- **AND** the values match those listed above.

#### Scenario: No OTLP metrics duplicate the Prometheus surface

- **GIVEN** the backend is running with the agent attached
- **WHEN** a reader inspects emitted metrics surfaces
- **THEN** the only metrics surface remains `GET /actuator/prometheus`
- **AND** no metric values are pushed to `http://localhost:4318/v1/metrics`.

#### Scenario: No OTLP logs duplicate the stdout surface

- **GIVEN** the backend is running with the agent attached
- **WHEN** a reader inspects emitted log surfaces
- **THEN** every log event continues to render exactly once on stdout in ECS JSON format
- **AND** no log payload is pushed to `http://localhost:4318/v1/logs`.

### Requirement: Per-request log lines carry ECS-canonical `trace.id` and `span.id` fields

The backend SHALL declare a `@Configuration`-registered Spring bean implementing `org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer<?>` at `backend/src/main/java/com/prodready/social/observability/EcsTraceFieldsCustomizer.java`. The bean SHALL run with `@Order(Ordered.LOWEST_PRECEDENCE)` so it executes after any other JSON-members customizer, and SHALL:

- read the `trace_id`, `span_id`, and `trace_flags` keys from the current `LoggingEvent`'s MDC view (which the OTel agent's `instrumentation-logback-mdc` module populates at log-emit time);
- when `trace_id` is non-blank, emit a JSON member `trace.id` (nested ECS form) carrying that value, and remove the Logstash-style `trace_id` key from the JSON output;
- when `span_id` is non-blank, emit a JSON member `span.id` carrying that value, and remove the `span_id` key from the JSON output;
- when `trace_flags` is non-blank, emit a JSON member `trace.flags` carrying that value, and remove the `trace_flags` key from the JSON output;
- when any of those MDC keys is absent or blank, omit the corresponding ECS field entirely (the JSON line carries no empty placeholder).

The bean SHALL NOT introduce a `logback-spring.xml` or a `logback.xml` and SHALL NOT add a Logback converter pattern (the existing slice-2 prohibition on `logback-spring.xml` is preserved).

#### Scenario: Authenticated request emits one access log line carrying populated `trace.id` and `span.id`

- **GIVEN** the backend is running with the OTel agent attached
- **AND** a client calls `GET /api/v1/auth/me` with a valid bearer token for user U
- **WHEN** a reader inspects the JSON log line carrying `event.dataset == "backend.access"` for that request
- **THEN** the line carries a string-valued `trace.id` field that is exactly 32 lowercase hexadecimal characters
- **AND** the line carries a string-valued `span.id` field that is exactly 16 lowercase hexadecimal characters
- **AND** the line does NOT carry a top-level `trace_id` or `span_id` key.

#### Scenario: Log event outside any span carries no `trace.id` or `span.id`

- **GIVEN** the backend is running with the OTel agent attached
- **WHEN** a log event is emitted from a thread that is NOT inside an active OTel span (for example, an application-bootstrap log line)
- **THEN** the corresponding JSON line carries no `trace.id` field
- **AND** the corresponding JSON line carries no `span.id` field
- **AND** the corresponding JSON line carries no top-level `trace_id` or `span_id` key.

#### Scenario: No `logback-spring.xml` is introduced

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml` nor `logback.xml`
- **AND** `backend/build.gradle.kts` declares no dependency on `net.logstash.logback:logstash-logback-encoder`.

### Requirement: Tempo is provisioned under the `observability` docker-compose profile and as a Grafana datasource

The repository's `docker-compose.yml` SHALL declare one new service `tempo` under `profiles: ["observability"]` using the image `grafana/tempo:2.6.1`, mounting `./infra/observability/tempo/tempo.yaml` to `/etc/tempo.yaml`, exposing host ports `3200:3200` (HTTP API), `4317:4317` (OTLP gRPC), and `4318:4318` (OTLP HTTP), and starting with `-config.file=/etc/tempo.yaml`. The existing `grafana` service's `depends_on` list SHALL be extended to include `tempo` (in addition to the existing `prometheus` dependency from slice 1). The default `docker-compose up` invocation (with no profile flag) SHALL continue to start only `postgres`.

The repository SHALL include `infra/observability/tempo/tempo.yaml` declaring an OTLP receiver enabled on both gRPC (`0.0.0.0:4317`) and HTTP (`0.0.0.0:4318`), local-filesystem WAL and blocks storage under `/var/tempo`, the HTTP API on `0.0.0.0:3200`, and a 1-hour block retention. The file SHALL carry an inline comment marking the local-filesystem storage choice as a learning-project default and forward-referencing object-storage backends for production.

The repository SHALL include `infra/observability/grafana/provisioning/datasources/tempo.yaml` declaring one datasource named `Tempo` of type `tempo` at URL `http://tempo:3200`, with `editable: false` and `isDefault: false` (the Prometheus datasource from slice 1 remains the default). The file SHALL carry an inline comment forward-referencing slice 4: the `tracesToLogs` correlation block will be populated once Loki is provisioned as a datasource.

#### Scenario: Default invocation still starts only postgres

- **WHEN** an operator runs `docker-compose up -d` with no profile flag
- **THEN** only the `postgres` service starts.

#### Scenario: Observability profile starts tempo alongside prometheus and grafana

- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `postgres`, `prometheus`, `grafana`, and `tempo` services all start
- **AND** Tempo's HTTP API on `http://localhost:3200/ready` returns a 200 once the container has finished initial startup.

#### Scenario: Tempo configuration declares OTLP receivers and local storage

- **WHEN** a reader inspects `infra/observability/tempo/tempo.yaml`
- **THEN** the file enables an OTLP receiver listening on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP)
- **AND** the file declares local-filesystem WAL and blocks storage rooted at `/var/tempo`
- **AND** the file exposes Tempo's HTTP API on `0.0.0.0:3200`
- **AND** the file carries an inline comment marking local-filesystem storage as a learning-project default.

#### Scenario: Grafana datasource provisioning declares Tempo as non-default

- **WHEN** a reader inspects `infra/observability/grafana/provisioning/datasources/tempo.yaml`
- **THEN** the file declares one datasource named `Tempo` of type `tempo`
- **AND** the URL is `http://tempo:3200`
- **AND** `editable` is `false`
- **AND** `isDefault` is `false`
- **AND** the file carries an inline comment forward-referencing the slice-4 `tracesToLogs` block.

#### Scenario: Backend overview dashboard gains a Recent traces panel

- **WHEN** a reader inspects `infra/observability/grafana/dashboards/backend-overview.json`
- **THEN** the dashboard declares one new panel titled `Recent traces`
- **AND** the panel's datasource is `Tempo`
- **AND** the panel's query targets `{ resource.service.name = "backend" }` in TraceQL.

### Requirement: README documents the local distributed-tracing run loop

The repository's `README.md` SHALL include a `### Distributed tracing` subsection under the existing `## Local observability` section, after the existing `### Structured logs` subsection. The subsection SHALL document:

- that `docker-compose --profile observability up -d` now also brings up the `tempo` service,
- that the backend ships spans to `http://localhost:4318` over OTLP/HTTP via the OTel Java agent,
- an example JSON log line showing populated `trace.id` and `span.id` ECS fields,
- the workflow of copying a `trace.id` value out of a log line and pasting it into Tempo's Grafana search to land on the corresponding span tree,
- a forward-pointer that the auto "click `trace.id` in a log line → jump to Tempo" link will land in the next observability slice (log shipping with Loki) once the log datasource is provisioned.

#### Scenario: README documents the tracing run loop

- **WHEN** a reader inspects the top-level `README.md`
- **THEN** the document contains a `### Distributed tracing` subsection under `## Local observability`
- **AND** the subsection states that `docker-compose --profile observability up -d` brings up `tempo`
- **AND** the subsection shows an example JSON log line with populated `trace.id` and `span.id`
- **AND** the subsection documents the copy-`trace.id`-into-Grafana workflow
- **AND** the subsection forward-references the future slice for the trace-to-logs auto-link.

### Requirement: Integration test proves the agent → MDC → ECS pipeline end-to-end in-process

The `backend/` project SHALL include a Testcontainers integration test `backend/src/test/java/com/prodready/social/observability/TracingIT.java` that boots the full Spring context against a Testcontainers Postgres with the OTel Java agent attached (the `test` task carries the `-javaagent:` flag). The test SHALL register an in-process `InMemorySpanExporter` on the agent's `OpenTelemetry` global, reset that exporter in a `@BeforeEach` block, and assert:

- the agent's `OpenTelemetry` global is registered and is NOT the no-op fallback (proves the agent attached and instrumented successfully);
- one authenticated controller request emits exactly one `event.dataset=backend.access` JSON log line whose `trace.id` field is a non-blank 32-character lowercase hex string;
- the same line's `span.id` field is a non-blank 16-character lowercase hex string;
- a log event emitted from a thread *outside* any active span (for example, by submitting a no-op Runnable to a fresh `Thread`) carries no `trace.id` and no `span.id` field;
- a `POST /api/v1/posts` request produces a child span whose name contains `PostService.create` (proves the agent picks up the slice-1 `@Timed` annotations as spans).

The test SHALL NOT boot a Tempo container, SHALL NOT make any network call to `http://localhost:4318` or `http://localhost:3200`, and SHALL NOT depend on any service outside the `Testcontainers` Postgres + the in-process Spring context.

#### Scenario: Integration test covers each listed assertion

- **WHEN** a reader inspects `TracingIT.java`
- **THEN** every assertion bullet listed above corresponds to at least one `@Test` method
- **AND** the test class contains no reference to a Tempo container, no `Testcontainers` declaration of `grafana/tempo`, and no HTTP call to port `4318` or `3200`.
