## 1. Infra — Loki

- [ ] 1.1 Create `infra/observability/loki/loki-config.yaml` declaring single-binary Loki with local-filesystem storage rooted at `/loki`, HTTP API on `0.0.0.0:3100`, schema config compatible with Loki 3.x, retention disabled, and an inline comment marking the choices as learning-project defaults.
- [ ] 1.2 Add a `loki` service to `docker-compose.yml` under `profiles: ["observability"]` using `grafana/loki:3.2.0`, mounting the config file to `/etc/loki/local-config.yaml`, with no host port binding and starting with `-config.file=/etc/loki/local-config.yaml`.
- [ ] 1.3 Smoke-verify locally: `docker-compose --profile observability up -d loki` followed by `docker exec` curl of `http://localhost:3100/ready` returns 200.

## 2. Infra — OTel Collector

- [ ] 2.1 Create `infra/observability/collector/collector-config.yaml` declaring: one `otlp` receiver on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP); one `filelog` receiver tailing `/var/log/backend/*.json` and parsing each line as JSON; one `batch` processor with default settings; one `otlp/tempo` exporter targeting `tempo:4317` with TLS disabled; one `loki` exporter targeting `http://loki:3100/loki/api/v1/push` with `labels.attributes` declaring exactly `service_name`, `event.dataset`, and `log.level` (no `request.id`, `user.id`, `trace.id`, `span.id` as Loki labels).
- [ ] 2.2 In the Collector config, wire `service.pipelines.traces` as OTLP → batch → `otlp/tempo` and `service.pipelines.logs` as filelog → batch → `loki`.
- [ ] 2.3 Add a `collector` service to `docker-compose.yml` under `profiles: ["observability"]` using `otel/opentelemetry-collector-contrib:0.111.0`, mounting `./infra/observability/collector/collector-config.yaml` to `/etc/otelcol-contrib/config.yaml` and `./infra/observability/logs:/var/log/backend:ro`, exposing host ports `4317:4317` and `4318:4318`, and starting with `--config=/etc/otelcol-contrib/config.yaml`.
- [ ] 2.4 Create `infra/observability/logs/.gitkeep` so the bind-mount target directory exists in a fresh clone.
- [ ] 2.5 Add `infra/observability/logs/*.json` to the repo root `.gitignore` so a developer's local backend output does not leak into git.

## 3. Infra — Tempo host port retirement

- [ ] 3.1 In `docker-compose.yml`, remove the `4317:4317` and `4318:4318` host port bindings from the existing `tempo` service. Keep the `3200:3200` HTTP API binding for direct curl debugging.
- [ ] 3.2 In `docker-compose.yml`, extend the existing `grafana` service's `depends_on` list to include `loki` and `collector` (in addition to the existing `prometheus` and `tempo` from slices 1 and 3).
- [ ] 3.3 Smoke-verify: `docker-compose --profile observability up -d` brings up all six services (`postgres`, `prometheus`, `grafana`, `tempo`, `collector`, `loki`) and the default `docker-compose up -d` still starts only `postgres`.

## 4. Infra — Grafana datasource and dashboard provisioning

- [ ] 4.1 Create `infra/observability/grafana/provisioning/datasources/loki.yaml` declaring one datasource named `Loki` of type `loki` at `http://loki:3100`, with `editable: false`, `isDefault: false`, and a `derivedFields` entry whose regex matches the literal JSON key `"trace.id":"<value>"` in the log line body and whose target is the slice-3 `Tempo` datasource.
- [ ] 4.2 Modify `infra/observability/grafana/provisioning/datasources/tempo.yaml` to add a `tracesToLogs` (or `tracesToLogsV2`) correlation block targeting the new `Loki` datasource by name (keyed on the `trace.id` span tag). Remove the slice-3 inline comment that forward-referenced this slice.
- [ ] 4.3 Modify `infra/observability/grafana/dashboards/backend-overview.json` to add one new panel titled `Recent logs` whose datasource is `Loki` and whose query is `{service_name="backend"} | json` rendered in logs view.

## 5. Backend — file appender configuration

- [ ] 5.1 In `backend/src/main/resources/application.yaml`, add `logging.structured.format.file: ecs` and `logging.file.name: ${LOG_FILE_PATH:}`. Verify locally that `./gradlew bootRun` without `LOG_FILE_PATH` set produces no file output and that running with `LOG_FILE_PATH=./infra/observability/logs/backend.json` produces ECS JSON lines in that file.
- [ ] 5.2 Confirm no `logback-spring.xml` or `logback.xml` is introduced and no `logstash-logback-encoder` dependency is added (preserves the slice-2 prohibitions).

## 6. Backend — integration test

- [ ] 6.1 Create `backend/src/test/java/com/prodready/social/observability/LogFileOutputIT.java` as a Testcontainers IT that boots the full Spring context with `LOG_FILE_PATH` set to a JUnit-managed temp file (the `test` task already carries the slice-3 `-javaagent:` flag, so the OTel agent attaches).
- [ ] 6.2 Add a `@Test` that asserts every line written to the temp file parses as one JSON object carrying the base ECS fields (`@timestamp`, `log.level`, `service.name`, `service.environment`, `process.thread.name`, `log.logger`, `message`, `ecs.version`).
- [ ] 6.3 Add a `@Test` that drives one authenticated `GET /api/v1/auth/me` and asserts the file contains a line with `event.dataset == "backend.access"` carrying non-blank `request.id`, the matching `user.id`, a 32-char lowercase hex `trace.id`, and a 16-char lowercase hex `span.id`.
- [ ] 6.4 Add a `@Test` that asserts the same `backend.access` line is byte-identical between the temp file and the captured stdout for the test run.
- [ ] 6.5 Add a `@Test` that asserts when `LOG_FILE_PATH` is unset for a second profile, no file is written to the directory the test created.
- [ ] 6.6 Confirm the test class contains no reference to Loki containers, no reference to Collector containers, and no HTTP call to host ports `4318`, `3100`, or `4317`.

## 7. README

- [ ] 7.1 Add a `### Log shipping` subsection under the existing `## Local observability` section of the top-level `README.md`, after the existing `### Distributed tracing` subsection.
- [ ] 7.2 Document that `docker-compose --profile observability up -d` now also brings up `collector` and `loki`.
- [ ] 7.3 Document the `export LOG_FILE_PATH=./infra/observability/logs/backend.json` shell line that the developer must run before `./gradlew bootRun` to enable the file appender the Collector tails.
- [ ] 7.4 Document the migration note: Tempo's OTLP receiver host ports (`4317`, `4318`) are retired in favour of the Collector; Tempo's `http://localhost:3200` HTTP API binding stays for direct curl debugging.
- [ ] 7.5 Document the `tracesToLogs` one-click pivot workflow (Tempo span → Loki log lines) and the `logsToTraces` one-click pivot workflow (Loki log line → Tempo span tree).
- [ ] 7.6 Add a one-line note that the slice-3 manual "copy `trace.id` and paste into Tempo search" workflow still works.

## 8. CI

- [ ] 8.1 Add a one-line CI step (in the existing backend workflow) that runs `docker compose --profile observability config -q` so a broken Collector or Loki YAML fails fast on CI without booting any container.

## 9. Manual smoke (developer verification before commit)

- [ ] 9.1 `docker-compose --profile observability up -d` and confirm all six services reach a healthy state.
- [ ] 9.2 `export LOG_FILE_PATH=./infra/observability/logs/backend.json && ./gradlew bootRun`, drive a login + `GET /api/v1/auth/me`, and `tail -1 ./infra/observability/logs/backend.json | jq .` shows the expected ECS JSON with populated `trace.id` and `span.id`.
- [ ] 9.3 Open Grafana at `http://localhost:3000`, navigate to the `Backend overview` dashboard, and confirm both `Recent traces` (Tempo) and `Recent logs` (Loki) panels render data from the request above.
- [ ] 9.4 Open the Loki log line for that request, click the `trace.id` derived-field link, and confirm Grafana opens the matching Tempo span tree (`logsToTraces`).
- [ ] 9.5 Open the Tempo span tree for the same request, click the "Logs for this span" / tracesToLogs link, and confirm Grafana opens the matching Loki log lines.

## 10. OpenSpec hygiene

- [ ] 10.1 Run `openspec validate add-log-shipping --strict` and resolve any failures.
- [ ] 10.2 Confirm `git status` shows only the files declared in proposal `## Impact` and no incidental edits.
