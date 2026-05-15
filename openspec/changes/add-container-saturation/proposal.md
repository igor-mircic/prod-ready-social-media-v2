## Why

Twelve observability slices in, the project has request-level RED (slice 1), JVM internals (slice 1), Postgres internals (slice 12), three pillars wired through the Collector, an alerting loop, and exemplar-based pivots — but every container that runs under `docker-compose --profile observability` is a black box. If `grafana` leaks memory at 3am, if `prometheus` is CPU-throttled by competing scrapes, if `loki` silently restarts after an OOM, no signal reaches operators. Worse, the alerts that *do* exist surface symptoms (request latency, deadlocks) without resource context: a `FeedReadLatencySlowBurn` page is dramatically more actionable when the dashboard alongside it shows "postgres container at 95% of its memory limit." This slice adds container-tier USE (Utilization, Saturation, Errors) visibility — the layer between request RED and DB-internal metrics — and ships the resource limits that make saturation a meaningful concept in the first place.

## What Changes

- New `cadvisor` service under the `observability` docker-compose profile — pinned `gcr.io/cadvisor/cadvisor:v0.49.1` image, mounted with the read-only host paths cAdvisor needs (`/`, `/var/run`, `/sys`, `/var/lib/docker`, `/dev/disk`) to read cgroup and Docker daemon state. Scraped by Prometheus as a new `cadvisor` job.
- Conservative `deploy.resources.limits` on every existing compose service (`postgres`, `prometheus`, `grafana`, `tempo`, `loki`, `collector`, `alertmanager`, `webhook-sink`, `postgres-exporter`) and on `cadvisor` itself. Sized from the `mem_limit` ranges each upstream image documents for a small dev workload (e.g. `prometheus: 512M`, `grafana: 512M`, `loki: 512M`, `tempo: 512M`, `postgres: 1G`). Without limits, `container_spec_memory_limit_bytes` is unbounded, CFS throttling never triggers, and the saturation alerts in this slice cannot fire.
- New `infra/observability/grafana/dashboards/infrastructure-overview.json` — sibling of `backend-overview`, `frontend-overview`, `database-overview`. Rows: per-container CPU usage (cores), memory working set vs. limit (with limit overlay), network I/O bytes/sec, and container restart count over a 1h window. Picked up by the existing dashboards provisioner; no provisioning YAML change.
- New `infra/observability/prometheus/rules/container-alerts.yml`, loaded by the existing rule-files glob — three container-tier infra alerts:
  - `ContainerCpuThrottling` — `rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m]) > 0.25` for 10m, severity `ticket`. Fires when a container is being throttled against its CFS quota.
  - `ContainerMemoryNearLimit` — `container_memory_working_set_bytes / container_spec_memory_limit_bytes > 0.9` for 5m, severity `ticket`. Fires before the OOM killer engages.
  - `ContainerOomKilled` — `increase(container_oom_events_total[15m]) > 0`, severity `page`. Fires once per OOM event regardless of which container.
  All three carry `runbook_url` annotations pointing at new stubs under `infra/observability/runbooks/`. Routing uses the existing severity tree from slice 11; no Alertmanager change needed.
- New runbook stubs: `ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, `ContainerOomKilled.md` — follow the existing Symptoms / Impact / Triage / Mitigation / Escalation shape.
- New `infra/observability/prometheus/rules/container-tests.yml` — `promtool test rules` fixture exercising all three alerts against synthetic series (firing case, non-firing case, `runbook_url` annotation assertion).
- Backend integration test proves the cAdvisor surface end-to-end in-process: starts cAdvisor as a sibling testcontainer with the same host mounts as compose, asserts that `/metrics` emits the four metric families this slice depends on (`container_cpu_cfs_throttled_periods_total`, `container_cpu_cfs_periods_total`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes`, `container_oom_events_total`).
- README updates: the local observability run loop section gains a "Container infrastructure" subsection (what cAdvisor shows, how to view the dashboard, how the resource limits relate to the alerts) and a deliberate note on what is *not* covered.

Explicit non-goals (called out so reviewers know the boundary):

- **`node_exporter` / host-level metrics are deferred indefinitely.** The backend runs on the host, not in compose; `node_exporter` running in a container on macOS Docker Desktop measures the Linux VM, not the laptop, which is misleading. Real prod adds `node_exporter` per node via a Kubernetes DaemonSet — documented in the README, left as a follow-up if/when the backend is itself containerized.
- **`process-exporter` for the host JVM/Vite is not added.** JVM internals (heap, GC, thread counts) are already covered by Micrometer (slice 1); the Vite dev server is uninteresting in prod.
- **The backend is not containerized in this slice.** That is a much larger architectural change; this slice is constrained to additive container-tier visibility for what already runs in compose.
- **No new SLOs are introduced.** Container saturation is infrastructure health, not user-facing reliability. The existing API-availability, feed-read, and post-create SLOs (slices 8) cover the user-visible side.

## Capabilities

### New Capabilities

(None — this slice extends the existing `observability` capability.)

### Modified Capabilities

- `observability`: gains requirements for the `cadvisor` container under the observability profile, the resource-limit declarations on every existing compose service, the `cadvisor` Prometheus scrape job, the `infrastructure-overview` provisioned dashboard, the three container-tier alerting rules with `runbook_url` annotations, the runbook stubs, the `promtool` assertions for the new rules, the in-process integration proof, and the README run-loop documentation.

## Impact

- **Affected files / directories:**
  - `docker-compose.yml` — new `cadvisor` service under the `observability` profile; `deploy.resources.limits` added to every existing service.
  - `infra/observability/prometheus/prometheus.yml` — new `cadvisor` scrape job.
  - `infra/observability/prometheus/rules/container-alerts.yml` (new), `container-tests.yml` (new).
  - `infra/observability/grafana/dashboards/infrastructure-overview.json` (new).
  - `infra/observability/runbooks/ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, `ContainerOomKilled.md` (new).
  - Backend integration test under `backend/src/test/java/...` (new) proving the cAdvisor surface.
  - Top-level `README.md` — Container infrastructure subsection added to the observability run loop, with the host-side caveat documented.
- **Dependencies:** new pinned `cadvisor` container image. No application-code dependencies change on the backend or frontend. No existing image versions change.
- **Compatibility:** no breaking changes to running applications. The default (non-observability) compose profile is unaffected — `cadvisor` only runs under the `observability` profile, and resource limits on the other observability services don't touch the default `postgres`-only invocation. The newly-set `postgres` resource limits apply to *both* profiles (postgres is default-on); sizing is set comfortably above what local dev needs and is documented in the compose file.
- **CI:** the new e2e proof runs only when the observability profile is up; CI does not currently run that profile, so no new CI gates land. The new `promtool` test fixture runs inside the existing `promtool test rules` step.
- **macOS / Linux:** cAdvisor on Docker Desktop for macOS measures the Linux VM's containers — which is exactly what this slice wants. Linux operators get the same view directly. The host-side caveat (what node_exporter would otherwise cover) is documented in the README; no platform-conditional compose configuration is introduced.
