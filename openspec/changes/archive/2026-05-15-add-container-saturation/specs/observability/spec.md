## ADDED Requirements

### Requirement: `cadvisor` is provisioned under the `observability` docker-compose profile

A single `cadvisor` service SHALL run under the `observability` profile, exposing per-container resource metrics in Prometheus exposition format on port `8080` (published to host as `8085` to avoid colliding with the backend's host-side `8080`). The container image SHALL be `gcr.io/cadvisor/cadvisor` pinned to an explicit tag (not `latest`). The service SHALL mount the read-only host paths cAdvisor needs to read cgroup and Docker daemon state.

#### Scenario: Observability profile starts the cadvisor container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-cadvisor` container is started in addition to the other observability containers
- **AND** the container's `/metrics` endpoint is reachable from the prometheus container at `http://cadvisor:8080/metrics`

#### Scenario: Default invocation does not start cadvisor
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-cadvisor` container is NOT started

#### Scenario: cadvisor image is pinned by tag
- **WHEN** the docker-compose `cadvisor` service definition is read
- **THEN** the `image:` field is `gcr.io/cadvisor/cadvisor:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: cadvisor declares the host mounts and device passthroughs it needs
- **WHEN** the docker-compose `cadvisor` service definition is read
- **THEN** the service mounts the host's `/`, `/sys`, `/var/lib/docker/`, and `/dev/disk/` paths into the container as read-only (`:ro`)
- **AND** the service mounts the host's `/var/run/docker.sock` into the container (the Docker socket is bidirectional by nature, so the mount is `:rw`); without this mount cAdvisor cannot resolve cgroup ids to container names and the `name` label every dashboard panel and alert rule depends on stays empty
- **AND** the service exposes `/dev/kmsg` to the container via the compose `devices:` block so cAdvisor can read kernel OOM-kill notifications from the ring buffer (without this `container_oom_events_total` is populated only with zero samples)
- **AND** the service publishes container port `8080` to a host port that does not collide with any other service on the local machine (the backend runs on host `:8080`)

### Requirement: Every existing compose service declares `deploy.resources.limits`

Every service defined in `docker-compose.yml` (including the existing `postgres`, `prometheus`, `grafana`, `tempo`, `loki`, `collector`, `alertmanager`, `webhook-sink`, `postgres-exporter`, and the new `cadvisor`) SHALL declare an explicit memory limit and CPU limit via the `deploy.resources.limits` block. The limits SHALL be sized comfortably above local-dev steady-state working sets but bounded enough that a runaway container trips its own alert before swamping the host. Without these limits, the container saturation alerts in this slice cannot fire.

#### Scenario: Every service declares both a memory and a CPU limit
- **WHEN** a reader inspects each service block in `docker-compose.yml`
- **THEN** the service contains a `deploy.resources.limits` block (or the equivalent compose v2 `mem_limit` + `cpus` keys, depending on the syntax the repository settles on at implementation)
- **AND** both `memory` and `cpus` are set to non-empty values
- **AND** no service is missing a limit declaration

#### Scenario: `postgres` limits apply under both the default and observability profiles
- **WHEN** an operator runs `docker-compose up -d postgres` (no observability profile)
- **THEN** the running `social-postgres` container has the limit declared in `docker-compose.yml` applied
- **AND** the limit is comfortable for local-dev steady state (at least 1 GiB memory, at least 2 CPU equivalents)

#### Scenario: Limits are documented in compose comments
- **WHEN** a reader inspects the limit declarations in `docker-compose.yml`
- **THEN** at least one comment explains that the limits exist to make the cAdvisor saturation alerts meaningful (otherwise `container_spec_memory_limit_bytes` is unbounded and CFS throttling never triggers)

### Requirement: Prometheus scrapes `cadvisor` as a new job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL include a scrape job for the cadvisor container. The job SHALL be additive to the existing scrape jobs (the existing `backend`, `collector`, and `postgres-exporter` jobs are unchanged in name, target, and interval).

#### Scenario: Prometheus config declares the cadvisor scrape job
- **WHEN** a reader inspects `infra/observability/prometheus/prometheus.yml`
- **THEN** `scrape_configs:` contains an entry with `job_name: cadvisor`
- **AND** the entry targets `cadvisor:8080`
- **AND** the entry's `scrape_interval` is `15s` (matching the existing `backend` job)
- **AND** the entry's `metrics_path` is `/metrics` (the cAdvisor default)

#### Scenario: Prometheus scrapes cadvisor when the observability profile is up
- **WHEN** the `observability` profile is running and a reader queries `http://localhost:9090/api/v1/targets`
- **THEN** the `cadvisor` target appears with `health: "up"` after one scrape interval

### Requirement: Grafana provisions an `Infrastructure overview` dashboard

The repository SHALL include `infra/observability/grafana/dashboards/infrastructure-overview.json` declaring a Grafana dashboard that visualises per-container resource use. The dashboard SHALL be picked up automatically by the existing dashboards-provisioning glob (no provisioning YAML change required). All panels SHALL be sourced from cAdvisor metrics; no panel SHALL require ad-hoc PromQL knowledge from the operator to read.

#### Scenario: Dashboard JSON file exists alongside the existing siblings
- **WHEN** a reader inspects `infra/observability/grafana/dashboards/`
- **THEN** it contains `infrastructure-overview.json` alongside `backend-overview.json`, `frontend-overview.json`, and `database-overview.json`

#### Scenario: Dashboard contains the core panel set
- **WHEN** Grafana loads the dashboard
- **THEN** the dashboard contains at least one panel each for: per-container CPU usage, per-container CPU throttling ratio, per-container memory working set vs. limit, per-container network receive bytes, per-container network transmit bytes, per-container restart count over the last hour, and per-container OOM event count over the last hour

#### Scenario: All cAdvisor PromQL filters exclude empty-name cgroup-hierarchy series
- **WHEN** a reader inspects each PromQL expression in the dashboard JSON
- **THEN** every expression that references a `container_*` metric filters with `name!=""` (or the equivalent label match)
- **AND** no panel's PromQL query groups by a label that would include the path-style cgroup hierarchy (which would inflate cardinality)

### Requirement: Container alert rules live in `infra/observability/prometheus/rules/container-alerts.yml`

The repository SHALL include a Prometheus rules file at `infra/observability/prometheus/rules/container-alerts.yml` declaring container-tier infra alerts. The file SHALL be loaded by Prometheus via the existing `rule_files:` configuration in `prometheus.yml`.

#### Scenario: Rules file exists in the expected directory
- **WHEN** a reader inspects `infra/observability/prometheus/rules/`
- **THEN** it contains `container-alerts.yml` alongside the existing SLO and database rule files

#### Scenario: Prometheus loads the container rules at startup
- **WHEN** Prometheus starts with the observability profile up
- **THEN** `http://localhost:9090/api/v1/rules` reports the `container-alerts` rule group with at least the alerts named in this spec

#### Scenario: prometheus.yml references the new rule file
- **WHEN** a reader inspects `rule_files:` in `prometheus.yml`
- **THEN** the list includes `rules/container-alerts.yml` alongside the existing `slo-*`, `fe-slo-*`, and `database-alerts` entries

### Requirement: A `ContainerCpuThrottling` alert covers sustained CFS throttling

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerCpuThrottling` that fires when a container is throttled against its CFS quota for a sustained period. The alert SHALL carry severity `ticket` (routing via the existing severity tree from slice 11 to the ticket-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerCpuThrottling.md`.

#### Scenario: Alert is declared with the throttling-ratio expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerCpuThrottling`
- **AND** the alert's `expr` measures the per-container ratio `sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m]))` exceeding `0.25`
- **AND** the alert's `for:` clause is `10m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerCpuThrottling` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerCpuThrottling.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

### Requirement: A `ContainerMemoryNearLimit` alert covers approaching-OOM memory pressure

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerMemoryNearLimit` that fires when a container's working set approaches its declared memory limit. The alert SHALL carry severity `ticket` and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerMemoryNearLimit.md`.

#### Scenario: Alert is declared with the memory-ratio expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerMemoryNearLimit`
- **AND** the alert's `expr` measures the per-container ratio `container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""}` exceeding `0.9`
- **AND** the alert's `for:` clause is `5m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerMemoryNearLimit` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerMemoryNearLimit.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

#### Scenario: Alert silently no-ops on un-limited containers
- **WHEN** the cluster contains a container that has no memory limit declared (so `container_spec_memory_limit_bytes` reports as `0`)
- **THEN** the alert expression evaluates to a non-finite ratio that does not satisfy `> 0.9`
- **AND** the alert does NOT fire for that container

### Requirement: A `ContainerOomKilled` alert covers OOM-kill events

The repository's `container-alerts.yml` SHALL declare an alerting rule named `ContainerOomKilled` that fires when one or more OOM-kill events are recorded by cAdvisor in the recent 15-minute window. The alert SHALL carry severity `page` (routing to the page-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/ContainerOomKilled.md`.

#### Scenario: Alert is declared with the OOM-event expression
- **WHEN** a reader inspects `container-alerts.yml`
- **THEN** the file declares an alert named `ContainerOomKilled`
- **AND** the alert's `expr` is `increase(container_oom_events_total{name!=""}[15m]) > 0`
- **AND** the alert has no `for:` clause (a single OOM is sufficient to page)

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `ContainerOomKilled` alert
- **THEN** the alert's `labels:` block contains `severity: page`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/ContainerOomKilled.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description` that include the firing container's `name` label via templating

### Requirement: Runbook stubs exist for the three container alerts

The repository SHALL include Markdown runbook stubs at `infra/observability/runbooks/ContainerCpuThrottling.md`, `infra/observability/runbooks/ContainerMemoryNearLimit.md`, and `infra/observability/runbooks/ContainerOomKilled.md`, matching the shape of the slice-11 stubs (Symptoms / Impact / Triage / Mitigation / Escalation).

#### Scenario: Stubs exist with the canonical section shape
- **WHEN** a reader inspects `infra/observability/runbooks/`
- **THEN** the directory contains `ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, and `ContainerOomKilled.md`
- **AND** each file contains the section headings `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in any reasonable order and heading level)

### Requirement: `promtool test rules` covers the container alerts

The repository SHALL include `infra/observability/prometheus/rules/container-tests.yml` exercising all three container alerts against synthetic series. The fixture SHALL be discovered by the existing `promtool test rules` invocation that already covers the SLO and database rule tests. The fixture SHALL assert both the firing condition, the steady-state non-firing condition, and the presence of the `runbook_url` annotation for every alert.

#### Scenario: Test fixture lives next to the rule file
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `container-tests.yml` alongside `container-alerts.yml`

#### Scenario: Each container alert has at least one fires-as-expected test case
- **WHEN** the fixture is read
- **THEN** `ContainerCpuThrottling` has a stanza feeding synthetic `container_cpu_cfs_throttled_periods_total` and `container_cpu_cfs_periods_total` series for a named container that drive the ratio above 0.25 for at least 10 minutes, and asserts the alert is in `firing` state at that simulated time with `severity: ticket` and a non-empty `runbook_url` annotation
- **AND** `ContainerMemoryNearLimit` has a stanza feeding synthetic `container_memory_working_set_bytes` and `container_spec_memory_limit_bytes` series for a named container that drive the ratio above 0.9 for at least 5 minutes, and asserts the alert is in `firing` state with `severity: ticket` and a non-empty `runbook_url` annotation
- **AND** `ContainerOomKilled` has a stanza feeding a synthetic `container_oom_events_total` series for a named container that increases by at least 1 within a 15-minute window, and asserts the alert is in `firing` state with `severity: page` and a non-empty `runbook_url` annotation

#### Scenario: Each container alert has at least one steady-state-no-fire test case
- **WHEN** the fixture is read
- **THEN** `ContainerCpuThrottling` has a stanza where the throttling ratio stays below 0.25 and the alert is NOT in `firing` state
- **AND** `ContainerMemoryNearLimit` has a stanza where the working-set / limit ratio stays below 0.9 and the alert is NOT in `firing` state
- **AND** `ContainerOomKilled` has a stanza where `container_oom_events_total` is flat and the alert is NOT in `firing` state

#### Scenario: ContainerMemoryNearLimit fixture covers the un-limited-container case
- **WHEN** the fixture is read
- **THEN** `ContainerMemoryNearLimit` has a stanza where `container_spec_memory_limit_bytes` is `0` for a container while its working set is non-zero, and the alert is NOT in `firing` state for that container (ratio is non-finite, expression does not match)

### Requirement: Backend integration test proves the cAdvisor pipeline end-to-end

A backend integration test SHALL prove the cAdvisor → metrics surface end-to-end. The test SHALL use testcontainers to bring up cAdvisor with the same read-only host mounts the compose service uses, drive a small workload so cAdvisor has non-empty containers to report on, then HTTP-fetch the cAdvisor `/metrics` endpoint and assert presence of the metric families this slice depends on. The test MAY be gated behind a system property if needed for CI-runner compatibility.

#### Scenario: Test brings up cAdvisor as a sibling testcontainer
- **WHEN** the integration test starts the cAdvisor testcontainer
- **THEN** the container uses the same pinned image tag as `docker-compose.yml`
- **AND** the container is started with the same read-only host mounts the compose service declares
- **AND** the container's `/metrics` endpoint is reachable from the test JVM

#### Scenario: Test asserts the cAdvisor scrape exposes the required metric families
- **WHEN** the test fetches `http://<cadvisor>:8080/metrics`
- **THEN** the response body contains at least one sample of each of the following metric families: `container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes`, and `container_oom_events_total`
- **AND** at least one of each metric family carries a non-empty `name` label (proving the per-container series are present, not only the cgroup-hierarchy series)

#### Scenario: Test gating is documented if the test is not always-on
- **WHEN** the test class is read
- **THEN** any conditional gating (e.g. `@EnabledIfSystemProperty`, `@DisabledOnOs`, or environment-variable checks) is paired with a comment explaining the gate (CI runner does not run the observability profile, or platform-specific Docker socket constraints)

### Requirement: README documents the local container-observability run loop

The repository README's observability section SHALL gain a "Container infrastructure" subsection that names the new cAdvisor service, the new dashboard, the alert trio, the resource-limit pass on existing services, and the explicit non-goals (no `node_exporter` for the host, no `process-exporter` for the host JVM, backend not containerized in this slice).

#### Scenario: README documents the container-observability run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9090/api/v1/targets` as the place to verify the `cadvisor` scrape target is healthy
- **AND** the README names the `Infrastructure overview` dashboard and how to navigate to it from Grafana
- **AND** the README documents the three new alerts (`ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`) and notes that they ride the existing severity routing to the webhook sink
- **AND** the README explains the resource-limit declarations and notes that the alerts cannot fire without limits
- **AND** the README explicitly notes the deferred items: `node_exporter` would be added per node in a real prod deploy via a Kubernetes DaemonSet, `process-exporter` for the host JVM is not added because Micrometer already covers JVM internals, and containerizing the backend is a separate architectural change
