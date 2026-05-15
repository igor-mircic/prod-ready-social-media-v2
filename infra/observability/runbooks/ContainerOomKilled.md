# ContainerOomKilled

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- `increase(container_oom_events_total{name!=""}[15m])` is greater than `0` for one or more containers — at least one OOM-kill event was recorded by cAdvisor within the last 15 minutes.
- The firing container's `name` label is included in the alert summary.
- `docker ps` may show the container with a recent `Started` timestamp (Docker's restart policy will typically have brought it back); `docker inspect <name>` shows `OOMKilled: true` in the most recent state.
- Grafana → Infrastructure overview → "Container OOM event count (1h)" shows a non-zero stat for the same container; the memory-vs-limit panel shows the working-set climb leading into the kill.

## Impact

- The Linux OOM killer terminated the container's main process after it exceeded its `mem_limit` in `docker-compose.yml`. Anything in flight at the kill moment was lost; downstream consumers will have seen errors / timeouts.
- Pages because a container that was just killed is, by definition, currently degraded. Even after Docker's restart, the service has just lost in-flight state and warm caches.

## Triage

- Read the firing container's `name` from the alert payload (webhook sink `/received` for local dev).
- Pull the container's logs and inspect output for the OOM moment:
  - `docker compose --profile observability logs --tail 200 <name>`
  - `docker inspect <name> --format '{{json .State}}' | jq` — confirms `"OOMKilled": true` and `ExitCode: 137`.
- Open Grafana → Infrastructure overview → "Per-container memory working set vs. limit". Look at the working-set history leading into the kill: was the climb a slow leak, a step-change, or a one-shot spike?
- Cross-reference with the affected service's own dashboards (`Backend overview`, `Database overview`, etc.) for unusual workload around the kill timestamp.

## Mitigation

- If a leak is the cause, the restart already took the immediate pressure off. File a follow-up bug on the upstream image / our config that pinned the leak, with the dashboard snapshot of the working-set climb.
- If a workload spike is the cause, decide between raising the `mem_limit:` cap (legitimate baseline shift) and rate-limiting / scaling the producer side.
- If the OOM kill is recurring within minutes (`ContainerOomKilled` re-fires repeatedly), escalate immediately — the restart loop is making the situation worse for any downstream consumer.

## Escalation

- Page the on-call owner of the firing container's service (backend, observability, etc.) with the kill timestamp and a link to the relevant dashboards.
- If multiple unrelated containers are OOM-killed at the same time, the *host* itself is likely under memory pressure — that is a different problem and is currently NOT covered by an alert (no `node_exporter` in this slice; see README non-goals). Investigate via `docker stats` and host-side tooling.
