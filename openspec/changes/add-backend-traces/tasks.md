## 1. Pin and resolve the OTel Java agent JAR

- [ ] 1.1 Pin `io.opentelemetry.javaagent:opentelemetry-javaagent` in `backend/gradle/libs.versions.toml` (verify current stable at implementation time; design.md targets `2.10.0`).
- [ ] 1.2 In `backend/build.gradle.kts`, declare a dedicated `agent` Gradle `Configuration` that pulls the pinned coordinate, and verify it is NOT extended from `compileClasspath`, `runtimeClasspath`, or `testRuntimeClasspath`.
- [ ] 1.3 Add a `copyOtelAgent` Gradle task (`Copy` type) that resolves the `agent` configuration into `build/otel/opentelemetry-javaagent.jar`.
- [ ] 1.4 Wire `tasks.named<BootRun>("bootRun")` to `dependsOn(copyOtelAgent)` and add `-javaagent:` to `jvmArgs` pointing at the copied JAR.
- [ ] 1.5 Wire `tasks.named<Test>("test")` to `dependsOn(copyOtelAgent)` and add the same `-javaagent:` to `jvmArgs` so `TracingIT` runs with the agent attached.
- [ ] 1.6 Wire the agent into the `bootJar` distribution so `e2e/`'s `java -jar` launcher attaches it — concretely: have `copyOtelAgent` also place the JAR next to `build/libs/backend.jar`, and update the e2e launcher script (or `JAVA_TOOL_OPTIONS` env defaulting) to include the `-javaagent:` flag.
- [ ] 1.7 Verify `grep -r "import io.opentelemetry" backend/src/main/java` returns no matches before and after this slice (no application-source coupling).

## 2. Configure the agent via OTEL_* defaults

- [ ] 2.1 In `backend/build.gradle.kts`, set environment-variable defaults on the `bootRun` task for `OTEL_SERVICE_NAME=backend`, `OTEL_RESOURCE_ATTRIBUTES=service.environment=local,deployment.environment=local`, `OTEL_TRACES_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, `OTEL_METRICS_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none`.
- [ ] 2.2 Set the same defaults on the `test` task so `TracingIT` runs with deterministic agent config.
- [ ] 2.3 Confirm `OTEL_INSTRUMENTATION_LOGBACK_MDC_ENABLED` is at its default (`true`) and document the assumption in a one-line build-script comment.
- [ ] 2.4 Manual smoke: `./gradlew :backend:bootRun` starts cleanly; agent log lines on stderr show the expected exporter wiring; no warning about "Failed to instrument" appears.

## 3. Reconcile MDC key naming via `EcsTraceFieldsCustomizer`

- [ ] 3.1 Create `backend/src/main/java/com/prodready/social/observability/EcsTraceFieldsCustomizer.java` implementing `StructuredLoggingJsonMembersCustomizer<?>`, annotated `@Component` and `@Order(Ordered.LOWEST_PRECEDENCE)`.
- [ ] 3.2 In the customizer, read the `trace_id`, `span_id`, `trace_flags` keys from the event's MDC view; when non-blank, emit them as ECS-canonical `trace.id`, `span.id`, `trace.flags` JSON members.
- [ ] 3.3 Remove the Logstash-style `trace_id`, `span_id`, `trace_flags` keys from the JSON output so each line carries exactly one naming convention.
- [ ] 3.4 When an MDC key is absent or blank, omit the corresponding ECS field entirely (no empty placeholder string).
- [ ] 3.5 Manual smoke: tail `./gradlew :backend:bootRun 2>&1 | jq -c '.'` while making an authenticated `GET /api/v1/auth/me` — verify the resulting access-log line carries `trace.id` and `span.id` and does not carry `trace_id` or `span_id`.

## 4. Provision Tempo

- [ ] 4.1 Create `infra/observability/tempo/tempo.yaml` declaring an OTLP receiver on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP), local-filesystem WAL and blocks storage rooted at `/var/tempo`, HTTP API on `0.0.0.0:3200`, and 1-hour block retention.
- [ ] 4.2 Add an inline comment in `tempo.yaml` marking local-filesystem storage as a learning-project default and forward-referencing object-storage backends for production.
- [ ] 4.3 In `docker-compose.yml`, add a `tempo` service under `profiles: ["observability"]` using image `grafana/tempo:2.6.1`, mounting `./infra/observability/tempo/tempo.yaml` to `/etc/tempo.yaml`, exposing host ports `3200:3200`, `4317:4317`, `4318:4318`, starting with `-config.file=/etc/tempo.yaml`.
- [ ] 4.4 Extend the existing `grafana` service's `depends_on` list to include `tempo` (alongside the existing `prometheus` dependency).
- [ ] 4.5 Verify `docker-compose up -d` with no profile flag still starts only `postgres` (no tempo, no prometheus, no grafana).
- [ ] 4.6 Verify `docker-compose --profile observability up -d` brings up all four services and `curl http://localhost:3200/ready` returns 200 after startup.

## 5. Provision Tempo as a Grafana datasource

- [ ] 5.1 Create `infra/observability/grafana/provisioning/datasources/tempo.yaml` declaring one datasource named `Tempo` of type `tempo` at `http://tempo:3200`, with `editable: false` and `isDefault: false`.
- [ ] 5.2 Add an inline comment in the datasource file forward-referencing the slice-4 `tracesToLogs` correlation block (to be populated once Loki is provisioned).
- [ ] 5.3 In `infra/observability/grafana/dashboards/backend-overview.json`, add one new panel titled `Recent traces` with datasource `Tempo` running the TraceQL query `{ resource.service.name = "backend" }` in table form.
- [ ] 5.4 Manual smoke: Grafana at `http://localhost:3000` lands on `Backend overview`; the new `Recent traces` panel renders without "datasource not found" errors after `docker-compose --profile observability up -d`.

## 6. Document the run loop in README

- [ ] 6.1 Add a `### Distributed tracing` subsection to `README.md` under `## Local observability`, after the existing `### Structured logs` subsection.
- [ ] 6.2 Document that `docker-compose --profile observability up -d` now also brings up `tempo` and that spans flow to `http://localhost:4318` over OTLP/HTTP via the OTel Java agent.
- [ ] 6.3 Include an example JSON log line showing populated `trace.id` and `span.id` ECS fields (mirroring the slice-2 example block).
- [ ] 6.4 Document the copy-`trace.id`-into-Grafana-Tempo-search workflow as the manual correlation pattern until slice 4 wires the auto-link.
- [ ] 6.5 Add a forward-pointer that the auto "click `trace.id` in a log line → jump to Tempo" link will land in slice 4 (log shipping with Loki).

## 7. Integration test: `TracingIT`

- [ ] 7.1 Create `backend/src/test/java/com/prodready/social/observability/TracingIT.java` as a `@SpringBootTest` + Testcontainers Postgres class (mirrors `MetricsActuatorIT` / `StructuredLoggingIT` scaffolding from slice 1 / slice 2).
- [ ] 7.2 Register an `InMemorySpanExporter` on the agent's `OpenTelemetry` global; reset it in `@BeforeEach`.
- [ ] 7.3 Assert that `GlobalOpenTelemetry.get()` is registered and NOT the no-op fallback (proves the agent attached successfully).
- [ ] 7.4 Drive one authenticated `GET /api/v1/auth/me` call; capture the emitted JSON log lines; assert the `event.dataset=backend.access` line carries `trace.id` matching `^[0-9a-f]{32}$` and `span.id` matching `^[0-9a-f]{16}$`, and carries no top-level `trace_id` or `span_id` key.
- [ ] 7.5 From a freshly-spawned `Thread` (i.e. outside any active span), emit a log line; assert the captured JSON carries neither `trace.id` nor `span.id`.
- [ ] 7.6 Drive one authenticated `POST /api/v1/posts`; assert the captured span set contains a child span whose name contains `PostService.create` (proves the agent picks up the slice-1 `@Timed` annotations).
- [ ] 7.7 Verify by code search that `TracingIT.java` contains no reference to `grafana/tempo`, no `Testcontainers` declaration of Tempo, and no HTTP call to ports `3200` or `4318`.
- [ ] 7.8 Run `./gradlew :backend:integrationTest` (or the equivalent IT task in this repo) and confirm `TracingIT` passes locally.

## 8. Validate, branch, and commit

- [ ] 8.1 Run `openspec validate add-backend-traces --strict` and resolve any reported issues.
- [ ] 8.2 Create a Git branch `add-backend-traces` from `main`.
- [ ] 8.3 Stage and commit the four proposal artifacts (`proposal.md`, `design.md`, `specs/observability/spec.md`, `tasks.md`) so a fresh context can resume implementation.
- [ ] 8.4 Do NOT push or open a PR at this stage — the proposal commit is a checkpoint for the apply phase, not a final deliverable.
