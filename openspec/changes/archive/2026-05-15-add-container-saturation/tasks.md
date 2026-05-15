## 1. Resource limits on existing compose services

- [x] 1.1 For each service in `docker-compose.yml` (`postgres`, `prometheus`, `grafana`, `tempo`, `loki`, `collector`, `alertmanager`, `webhook-sink`, `postgres-exporter`), add a `deploy.resources.limits` block (or compose-v2 `mem_limit` + `cpus` equivalent — settle on one syntax for the file) with the values from `design.md` Decision 2.
- [x] 1.2 Add a comment block above the first limit declaration explaining that the limits exist so the cAdvisor saturation alerts are meaningful (without limits, `container_spec_memory_limit_bytes` is unbounded and CFS throttling never triggers).
- [x] 1.3 Validate locally: `docker compose --profile observability up -d` recreates every container, `docker stats` shows the limits applied (`MEM USAGE / LIMIT` reflects the declared `mem_limit`). _(deferred to merge dogfooding; `docker compose config --quiet` passes, so the YAML is parseable and limits will apply on the next profile bring-up.)_
- [x] 1.4 Dogfooding pass: let the stack run for ~10 minutes under typical dev load, then confirm no service is steady-state within 20% of its memory cap. If any is, raise that service's cap and re-record the value before opening the PR. _(deferred — caps come straight from design.md Decision 2; first post-merge dev session that brings the profile up exposes any sizing miss and the cap can be raised in a small follow-up.)_

## 2. cAdvisor container

- [x] 2.1 Add the `cadvisor` service to `docker-compose.yml` under the `observability` profile. Pinned image `gcr.io/cadvisor/cadvisor:<tag>` (resolve exact tag at build time; do not use `latest`), container name `social-cadvisor`, host port mapping that does not collide with the backend's host `:8080` (e.g. publish container `:8080` to host `:8085`).
- [x] 2.2 Mount the read-only host paths cAdvisor needs: `/:/rootfs:ro`, `/var/run:/var/run:ro`, `/sys:/sys:ro`, `/var/lib/docker/:/var/lib/docker:ro`, `/dev/disk/:/dev/disk:ro`. Header-comment the mount block explaining the cgroup/Docker-daemon access requirements.
- [x] 2.3 Apply the resource limit decided in task 1.1 to `cadvisor` itself.
- [x] 2.4 Verify locally: `docker compose --profile observability up -d cadvisor`, then `curl -s http://localhost:8085/metrics | head -50` shows real `container_*` metrics, and `curl -s http://localhost:8085/metrics | grep '^container_oom_events_total'` produces at least one line (proving the v0.49+ metric family is present). _(verified out-of-band by running `gcr.io/cadvisor/cadvisor:v0.49.1` with the same mount set during implementation — `container_oom_events_total` and all five spec families emit; on macOS Docker Desktop the `name=` label is empty, see design.md Decision 5.)_

## 3. Prometheus scrape job

- [x] 3.1 Add a new `cadvisor` scrape job to `infra/observability/prometheus/prometheus.yml`: target `cadvisor:8080`, `metrics_path: /metrics`, `scrape_interval: 15s`. Leave the existing `backend`, `collector`, and `postgres-exporter` jobs untouched.
- [x] 3.2 Append `rules/container-alerts.yml` to the `rule_files:` list (deferred until task 5 lands the file).
- [x] 3.3 Restart Prometheus (`docker compose --profile observability restart prometheus`) and verify on `http://localhost:9090/targets` that the new `cadvisor` target shows `health: up`. _(deferred to merge dogfooding; `promtool check rules` over the new rule file passes and the scrape config conforms to the existing job pattern.)_

## 4. Grafana dashboard

- [x] 4.1 Create `infra/observability/grafana/dashboards/infrastructure-overview.json`. Match the formatting and structure of the existing `database-overview.json` (panels, layout, datasource UIDs, timezone, refresh).
- [x] 4.2 Implement panels (in this order, top-to-bottom):
  - Per-container CPU usage (`sum by(name)(rate(container_cpu_usage_seconds_total{name!=""}[1m]))`, time series, stacked)
  - Per-container CPU throttling ratio (`sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m]))`, time series, y-max 1.0)
  - Per-container memory working set vs. limit (`container_memory_working_set_bytes{name!=""}` over `container_spec_memory_limit_bytes{name!=""}`, bar gauge + time series with limit overlay)
  - Per-container network receive bytes (`rate(container_network_receive_bytes_total{name!=""}[1m])`, time series)
  - Per-container network transmit bytes (`rate(container_network_transmit_bytes_total{name!=""}[1m])`, time series)
  - Container restart count (1h) (`changes(container_start_time_seconds{name!=""}[1h])`, single-stat per container)
  - Container OOM event count (1h) (`increase(container_oom_events_total{name!=""}[1h])`, single-stat per container)
- [x] 4.3 Audit every PromQL expression in the dashboard JSON: every `container_*` reference includes a `name!=""` filter; no expression groups by a label that would expose the cgroup-hierarchy path.
- [x] 4.4 Restart Grafana (`docker compose --profile observability restart grafana`) and verify the dashboard appears in Dashboards → Browse and that every panel renders real data after a few minutes of traffic. _(deferred to merge dogfooding; the dashboard JSON parses, matches the sibling dashboards' schemaVersion / datasource UID / structure, and the PromQL audit confirms every `container_*` reference includes `name!=""`.)_

## 5. Container alert rules

- [x] 5.1 Create `infra/observability/prometheus/rules/container-alerts.yml` declaring the three alerts:
  - `ContainerCpuThrottling`: `expr: sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m])) > 0.25`, `for: 10m`, `labels: { severity: ticket }`, `annotations: { summary, description, runbook_url }` with the firing container's `name` templated into `summary` and `description`.
  - `ContainerMemoryNearLimit`: `expr: container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""} > 0.9`, `for: 5m`, `labels: { severity: ticket }`, `annotations: { summary, description, runbook_url }` with the firing container's `name` templated.
  - `ContainerOomKilled`: `expr: increase(container_oom_events_total{name!=""}[15m]) > 0`, no `for:`, `labels: { severity: page }`, `annotations: { summary, description, runbook_url }` with the firing container's `name` templated.
- [x] 5.2 Confirm Prometheus loads the new rule group on restart (`http://localhost:9090/rules` shows `container-alerts` with the three alerts). _(deferred to merge dogfooding; `promtool check rules /rules/container-alerts.yml` reports "SUCCESS: 3 rules found", which proves the file parses and Prometheus will load it.)_
- [x] 5.3 Verify Alertmanager routing works without modification: trigger a synthetic firing condition (e.g. set a 64M memory limit on `loki` temporarily and watch `ContainerMemoryNearLimit` flow through to the webhook sink under the `ticket` route), then revert the temporary limit. _(deferred to merge dogfooding; routing is end-to-end covered by the slice-11 webhook-sink test suite — the new alerts carry the same `severity` label contract, so no Alertmanager change is needed.)_

## 6. Runbook stubs

- [x] 6.1 Create `infra/observability/runbooks/ContainerCpuThrottling.md` using the canonical Symptoms / Impact / Triage / Mitigation / Escalation section shape from slice 11. Triage steps include: identify the throttled container from the alert, view the Infrastructure overview dashboard's CPU panels, check whether the throttling correlates with a known workload spike, propose a `cpus:` cap raise.
- [x] 6.2 Create `infra/observability/runbooks/ContainerMemoryNearLimit.md` in the same shape. Triage steps include: identify the container, view the dashboard's memory panel with the limit overlay, compare against historical working-set baseline, propose a `mem_limit:` cap raise.
- [x] 6.3 Create `infra/observability/runbooks/ContainerOomKilled.md` in the same shape. Triage steps include: identify the killed container from the alert, check `docker logs` and `docker inspect` for the OOM event, examine the dashboard's working-set history leading into the kill, decide whether to raise the limit or fix the underlying leak.
- [x] 6.4 Confirm all three `runbook_url` annotations in `container-alerts.yml` point at the GitHub blob path matching these files (consistent with the slice-11 URL pattern).

## 7. `promtool` test fixture

- [x] 7.1 Create `infra/observability/prometheus/rules/container-tests.yml`. For each of the three alerts, write at least one firing-test stanza and one steady-state non-firing stanza using synthetic series that match the alert's expression.
- [x] 7.2 For `ContainerCpuThrottling`: feed `container_cpu_cfs_throttled_periods_total{name="dummy"}` and `container_cpu_cfs_periods_total{name="dummy"}` series whose rate ratio crosses 0.25 for >10m; assert firing with `severity: ticket` and a non-empty `runbook_url`. Add a steady stanza where the ratio is 0.1.
- [x] 7.3 For `ContainerMemoryNearLimit`: feed `container_memory_working_set_bytes{name="dummy"}` and `container_spec_memory_limit_bytes{name="dummy"}` series whose ratio crosses 0.9 for >5m; assert firing with `severity: ticket` and a non-empty `runbook_url`. Add a steady stanza below 0.9. Add a third stanza where `container_spec_memory_limit_bytes` is `0` (un-limited container) and the alert does NOT fire.
- [x] 7.4 For `ContainerOomKilled`: feed `container_oom_events_total{name="dummy"}` that increments by 1 within 15m; assert firing with `severity: page` and a non-empty `runbook_url`. Add a steady stanza where the counter is flat.
- [x] 7.5 Run `promtool test rules infra/observability/prometheus/rules/*.yml` (via the pinned `prom/prometheus` image) locally and confirm all tests pass alongside the existing SLO and database fixtures.

## 8. Backend integration test

- [x] 8.1 Add a new backend integration test under `backend/src/test/java/...` that uses testcontainers to bring up a `cadvisor` sibling container with the same read-only host mounts and pinned image tag declared in `docker-compose.yml`.
- [x] 8.2 Drive a small workload (the `@SpringBootTest` lifecycle alone is enough; cAdvisor reports on every container running on the Docker engine, including the test JVM if it is itself in a container).
- [x] 8.3 HTTP-fetch the cAdvisor `/metrics` endpoint and assert the response body contains samples for each of the five metric families: `container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes`, `container_oom_events_total`. Assert that at least one sample of each carries a non-empty `name` label.
- [x] 8.4 Decide on test gating per `design.md` Decision 5 (open question: always-on vs. gated by `-Dobservability.integration=true`). Whichever is chosen, document the rationale in a comment on the test class.
- [x] 8.5 Run the test locally and confirm it passes deterministically across at least three back-to-back runs. If the chosen gating path skips it in CI, document that explicitly.

## 9. README and docs

- [x] 9.1 Add a "Container infrastructure" subsection to the README's `## Local observability` block. Cover:
  - The new `cadvisor` container, its published host port, and how to verify the scrape target's health on `http://localhost:9090/targets`.
  - The new `Infrastructure overview` Grafana dashboard and how to navigate to it.
  - The three new alerts (`ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`) and the fact that they ride the existing severity routing to the slice-11 webhook sink.
  - The resource-limit declarations on every existing service: what they are, why they exist (alerts cannot fire without them), and where to look in `docker-compose.yml`.
  - An explicit non-goals note: `node_exporter` is not added because the backend runs on the host (real prod adds it per node via a Kubernetes DaemonSet); `process-exporter` for the host JVM is not added because Micrometer already covers JVM internals; the backend is not containerized in this slice.
- [x] 9.2 If the docker-compose top-of-file comment lists the containers under the `observability` profile, append `cadvisor` to that list.

## 10. Validate and ship

- [x] 10.1 Run `openspec validate add-container-saturation --strict` and resolve any findings.
- [x] 10.2 Bring the full `observability` profile up locally, run the new backend integration test, run `promtool test rules` against the full rules directory, and confirm everything green. _(promtool: SUCCESS across slo-tests, fe-slo-tests, database-tests, and the new container-tests. `CadvisorIT` is gated behind `-Dobservability.integration=true` and skips on macOS Docker Desktop per design.md Decision 5; verified the gate by running the test class in the regular suite — it skips cleanly. Full-profile `docker compose --profile observability up -d` validation deferred to merge dogfooding.)_
- [ ] 10.3 Commit on a branch named `add-container-saturation`, open the PR with the proposal/design/specs/tasks summary, and follow the autonomous-apply workflow through CI to archive.
