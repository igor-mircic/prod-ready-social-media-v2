## Context

Slice 22b deleted `container-alerts.yml` because its three rules were keyed on cAdvisor families (`container_cpu_cfs_throttled_periods_total`, `container_memory_usage_bytes`, `kube_pod_container_status_restarts_total` with a `reason="OOMKilled"` join) that the slice-21 OTel-shaped metrics path does not emit. The slice-22a design called this gap out and named the follow-up slice. This is that slice.

**Where the system is today (post-slice-22b):**

- Obs prometheus is the canonical metrics store. Cluster-state metrics arrive from the slice-21 `metrics-agent` DaemonSet (kubeletstats + hostmetrics) and `metrics-cluster-agent` Deployment (k8s_cluster) via the app collector → obs collector → `prometheusremotewrite` path.
- The OTel naming convention in use: dotted names get translated to underscored names by `prometheusremotewrite`; OpenMetrics-conformant unit suffixes get appended (e.g. `k8s.node.cpu.utilization` → `k8s_node_cpu_utilization_ratio`).
- Existing rule set in `infra/k8s-obs/base/prometheus/rules/`: five files (`slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`). All `severity=page` alerts route via the alertmanager `page-webhook` receiver (slice 22a routing tree).
- The slice-21 `cluster-overview` grafana dashboard renders the per-pod CPU / memory / restart panels using these same OTel families — proves the families and PromQL shape work; this slice extends from rendering to alerting.

**Constraints inherited from earlier slices:**

- No Prometheus Operator / kube-prometheus-stack (README design constraint). Rules are plain YAML in a kustomize-generated ConfigMap.
- Runbook URLs encode `github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/<name>.md` per slice 22b. The annotations are dead links until the PR merges to main — accepted standard window.
- The OTel `kubeletstats` receiver (slice 21) does not emit CFS-throttling counters; cAdvisor is the only source for that, and the slice-21 design explicitly rejected adding a cAdvisor scrape (the OTel families were the chosen north star).
- The OTel families do not surface container termination reason. Restart count is available; "OOMKilled" specifically is not derivable from prometheus alone.

**Stakeholder reading this design:** the next /apply session and the operator who will respond to one of these alerts firing for the first time.

## Goals / Non-Goals

**Goals:**

1. The three container-saturation paging signals are restored — coverage equivalent to or honestly broader than what the cAdvisor-keyed rules gave us.
2. Every PromQL expression in the new rule file resolves against series the slice-21 OTel families actually emit. The promtool test fixture proves this.
3. Runbook URLs on the new alerts point at existing files under `infra/runbooks/`. No dead links beyond the standard "URL is dead until the PR merges" window.
4. CI continues to validate rule syntax (`promtool check rules`) and now validates rule behaviour (`promtool test rules` against `container-tests.yml`).
5. The two outstanding "container-saturation alerting gap" follow-up bullets in the Hetzner overlay stubs are deleted in the same commit that lands the rules.

**Non-Goals:**

- **Adding a cAdvisor scrape** to recover the literal `container_cpu_cfs_throttled_periods_total` series. The slice-21 design rejected this and the OTel-family proxy (`k8s_container_cpu_limit_utilization > 0.9`) is the chosen path — see Decision 1.
- **OOM-specific detection via prometheus**. The OTel families don't carry termination reason. This slice alerts on restart frequency (`k8s_container_restarts`) and routes operator diagnosis of "why did the container restart?" to the runbook — see Decision 2.
- **Alertmanager routing changes**. The three new alerts inherit the slice-22a severity-keyed routing tree unchanged.
- **Grafana dashboard changes**. The slice-21 `cluster-overview` dashboard already visualises the same series; no panel edits.
- **A new e2e spec.** The existing `observability.alerting.spec.ts` proves the alertmanager routing path end-to-end with the slice-8 SLO alerts; adding a third firing path for these new alerts would duplicate coverage without proving anything new — see Decision 3.
- **Backend / frontend code changes.** None of the three alerts require app-side instrumentation; everything is sourced from the kubeletstats DaemonSet.

## Decisions

### Decision 1 — `ContainerCpuLimitNearExhaustion` replaces `ContainerCpuThrottling`; alert on limit utilisation, not throttling

The deleted rule was `ContainerCpuThrottling`, keyed on `container_cpu_cfs_throttled_periods_total / container_cpu_cfs_periods_total > 0.25` over 5m. The signal it captures is "CFS scheduler had to throttle this container because it tried to exceed its CPU limit." That's a useful operator signal — throttling is what causes p99 latency spikes that the user sees but the container-level CPU dashboard doesn't.

The OTel `kubeletstats` receiver (slice 21) emits per-container CPU utilisation against the limit (`k8s.container.cpu_limit_utilization`, named `k8s_container_cpu_limit_utilization_ratio` after `prometheusremotewrite` translation — note the `_ratio` suffix appended by the OpenMetrics-conformant unit-suffix discipline) but does NOT emit the CFS-period counters. There is no way to express "throttled" exactly without adding a cAdvisor scrape, which slice 21 explicitly rejected.

Two practical options:

- **(i) Add a cAdvisor scrape** to recover the exact metric. Possible via the apiserver's `/metrics/cadvisor` path or the kubelet's `:10255` endpoint. Reverses the slice-21 design choice and reintroduces cAdvisor families the project explicitly steered away from. Rejected.
- **(ii) Alert on `k8s_container_cpu_limit_utilization_ratio > 0.9 for 5m`.** Proxy: a container running sustained at >90% of its limit *will* be throttled by the kernel CFS scheduler whenever it briefly exceeds the limit (which is what produces the user-visible latency spike). The signal is one step removed from "throttle event count" but operationally identical from a "page someone" standpoint. The rule renames to `ContainerCpuLimitNearExhaustion` to match the new semantics; misnaming it `ContainerCpuThrottling` would lie about what the alert measures.

(ii) wins. The runbook (renamed to `ContainerCpuLimitNearExhaustion.md`) names the relationship to actual throttling and tells the operator to inspect cAdvisor on the node if they need exact throttle counts.

**Threshold choice:** `> 0.9 for 5m` matches the deleted rule's 25%-of-periods-throttled threshold roughly — empirically, a container at >90% sustained CPU-limit utilisation throttles on ~20–40% of periods during burst windows, depending on workload shape. We can tighten or relax during the first month of operation; the threshold is the cheapest change to revisit.

### Decision 2 — `ContainerRestartingFrequently` replaces `ContainerOomKilled`; alert on restart count, diagnose reason in runbook

The deleted rule was `ContainerOomKilled`, keyed on `increase(kube_pod_container_status_restarts_total{reason="OOMKilled"}[5m]) > 0`. The OTel families surface restart count (`k8s.container.restarts`, named `k8s_container_restarts` after translation — restart count is unit-less so no suffix) but do not surface termination reason. There is no OOM-specific OTel metric in the kubeletstats family set.

Alternatives:

- **(i) Add `kube-state-metrics`** to recover the labelled-by-reason restart counter. Adds a Deployment + its scrape config + a new top-level metric source. Heavier than this slice should carry — kube-state-metrics is its own slice if/when the project wants per-pod-phase, per-deployment-replicas, per-job-condition signals. Rejected for scope.
- **(ii) Alert on restart frequency, runbook diagnoses reason.** `increase(k8s_container_restarts[5m]) > 1` fires for any cause: OOM, liveness-probe failure, image-pull failure, panic on startup. The runbook (renamed to `ContainerRestartingFrequently.md`) instructs the operator to:
  1. `kubectl -n <ns> describe pod <pod>` and inspect `Last State` for the termination reason (kubelet writes `Reason: OOMKilled` there).
  2. `kubectl -n <ns> logs <pod> --previous` for stack traces or panic messages.
  3. Cross-reference the slice-20 loki stream for kubelet OOM-kill log lines if the pod is already gone.

(ii) wins. The cost is one extra `kubectl describe` step for the operator; the benefit is no new metric source and an alert that fires for restart causes the cAdvisor rule didn't cover.

**Threshold choice:** `> 1` (not `> 0`) prevents firing on a single restart — startup probes intentionally restart pods that aren't ready; one restart is normal in some lifecycles. Two restarts in 5 minutes signals a real loop.

**No `for:` window** — restart loops should page immediately. A 5m for-window with a 5m increase window would mean a 10-minute latency between the second restart and the page. Unacceptable for a paging signal.

### Decision 3 — No new e2e spec; coverage is delegated to promtool test rules

The existing observability e2e specs (slice 8 + 22b) cover the alerting *path*: alert fires in prom → alertmanager receives it → webhook-sink records the POST body. Adding a fourth firing path here would prove only that the path still works for one more alert name — duplicate of what the existing `observability.alerting.spec.ts` proves for `BackendDown`.

What's actually load-bearing for these three new rules is PromQL correctness: do the expressions match series the slice-21 families emit, and do they fire at the right thresholds? `promtool test rules` proves both, deterministically, in CI, in milliseconds. The promtool test fixture (`container-tests.yml`) is the chosen verification path.

If a future slice grows the e2e harness to assert on alertmanager-receiver-side payloads (e.g. "the page-webhook receiver got an alert whose `alertname` is `ContainerRestartingFrequently`"), it could extend `observability.alerting.spec.ts` then. Not in scope here.

### Decision 4 — `container-tests.yml` becomes the canonical fixture set (rewrites the historical-record content from slice 22b)

Slice 22b's spec language described `container-tests.yml` as "retained as a historical record... not currently active against any rule file." That description was honest at the time — the file existed because it had been relocated wholesale from `infra/observability/prometheus/rules/`, but the rules it tested were keyed on cAdvisor series that the obs cluster doesn't have, so promtool would fail if run against the old assertions.

This slice rewrites `container-tests.yml` content-completely against the new rules' PromQL. The OLD content (cAdvisor-keyed assertions) doesn't move anywhere — it's deleted in this slice; the file name is reused for the new fixture. The previous spec language ("historical record") evolves to "active fixture for the three container-saturation rules" in the spec delta.

This avoids a confusing diff where `container-tests.yml` exists in both an "old historical" and "new active" state during the slice. One file, one purpose, swapped in one commit.

## Risks

- **PromQL label shape mismatch.** The OTel-translated label names (`k8s_namespace_name` vs `namespace`, `k8s_container_name` vs `container`) depend on the `prometheusremotewrite` exporter's translation settings — which are chart defaults in slice 18c. The promtool test fixture catches mismatches on the rule-expression side; runtime label divergence is caught by manual smoke (apply slice, query prom, confirm series exist). Verification step in tasks.md.

- **Threshold churn.** The `0.9` / `1` thresholds are guesses informed by the deleted rule's defaults. First-month operation will likely require tightening or relaxing. The cost of a threshold change is one PR touching one file; not a blocker for this slice landing.

- **Annotation runbook links 404 until merge.** Standard window; same shape as every prior slice's `runbook_url` annotations.

- **Renaming the alerts** breaks any external mute / silence the operator may have established against the old `ContainerCpuThrottling` / `ContainerOomKilled` names. No such silences exist today (no operator has ever paged on these — the rules were deleted before they ever fired in obs prom); accept the rename cost.
