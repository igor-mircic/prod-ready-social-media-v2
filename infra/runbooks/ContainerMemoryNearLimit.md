# ContainerMemoryNearLimit

Stub runbook — fill in with real incident learnings as they accumulate.

## What the alert measures

`k8s_container_memory_limit_utilization_ratio > 0.9` sustained for 5
minutes on one container. The metric comes from the OTel `kubeletstats`
receiver (slice 21, `metrics-agent` DaemonSet) and represents the
container's working-set memory as a fraction of its declared memory
limit.

Direct OTel-family equivalent of the deleted cAdvisor-keyed rule (same
threshold, same for-window, same paging shape — only the metric source
changed).

## Impact

- The container is within 10% of its declared memory limit. If the
  working set crosses the limit, the Linux OOM killer will terminate
  the container's main process (and on the next scrape
  `ContainerRestartingFrequently` will page).
- Pages because the OOM kill is a near-term outcome: this is a
  forward-looking signal that something must change in the next 5–30
  minutes to prevent it.

## Triage

1. Read the firing container's `k8s_namespace_name`, `k8s_pod_name`, and
   `k8s_container_name` from the alert payload (webhook sink `/received`
   for local dev).
2. Live snapshot of memory:
   ```
   kubectl -n <ns> top pod <pod> --containers
   ```
   Confirm working-set memory is at or near the limit reported by:
   ```
   kubectl -n <ns> describe pod <pod>
   ```
   (look for the container's `Limits: memory: <value>`).
3. Grafana → cluster-overview dashboard → "Top-10 pods by memory
   working set" panel. Compare against the baseline over the last 1–6
   hours: is this a slow leak (steady climb), a step change (workload
   spike), or a one-off (cache warm)?
4. Cross-reference with the affected service's own dashboards — for
   `postgres` check for an open-transaction spike; for `prometheus`
   check for a new rule group or large remote-write; for the backend
   check the heap dashboard (slice 18a JVM panels).

## Mitigation

- **Legitimate baseline shift** (new feature, more replicas, more data
  cached): raise the container's memory limit in the deployment spec
  and roll the workload. Update the corresponding chart values /
  kustomize patch so the change persists.
- **Leak**: restart the pod as immediate relief
  (`kubectl -n <ns> rollout restart deployment/<name>`) and file a
  follow-up bug on the upstream image / our config that pinned the
  leak, with the working-set climb screenshot.
- **Transient spike**: no action needed once it subsides.

## Escalation

- File a ticket assigning the owner of the firing container's service
  with the dashboard snapshot and a recommendation (raise cap vs.
  investigate leak).
- Escalate to a page if `ContainerRestartingFrequently` fires for the
  same container shortly afterwards — the OOM kill has landed.
