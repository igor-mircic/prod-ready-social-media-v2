# ContainerRestartingFrequently

Stub runbook — fill in with real incident learnings as they accumulate.

## What the alert measures

`increase(k8s_container_restarts[5m]) > 1` — a container restarted more
than once inside a 5-minute window, no `for:` window. The metric comes
from the OTel `kubeletstats` receiver (slice 21, `metrics-agent`
DaemonSet); the counter is per-container, reset on each pod recreation.

**Reason-agnostic loop detector.** The OTel families surface restart
counts but NOT termination reason. There is no OOM-specific metric, no
liveness-probe-failed metric, no image-pull-failure metric. The renamed
runbook (was `ContainerOomKilled`) trades the metric-side specificity
for a wider net: this alert fires for OOM kills, liveness probe
failures, image pull failures, panics on startup, and so on. The
operator owns the "why did it restart?" diagnosis via `kubectl describe
pod`. See
`openspec/changes/add-k8s-container-saturation-alerts/design.md`
Decision 2 for the full rename rationale.

**Threshold choice.** `> 1` (not `> 0`) so a single startup-probe
restart does not page; some lifecycles legitimately restart once on
startup. Two restarts in 5 minutes signals a real loop. No `for:`
window — a restart loop should page on the second restart, not after a
further 5-minute confirmation delay.

## Impact

- The container is in a restart loop. Anything in flight at the
  termination moment was lost; downstream consumers will have seen
  errors / timeouts. Warm caches are gone; Java cold-start tax is being
  paid repeatedly.
- Pages because a looping container is, by definition, currently
  degraded. Each restart compounds the disruption.

## Triage

1. Read the firing container's `k8s_namespace_name`, `k8s_pod_name`, and
   `k8s_container_name` from the alert payload (webhook sink `/received`
   for local dev).
2. Inspect `Last State` for the termination reason — kubelet writes the
   reason there:
   ```
   kubectl -n <ns> describe pod <pod>
   ```
   Look for `Last State: Terminated` and its `Reason:` field. Common
   values:
   - `OOMKilled` — the Linux OOM killer terminated the container after
     it exceeded its memory limit. Go to mitigation: memory.
   - `Error` — the container exited non-zero on its own. Go to triage
     step 3 for logs.
   - `CrashLoopBackOff` (Status, not Reason) — kubelet is in backoff;
     check the underlying termination reason from the previous restart.
3. Pull the previous container's stdout/stderr for stack traces or
   panic messages:
   ```
   kubectl -n <ns> logs <pod> --previous
   ```
4. If the pod is already gone (replaced by a new one with a different
   name), the kubelet's OOM-kill log lines will still be in the loki
   stream from slice 20:
   ```
   {k8s_namespace_name="kube-system", k8s_container_name="kubelet"} |~ "OOMKilled|out of memory"
   ```
   Filter to the relevant time window in Grafana → Explore → loki.
5. Grafana → cluster-overview dashboard → "Container restart count
   (1h)" panel to confirm the loop is sustained, not a single bad
   transition.

## Mitigation

By termination reason:

- **OOMKilled** — raise the container's memory limit in the deployment
  spec (and/or its request, since the request affects scheduling) and
  roll the workload. If the climb looks like a leak (working set rising
  continuously without a workload change), file a follow-up bug on the
  upstream image / our config that pinned the leak.
- **Image pull failure** — verify the image tag exists in the registry
  the pod is pulling from; check the pod's
  `imagePullSecrets`. For local dev: `nerdctl -n k8s.io images | grep
  <name>` inside the Lima VM.
- **Liveness probe failed** — check the probe definition in the
  deployment spec. Common causes: probe timeout too short for cold
  start, probe endpoint changed in a new release, probe hitting a
  dependency that's down.
- **Panic / non-zero exit on startup** — read the `logs --previous`
  output for the stack trace; this is a release regression and likely
  needs a code fix or config rollback.

## Escalation

- File a page-priority ticket assigning the owner of the firing
  container's service with the termination reason, the loki snippet of
  the relevant kubelet log lines, and the `logs --previous` output.
- If multiple unrelated containers across the cluster are restarting at
  the same time, the *node* itself is likely under pressure (memory,
  disk, CPU steal). Inspect `kubectl describe node` and host-side
  metrics; this escalation pattern indicates a different problem
  (cluster-level resource exhaustion).
