## REMOVED Requirements

### Requirement: Prometheus scrape configuration lives in `infra/observability/prometheus/`

**Reason**: The compose `prometheus` service is deleted in this slice. The single source of metrics scraping for the project is now the obs-cluster prometheus instance, governed by the `observability-cluster` capability. Compose retains only the `postgres` service.

**Migration**: Backend metrics reach prometheus via the slice-18a/18b path (backend → app collector → obs-cluster prometheus via `prometheusremotewrite/in-cluster` exporter), not via a compose-side scrape. The path is normative under the existing `observability-cluster` requirement "The obs cluster prometheus chart enables the remote-write receiver." The `infra/observability/prometheus/` directory is deleted by this slice.

### Requirement: Grafana provisioning lives in `infra/observability/grafana/`

**Reason**: The compose `grafana` service is deleted in this slice. The single source of dashboard provisioning is the obs-cluster grafana instance, governed by the `observability-cluster` capability.

**Migration**: Datasource and dashboard provisioning for the obs grafana is normative under the existing `observability-cluster` requirements ("Grafana stands up with no datasources configured" — updated post-slice-18b to provision datasources — and "The obs grafana chart provisions the three migrated dashboards"). The `infra/observability/grafana/` directory is deleted by this slice.

### Requirement: One provisioned dashboard renders RED, DB, JVM, and business panels

**Reason**: The compose grafana dashboard `infra/observability/grafana/dashboards/backend-overview.json` is deleted with the compose grafana stack. The same dashboard content lives in the obs grafana as `infra/k8s-obs/base/grafana/dashboards/backend-overview.json` (migrated in slice 22a with the `instance` selector relaxed per the slice-22a migration rules).

**Migration**: The dashboard is provisioned under the existing `observability-cluster` requirement "The obs grafana chart provisions the three migrated dashboards." Panel content (RED + DB + JVM + business timers, the high-cardinality `by (...)` constraint) is preserved verbatim in the migrated JSON.

### Requirement: Observability stack starts under the `observability` docker-compose profile

**Reason**: The compose `observability` profile is deleted entirely. The seven services it gated (`prometheus`, `grafana`, `tempo`, `loki`, `alertmanager`, `webhook-sink`, `postgres-exporter`, and the compose `collector`) move to the obs cluster (or, in the case of `postgres-exporter`, to the app cluster — slice 22a). The default `docker-compose up` invocation continues to start only `postgres`, but now because that is the only service compose knows about.

**Migration**: The observability run loop becomes `just obs-up` (obs cluster) plus `just up` (app cluster); the README's Local observability section is rewritten to describe this path.

### Requirement: README documents the local observability run loop

**Reason**: The compose-flavoured `## Local observability` section pins behavior (`docker-compose --profile observability up`, `:3000`, `:9090`, "anonymous viewer access for local dev only") that no longer exists.

**Migration**: A rewritten `## Local observability` section describes the obs-cluster run loop: `just obs-up` brings up the obs Lima VM and the LGTM stack; obs grafana is reachable at `http://localhost:3001` with the four provisioned dashboards (`Backend overview`, `Frontend overview`, `Database overview`, `Cluster overview`); prometheus / tempo / loki / alertmanager / webhook-sink are reachable on the host via the obs VM portForwards (`:9090`, `:3200`, `:3100`, `:9093`, `:8081`). The README continues to flag that all of the above is local-dev-only.

### Requirement: Tempo is provisioned under the `observability` docker-compose profile and as a Grafana datasource

**Reason**: The compose `tempo` service and its `infra/observability/tempo/tempo.yaml` config are deleted in this slice. Tempo runs only in the obs cluster.

**Migration**: The obs cluster's tempo chart is governed by the `observability-cluster` capability (slice 17 stood it up; slice 18b provisioned it as a grafana datasource). The trace-to-logs correlation that the compose tempo datasource declared via `tracesToLogs`/`tracesToLogsV2` is preserved by the obs grafana datasource provisioning that slice 18b landed. The host port `:3200` continues to expose tempo's HTTP API — now routed to the obs cluster's tempo Service by a new Lima portForward declared in `infra/lima/obs.yaml`.

### Requirement: OpenTelemetry Collector is provisioned under the `observability` docker-compose profile with two pipelines

**Reason**: The compose `collector` service and its `infra/observability/collector/collector-config.yaml` config are deleted in this slice. OTel collection runs only inside the two k3s clusters: the app collector (`infra/k8s/base/collector/`, slice 18a) gates outbound batches; the obs collector (`infra/k8s-obs/base/collector/`, slice 17–18b) receives them.

**Migration**: The app collector's pipeline is governed by the `kubernetes` capability's "The collector pipeline is declared in a `collector-config` ConfigMap..." requirement (updated by this slice to drop the three compose-relay exporters). The obs collector's pipeline is governed by the `observability-cluster` capability's "The obs collector ConfigMap declares the OTLP-receiver → batch → redact → otlp/tempo pipeline" requirement.

### Requirement: Loki is provisioned under the `observability` docker-compose profile as a Grafana datasource

**Reason**: The compose `loki` service and its `infra/observability/loki/loki-config.yaml` config are deleted in this slice. Loki runs only in the obs cluster.

**Migration**: The obs cluster's loki chart is governed by the `observability-cluster` capability (slice 17 stood it up; slice 18b provisioned it as a grafana datasource). The `derivedFields` logs-to-traces correlation that the compose loki datasource declared is preserved by the obs grafana datasource provisioning that slice 18b landed. The host port `:3100` continues to expose loki's HTTP API — now routed to the obs cluster's loki Service by a new Lima portForward declared in `infra/lima/obs.yaml`. The "Recent logs" panel on `backend-overview.json` is preserved verbatim in the migrated dashboard (slice 22a).

### Requirement: OTel Collector exposes FE metrics via a `prometheus` exporter on `:8889`

**Reason**: The compose collector is deleted with the compose stack. The obs collector does not expose a Prometheus-format `/metrics` endpoint on the host — and deliberately so, per design.md Decision 3: the only intended consumer of FE metrics is the obs prometheus, which receives them via the obs collector's OTLP-to-`prometheusremotewrite` path; adding a host-reachable scrape surface would invert the push-only data plane the slice-17–22a arc commits to.

**Migration**: FE metric series continue to exist with the same names and labels — they reach obs prometheus via the obs collector's `prometheusremotewrite/in-cluster` exporter (governed by `observability-cluster`). Tests and operators query obs prometheus directly on `localhost:9090` (host) or `prometheus-server.observability.svc.cluster.local:80` (in-cluster) instead of the deleted `localhost:8889`.

### Requirement: Prometheus scrapes the Collector as a new `collector` job

**Reason**: The compose prometheus is deleted; FE metrics no longer reach a prometheus by scrape. The obs prometheus receives FE metrics via OTLP push through the `prometheusremotewrite/in-cluster` exporter on the obs collector (slice 18b/18c).

**Migration**: The end-to-end shape is unchanged for any consumer that queries by metric name: `web_vitals_*`, `route_change_duration_ms_*`, `long_task_duration_ms_*`, and the FE error counter all continue to land in prometheus under the same series names. Only the transport from collector to prometheus changes (scrape → remote-write). No `collector` job is needed under `scrape_configs:` because there is no `scrape_configs:` block in the obs prom chart values for FE metrics.

### Requirement: Grafana provisions a `Frontend overview` dashboard

**Reason**: The compose grafana dashboard `infra/observability/grafana/dashboards/frontend-overview.json` is deleted with the compose grafana stack. The same dashboard content lives in the obs grafana as `infra/k8s-obs/base/grafana/dashboards/frontend-overview.json` (migrated in slice 22a).

**Migration**: The dashboard is provisioned under the existing `observability-cluster` requirement "The obs grafana chart provisions the three migrated dashboards." Panel content (Web Vitals p75 panels, route timing, long tasks, browser request volume, the SLO row with LCP / INP budget headroom and burn-rate panels) is preserved verbatim in the migrated JSON.

### Requirement: Prometheus rule files live in `infra/observability/prometheus/rules/` and are loaded at startup

**Reason**: The compose `prometheus` service and the `infra/observability/prometheus/rules/` directory are deleted in this slice. The five SLO + database rule files (`slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`) live only at `infra/k8s-obs/base/prometheus/rules/` post-22b. `container-alerts.yml` is deleted entirely (design.md Decision 4 — re-authoring against OTel-shaped families is a separate follow-up slice).

**Migration**: The five rule files are loaded into obs prometheus via the kustomize-generated `prometheus-extra-rules` ConfigMap declared by the existing `observability-cluster` requirement "The obs prometheus chart mounts the migrated rule files via a kustomize-generated ConfigMap." The CI `prometheus-rules` job's `promtool check rules` step is repointed to `infra/k8s-obs/base/prometheus/rules/*.yml`; the `promtool test rules` step reads from the relocated `infra/k8s-obs/base/prometheus/tests/` (the four `*-tests.yml` fixtures move out of `infra/observability/prometheus/rules/` in this slice). The slice-22a CI diff-guard between compose-side and obs-side copies is removed because there is no compose-side copy to diff.

### Requirement: Per-alert runbook stubs live under `infra/observability/runbooks/`

**Reason**: The `infra/observability/` directory is deleted in this slice. The 17 runbook stubs that were keyed to alert names relocate to `infra/runbooks/` (design.md Decision 1 — granular relocation by consumer).

**Migration**: All 17 markdown files move from `infra/observability/runbooks/*.md` to `infra/runbooks/*.md` byte-identically. The `runbook_url` annotation on every alerting rule in `infra/k8s-obs/base/prometheus/rules/*.yml` is updated to point at the new path (path component changes from `infra/observability/runbooks/` to `infra/runbooks/`; the GitHub host and `main` branch reference stay). Click-through from alertmanager / grafana to the runbook URL remains valid post-merge.

## MODIFIED Requirements

### Requirement: End-to-end test proves the FE → Collector → Prometheus metrics pipeline

The repository SHALL include a Playwright spec at `e2e/tests/observability.frontend-rum-metrics.spec.ts` that drives one authenticated session through the home page and at least one route transition, then asserts the FE metrics reached prometheus. The spec SHALL be skipped (via `test.skip(...)`) when `http://localhost:9090/-/healthy` is unreachable, matching the slice-5 pattern that keeps the suite green when the obs cluster is not up.

#### Scenario: Prometheus query returns the FE-emitted series

- **GIVEN** the obs cluster is up and the obs collector's `prometheusremotewrite/in-cluster` exporter is healthy
- **AND** the spec has driven one authenticated session through `/home` and at least one navigation to `/users/{id}`
- **WHEN** at least 30 s have elapsed since the first observation (one OTLP export interval plus one prom scrape interval for the remote-write to land and be visible to query)
- **AND** the spec queries `GET http://localhost:9090/api/v1/query?query=web_vitals_lcp_bucket{service_name="frontend"}`
- **THEN** the response status is 200
- **AND** `data.result` is a non-empty array

#### Scenario: Prometheus query returns the route timing series

- **GIVEN** the same authenticated traffic from the previous scenario
- **WHEN** the spec queries `GET http://localhost:9090/api/v1/query?query=route_change_duration_ms_bucket{service_name="frontend"}`
- **THEN** the response status is 200
- **AND** `data.result` contains at least one sample
- **AND** every sample's `route` label is a route template (no resolved id — the slice-5/6 redaction contract is preserved end-to-end)

#### Scenario: Spec is skipped cleanly when obs cluster is not running

- **GIVEN** `http://localhost:9090/-/healthy` returns a network error
- **WHEN** the spec runs
- **THEN** every test case in the file reports as `skipped`, not `failed`

### Requirement: Backend writes ECS JSON log events to an env-var-gated file in addition to stdout

The `backend/` project SHALL extend `backend/src/main/resources/application.yaml` so that, when the environment variable `LOG_FILE_PATH` is set to a non-empty value, every log event is appended as one ECS JSON line to the file at that path in addition to the existing stdout emission. The file output SHALL use `logging.structured.format.file: ecs` so the file lines are byte-identical to the corresponding stdout lines. When `LOG_FILE_PATH` is unset or empty, no file appender SHALL engage and the dev loop SHALL be byte-identical to slice 2 / slice 3 behaviour. The file appender SHALL NOT introduce a `logback-spring.xml`, a `logback.xml`, or any dependency on `net.logstash.logback:logstash-logback-encoder` (the existing slice-2 prohibitions are preserved).

The repository SHALL NOT include any committed `infra/observability/logs/` directory or analogous host log-mount point. The `LOG_FILE_PATH` value is opt-in and accepts any writable host path; the README documents `/tmp/backend.json` as the example.

#### Scenario: File appender does not engage by default

- **GIVEN** the backend is started with no `LOG_FILE_PATH` environment variable set
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** no file is created at any path the backend controls

#### Scenario: File appender writes ECS JSON when `LOG_FILE_PATH` is set

- **GIVEN** the backend is started with `LOG_FILE_PATH=/some/writable/path/backend.json`
- **WHEN** the backend writes a log event
- **THEN** the event appears as one ECS JSON line on stdout
- **AND** the same event appears as one ECS JSON line appended to `/some/writable/path/backend.json`
- **AND** the two lines are byte-identical

#### Scenario: File lines carry the full ECS field set including correlation fields

- **GIVEN** the backend is started with a non-empty `LOG_FILE_PATH`
- **WHEN** an authenticated client calls `GET /api/v1/auth/me` with a valid bearer token for user U
- **THEN** the file contains one line with `event.dataset == "backend.access"`
- **AND** that line carries the base ECS fields (`@timestamp`, `log.level`, `service.name`, `service.environment`, `process.thread.name`, `log.logger`, `message`, `ecs.version`)
- **AND** that line carries a non-blank `request.id`
- **AND** that line carries a `user.id` equal to U's id as a string
- **AND** that line carries a 32-character lowercase hex `trace.id`
- **AND** that line carries a 16-character lowercase hex `span.id`

#### Scenario: No `logback-spring.xml` is introduced (preserved across slice 4)

- **WHEN** a reader inspects `backend/src/main/resources/`
- **THEN** the directory contains neither `logback-spring.xml` nor `logback.xml`
- **AND** `backend/build.gradle.kts` declares no dependency on `net.logstash.logback:logstash-logback-encoder`

#### Scenario: No committed host log-mount directory

- **WHEN** a reader inspects the repository
- **THEN** no `infra/observability/logs/` directory exists
- **AND** no other committed directory is reserved for the backend's `LOG_FILE_PATH` output
