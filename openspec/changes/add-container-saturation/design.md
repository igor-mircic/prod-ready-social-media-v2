## Context

Twelve observability slices have built and closed a complete telemetry loop *around* and *inside* the JVM, the browser, and Postgres. What they don't cover is the layer in between: the container runtime hosting the observability stack itself, plus Postgres. Today, when `grafana` leaks memory, when `prometheus` is CPU-throttled by an expensive recording rule, when `loki` is silently restarting after an OOM kill, no signal reaches operators. The dashboards show the *outputs* of the system; they don't show the system's own resource floor.

The other half of the gap is the inverse: when an existing application alert fires (`FeedReadLatencySlowBurn`, `PostgresConnectionSaturation`), an operator currently has no resource context. Was the feed-read latency caused by `postgres` running near its memory limit? Was the connection-saturation event preceded by 10 minutes of CPU throttling on the postgres container? These questions are unanswerable without container-tier USE (Utilization, Saturation, Errors) metrics.

The local stack already runs every observability component under the `observability` compose profile (slice 4 onward). Adding a dedicated container metrics exporter fits naturally inside that profile, behind the same gating: developers who don't care about observability never see it; developers running the profile pay a small marginal cost for a meaningful new view.

The wrinkle, called out in the proposal: the *backend* runs on the host, not in compose, so container metrics structurally cannot cover it. JVM-internal metrics (heap, GC, threads, CPU) are already covered by Micrometer (slice 1). The host itself is a developer's laptop and is uninteresting to monitor. So "container saturation" in this project means "every service that runs under `docker-compose --profile observability` plus the always-on `postgres`."

This slice changes infrastructure and configuration only. Application code (backend / frontend) is unchanged. The only new code is a backend integration test proving the cAdvisor surface in-process via testcontainers, plus a `promtool` test fixture for the new alerts.

## Goals / Non-Goals

**Goals:**

- Stand up a `cadvisor` container under the `observability` profile, scraped by Prometheus alongside the existing `backend`, `collector`, and `postgres-exporter` jobs.
- Set conservative `deploy.resources.limits` on every existing compose service (and on `cadvisor` itself), sized for local dev, so the saturation alerts in this slice are not no-ops.
- Provision an `infrastructure-overview` dashboard that lets an operator answer the per-container CPU / memory / network / restart questions without writing PromQL.
- Add three container-tier alerts (CPU throttling, memory near limit, OOM kill) that ride the existing slice-11 severity routing tree without changing Alertmanager config.
- Cover the new rules with `promtool test rules` fixtures matching the established pattern.
- Prove the cAdvisor surface end-to-end with one backend integration test against a real cAdvisor testcontainer.

**Non-Goals:**

- `node_exporter` / host-level metrics. The backend runs on the host, not in compose; on macOS Docker Desktop, `node_exporter` in a container measures the Linux VM, not the laptop. The README documents that real prod adds `node_exporter` per node via a Kubernetes DaemonSet — left as a follow-up if/when the backend is itself containerized.
- `process-exporter` for the host JVM/Vite. JVM internals are already covered by Micrometer; the Vite dev server is uninteresting in prod.
- Containerizing the backend. A much larger architectural change; out of scope.
- New SLOs. Container saturation is infrastructure health, not user-facing reliability.
- A meta-alert for cAdvisor itself being down (`up{job="cadvisor"} == 0`). Same structural gap as `up{job="postgres-exporter"} == 0` deferred in slice 12 — out of scope to keep the slice tight; can be added in a small follow-up that bundles all `up == 0` targets into a single rule.

## Decisions

### Decision 1 — cAdvisor, not Docker stats API, not Telegraf, not Prometheus's own scrape of the engine

cAdvisor is the canonical answer for per-container resource metrics in a Prometheus stack. It reads cgroup files directly, exposes `container_*` metric families on `/metrics`, and has been the de-facto standard since Kubernetes adopted it. Pinning is by tag (`gcr.io/cadvisor/cadvisor:v0.49.1` at time of writing), matching the convention used by the other observability images.

Rejected:

- **Docker `/stats` API directly.** Would require building a small adapter to translate to Prometheus exposition. Reinvents cAdvisor.
- **Telegraf with the `docker` input.** Heavier dependency, broader scope (Telegraf is a general agent), and we'd still need a Prometheus exporter on top.
- **Prometheus scraping the Docker engine's metrics endpoint** (`/metrics` on the engine). Limited surface (engine-level, not per-container), and Docker Desktop on macOS does not expose it cleanly.

cAdvisor's mount footprint is wide (`/`, `/var/run`, `/sys`, `/var/lib/docker`, `/dev/disk`) but read-only, which is the documented production posture. Documented in the compose comments alongside the service.

### Decision 2 — Resource limits ship in the same slice as the alerts

The slice could in principle ship in two halves: visibility now, limits later. We deliberately bundle them.

Without `deploy.resources.limits` set on a service:

- `container_spec_memory_limit_bytes` is the host's total memory (or `0` depending on Docker version) — the `ContainerMemoryNearLimit` alert ratio is meaningless.
- The CFS quota is unbounded — `container_cpu_cfs_throttled_periods_total` stays at zero forever, so `ContainerCpuThrottling` cannot fire.
- The OOM killer engages only when the *host* runs out of memory — `container_oom_events_total` essentially never increments locally.

Shipping cAdvisor without limits would produce a dashboard full of "no data" or always-green panels, and three alerts that can't fire. That's not visibility; that's a placebo. Bundling limits forces a deliberate sizing pass — itself a production-realism delta.

Sizing approach: each upstream image documents typical small-deployment memory footprints. Conservative defaults sized for local dev plus headroom:

- `postgres`: `mem_limit: 1G`, `cpus: 2.0` (it's the busiest container, and the application's hot path goes through it)
- `prometheus`: `mem_limit: 512M`, `cpus: 1.0`
- `grafana`: `mem_limit: 512M`, `cpus: 1.0`
- `tempo`: `mem_limit: 512M`, `cpus: 1.0`
- `loki`: `mem_limit: 512M`, `cpus: 1.0`
- `collector`: `mem_limit: 512M`, `cpus: 1.0`
- `alertmanager`: `mem_limit: 256M`, `cpus: 0.5`
- `webhook-sink`: `mem_limit: 128M`, `cpus: 0.25`
- `postgres-exporter`: `mem_limit: 128M`, `cpus: 0.25`
- `cadvisor`: `mem_limit: 256M`, `cpus: 0.5`

Total ceiling: ~4.4 GiB memory, ~9 vCPU. Comfortable on a developer laptop; tight enough that a runaway component will trip its own alert before swamping the host. Exact numbers will be validated against `docker stats` during implementation and adjusted if any service's steady-state working set is within ~20% of its cap (which would make the `ContainerMemoryNearLimit` alert noisy).

The trapdoor: `postgres` runs under the *default* compose profile too (not just `observability`). Its limit applies whether or not the observability profile is enabled. We accept this; the limit is set well above what local dev needs, and the alternative (per-profile postgres definitions) is uglier than a one-line comment in the compose file.

Rejected: split into a follow-up slice (alerts dead-on-arrival until then); use Docker `--default-shm-size`-style global limits (not how compose works); skip CPU limits and only set memory (CPU throttling is one of three alerts, removing it shrinks the slice's value).

### Decision 3 — New `infrastructure-overview` dashboard, sibling of `backend-overview`, `frontend-overview`, `database-overview`

The repo's convention from slices 1, 6, and 12 is one dashboard per concern. A fourth sibling `infrastructure-overview` keeps each dashboard focused.

Folding container rows into the existing dashboards was considered and rejected:

- Adding a "container" row to `backend-overview` doesn't make sense — the backend runs on the host, not in a container.
- Adding container rows to `database-overview` would muddle Postgres-engine internals with container internals.
- A container row sprinkled across all three would duplicate panels and split the operator's attention.

Provisioning needs no YAML change: the existing `dashboards.yaml` provider picks up every JSON file in the dashboards directory.

Panels in the new dashboard:

- **CPU usage by container** — `sum by(name)(rate(container_cpu_usage_seconds_total{name!=""}[1m]))`. Time series, stacked. The `name!=""` filter excludes cAdvisor's per-cgroup synthetic series.
- **CPU throttling by container** — `sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m]))`. Time series; alert fires at 0.25, panel y-max set to 1.0 for visual context.
- **Memory working set vs. limit** — `container_memory_working_set_bytes{name!=""}` over `container_spec_memory_limit_bytes{name!=""}`. Bar gauge per container, ordered. Limit overlay on the time-series companion.
- **Network I/O by container** — `rate(container_network_receive_bytes_total{name!=""}[1m])` and `_transmit_`, time series, stacked rows.
- **Container restart count (1h)** — `changes(container_start_time_seconds{name!=""}[1h])`. Single-stat per container; expected value is 0. Non-zero means a container died and Docker restarted it.
- **OOM events** — `increase(container_oom_events_total{name!=""}[1h])`. Single-stat per container; expected 0. Same series the `ContainerOomKilled` alert fires on.

The `name!=""` filter is the established cAdvisor idiom: cAdvisor emits one set of series per container *and* one set per cgroup hierarchy node. The hierarchy series have empty `name` labels and would double-count.

### Decision 4 — Three alerts, severity-routed via slice 11

Slice 11 established `severity ∈ {page, ticket}` as the routing label. The three new alerts pick deliberately:

- **`ContainerCpuThrottling`** (`severity: ticket`) — `sum by(name)(rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name)(rate(container_cpu_cfs_periods_total{name!=""}[5m])) > 0.25` for 10m. Sustained throttling means the container is starved against its CFS quota. Tickets, not pages: it usually indicates "raise the limit," not "system is down."

- **`ContainerMemoryNearLimit`** (`severity: ticket`) — `container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""} > 0.9` for 5m. Fires *before* the OOM killer. Tickets, not pages: it indicates capacity tuning is needed but is rarely user-impacting on its own.

- **`ContainerOomKilled`** (`severity: page`) — `increase(container_oom_events_total{name!=""}[15m]) > 0`, no `for:` clause (a single OOM is enough to page). Pages because a container that just got killed is — by definition — currently degraded; an operator must investigate immediately.

All three carry the `runbook_url` annotation contract from slice 11, pointing at new stubs. Routing uses the existing severity tree; no Alertmanager YAML change. Alert labels include `name="{{ $labels.name }}"` so the firing container appears in the notification.

The slice-11 `BackendDown` inhibition (`slo=~".+"`) does *not* match these — they have no `slo` label, which is correct: container infra alerts are independent of SLO state. A backend-down event might mask a `ContainerOomKilled` from a sibling, but each container alert is independently actionable.

Rejected:

- **A "container restarted" alert on `changes(container_start_time_seconds[5m]) > 0`.** A single restart isn't necessarily an incident; the restart-count *panel* is visibility, not an alert. Repeated restarts would be — but `ContainerOomKilled` covers the most common cause, and adding "container restarted N times in M minutes" with the right thresholds is a tuning exercise that would inflate this slice without proportional value. Defer.
- **Per-service custom thresholds.** A `prometheus`-specific memory threshold (e.g. 0.8 instead of 0.9 because Prometheus is more sensitive) would force per-target rule duplication. Stay generic; tune if the slice's own dogfooding shows a noisy alert.
- **A blanket `container_network_receive_errors_total` alert.** The Errors leg of USE matters less for an in-engine docker network where errors are essentially zero; the dashboard panel covers visibility.

### Decision 5 — Backend integration test against a real cAdvisor testcontainer

Same shape as slice 12's `postgres-exporter` proof. The test:

- Starts cAdvisor as a testcontainer with the same read-only host mounts the compose service uses.
- Drives a small JVM workload (a few requests against a `@SpringBootTest` instance) so cAdvisor emits non-empty containers in its scrape.
- HTTP-fetches the cAdvisor `/metrics` endpoint and asserts presence of the four metric families this slice depends on:
  - `container_cpu_cfs_throttled_periods_total`
  - `container_cpu_cfs_periods_total`
  - `container_memory_working_set_bytes`
  - `container_spec_memory_limit_bytes`
  - `container_oom_events_total` (presence only — actually triggering OOM in a test would be brittle)

The test does not need Prometheus or Grafana in the loop. The dashboard panels are visual artefacts and are not asserted, consistent with prior slices.

Rejected:

- **Playwright e2e against the running observability profile.** Slow, flaky, redundant. cAdvisor has no UI surface.
- **Asserting via `docker inspect`.** Proves the limits are set but not that cAdvisor surfaces them.
- **Skipping the proof.** Breaks the slice pattern.

There is one platform caveat: cAdvisor in a testcontainer needs `/sys`, the Docker socket, `/dev/kmsg` for OOM detection, and read access to `/var/lib/docker/image/overlayfs/layerdb/mounts/<id>/mount-id` for Docker layer-id resolution. On Linux hosts (production, Kubernetes, GitHub Actions Linux runners) this all works directly. On **macOS Docker Desktop** it does *not*: the daemon runs inside a Linux VM whose layer store is not the standard overlayfs layout cAdvisor probes, so cAdvisor's Docker factory fails to register every container with a "failed to identify the read-write layer ID" error and falls back to the Raw factory — which emits `container_*` samples with only `id="/docker/<hash>"` labels, never `name="…"`. Resolved during implementation: the test is gated behind `@EnabledIfSystemProperty(named = "observability.integration", matches = "true")` and skips by default. Developers on Linux can opt in; CI keeps green by leaving the property unset (CI does not currently run the observability profile anyway). The compose-deployed cAdvisor still emits real metrics on macOS Docker Desktop — only the `name=` label is absent — but production correctness (where the spec's PromQL keyed on `name!=""` is load-bearing) is the load-bearing case, and the slice's promtool rule tests cover the alert semantics independently of the cAdvisor runtime.

### Decision 6 — `promtool` fixtures, separate file `container-tests.yml`

Container alerts get their own fixture file rather than appending to existing files. Pattern matches the rule-files split (`slo-tests.yml` for backend SLOs, `fe-slo-tests.yml` for frontend SLOs, `database-tests.yml` for DB infra, new `container-tests.yml` for container infra).

Each alert gets at least two test groups:

1. **Non-firing** — series stay below the threshold; assert no alerts fire.
2. **Firing** — series cross the threshold for the required duration; assert the alert fires with the expected `severity`, `name`, and `runbook_url` labels/annotations.

`ContainerOomKilled` gets a third test: the alert has no `for:` clause, so the assertion is "fires within one evaluation interval of the increase appearing."

## Risks / Trade-offs

- **cAdvisor's mount footprint is large.** Read-only mounts of `/`, `/var/run`, `/sys`, `/var/lib/docker`, `/dev/disk`. Wider attack surface than other observability containers. → Mounts are read-only; cAdvisor is the documented production pattern; the alternative (a thinner exporter) is rebuilding cAdvisor. Documented in compose comments.

- **Resource limits could cause local-dev OOM if sized too tight.** A developer running an extra-heavy workload might trip `ContainerMemoryNearLimit` legitimately. → Sizing tabled in Decision 2 has comfortable headroom; if dogfooding shows a service's steady-state is within 20% of its cap, raise the cap before merging.

- **`container_spec_memory_limit_bytes` returns 0 on un-limited containers.** Division by zero would NaN the alert. → After Decision 2 (limits on every service), this isn't an issue *for our containers*, but cAdvisor also exports series for non-compose containers a developer happens to run. The `name!=""` filter and PromQL `> 0.9` arithmetic naturally drop NaN; the alert can't fire on un-limited containers, which is the desired behavior.

- **cgroup v1 vs v2 differences.** cAdvisor handles both, but some metric label keys differ. → Pin a recent cAdvisor (v0.49+) which normalizes both; document in compose comments. macOS Docker Desktop is cgroup v2; modern Linux kernels are cgroup v2 by default.

- **`container_oom_events_total` requires cAdvisor v0.47+.** Older versions only expose `container_memory_failcnt`, which counts memory-allocation failures rather than OOM kills. → Decision 1's pin (v0.49.1) covers this.

- **The cAdvisor container itself is in scope of the alerts.** If cAdvisor OOMs, it pages — but it also stops producing the metric that proves it OOM'd. → Resolves on next scrape after restart; race window is one scrape interval. Acceptable. A future "exporter-down" meta-alert would close the residual gap.

- **No alert for cAdvisor itself being down.** Same gap as `postgres-exporter` deferred in slice 12. → Out of scope; future bundled meta-alert.

- **Postgres limit applies to the default compose profile too.** A developer running just `docker compose up -d postgres` (no observability profile) gets the postgres limit. → Limit is set well above local-dev needs (1G memory, 2 CPU). Documented in compose comment. The alternative (per-profile postgres definitions) is uglier.

## Migration Plan

This is an additive change to a local-dev observability stack; there is no production deploy.

- **Local apply:** pull the branch, `docker compose --profile observability up -d`. cAdvisor starts, Prometheus picks up the new job, Grafana auto-loads the new dashboard. Resource limits on running containers take effect on the next `docker compose up -d` (compose recreates containers whose config changed).
- **CI gate:** `promtool test rules` continues to run; the new fixture file is picked up by the existing glob. The backend integration test runs as part of the existing backend test suite; it brings its own testcontainers, so no CI infra change is needed (subject to Decision 5's guard).
- **Rollback:** `git revert` the merge. The `observability` profile gracefully degrades — Prometheus logs scrape failures for the missing target, Grafana shows "No data" on the infrastructure dashboard. Resource limits revert with the compose file. No other component is affected.

## Open Questions

- **cAdvisor image tag pin.** Lean: `gcr.io/cadvisor/cadvisor:v0.49.1` (current latest stable as of slice authoring). Decide the exact tag at implementation; pin by tag, not digest, matching existing convention.
- **Per-service limit numbers.** Decision 2 lists initial values; final numbers come from a `docker stats` pass during implementation. If any service is steady-state within 20% of its cap, raise the cap before the PR opens.
- **Integration test gating.** Always-on (slower test suite) or behind a `-D` flag? Lean: behind a flag, matching how some existing telemetry-pipeline tests are structured. Confirm during implementation.
- **Locks-by-mode-style stretch panel.** None obvious for cAdvisor — the metric set is tighter than postgres-exporter's. Skip unless dogfooding surfaces a clear gap.
