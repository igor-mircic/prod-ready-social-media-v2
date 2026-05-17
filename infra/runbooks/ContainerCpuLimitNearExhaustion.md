# ContainerCpuLimitNearExhaustion

Stub runbook — fill in with real incident learnings as they accumulate.

## What the alert measures

`k8s_container_cpu_limit_utilization_ratio > 0.9` sustained for 5 minutes
on one container. The metric comes from the OTel `kubeletstats` receiver
(slice 21, `metrics-agent` DaemonSet) and represents the container's CPU
usage as a fraction of its declared CPU limit.

**Proxy for CFS throttling.** The OTel kubeletstats receiver does NOT
emit the CFS-period throttling counters that cAdvisor surfaces
(`container_cpu_cfs_throttled_periods_total`); slice 21 deliberately did
not add a cAdvisor scrape. Sustained near-limit utilisation correlates
with throttling — a container at >90% of its CPU limit will be throttled
by the Linux CFS scheduler whenever it briefly exceeds the cap, which is
what produces user-visible latency spikes. The signal is one step removed
from "throttle events per period" but operationally identical from a
"page someone" standpoint. See
`openspec/changes/add-k8s-container-saturation-alerts/design.md`
Decision 1 for the full rename rationale.

## Impact

- The container is within 10% of its declared CPU limit. Bursts above the
  limit get throttled by the kernel CFS scheduler — wall-clock latency
  for any work the container performs inflates during the burst.
- Pages because sustained near-limit utilisation correlates with
  user-visible latency. The throttling itself is not directly observable
  from prom (see Triage step 4 for cAdvisor on the node if you need the
  exact period-throttling counts).

## Triage

1. Read the firing container's `k8s_namespace_name`, `k8s_pod_name`, and
   `k8s_container_name` from the alert payload (webhook sink `/received`
   for local dev).
2. Live snapshot of resource usage:
   ```
   kubectl -n <ns> top pod <pod> --containers
   ```
   Confirm CPU usage is at or near the limit reported by:
   ```
   kubectl -n <ns> describe pod <pod>
   ```
   (look for the container's `Limits: cpu: <value>`).
3. Grafana → cluster-overview dashboard → "Top-10 pods by CPU utilisation
   ratio" panel. Compare against the baseline over the last 1–6 hours: is
   this a slow climb (workload growth), a step change (new feature
   shipped), or a one-off spike (burst job)?
4. If the exact CFS throttling counts matter, the cAdvisor
   `/metrics/cadvisor` endpoint on the node still exposes them:
   ```
   kubectl get --raw /api/v1/nodes/<node>/proxy/metrics/cadvisor \
     | grep container_cpu_cfs_throttled_periods_total
   ```
   Not scraped into prom; one-shot inspection only.

## Mitigation

- **Legitimate baseline shift** (new feature, new workload, more
  replicas): raise the container's CPU limit in the deployment spec and
  roll the workload. Update the corresponding chart values / kustomize
  patch so the change persists.
- **Right-sizing**: if the request and limit are set conservatively but
  the workload could distribute across replicas, scale the deployment
  horizontally (`kubectl scale`).
- **Regression**: if a previously cheap operation has become expensive,
  file a follow-up on the offending service rather than papering over
  with a higher cap.
- **Transient spike** (one-off backfill, dashboard refresh during
  incident): no action needed once it subsides.

## Escalation

- File a ticket assigning the owner of the firing container's service
  with the dashboard snapshot and a recommendation.
- Escalate to a page if CPU throttling correlates with a parallel SLO
  burn (e.g. `ApiAvailabilityFastBurn` for the same backend pod) — that
  escalation pattern means user impact is landing.
