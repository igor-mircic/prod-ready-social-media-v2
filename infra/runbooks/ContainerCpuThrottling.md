# ContainerCpuThrottling

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- `sum by(name) (rate(container_cpu_cfs_throttled_periods_total{name!=""}[5m])) / sum by(name) (rate(container_cpu_cfs_periods_total{name!=""}[5m]))` has been above `0.25` for at least 10 minutes for one container.
- The firing container's `name` label is included in the alert summary.
- Grafana → Infrastructure overview → CPU throttling panel shows the same container's series climbing above the `0.25` line.

## Impact

- The container is hitting its declared `cpus:` CFS quota in `docker-compose.yml` and being descheduled for whole CFS periods. Wall-clock latency for any work the container performs is inflated — for `prometheus` that means delayed scrapes / rule evaluations, for `tempo` that means delayed span ingest, for `loki` that means delayed log ingest, etc.
- Files a ticket rather than paging: throttling is rarely user-impacting on its own (the *host* still has CPU available), but signals that the cap needs raising or the workload is spiking.

## Triage

- Read the firing container's `name` from the alert payload (webhook sink `/received` for local dev).
- Open Grafana → Infrastructure overview → "Per-container CPU usage" and "Per-container CPU throttling ratio". Confirm the throttling is sustained, not a single spike.
- Cross-reference with the affected service's own dashboards — is the throttling correlated with a known workload spike (e.g. a Prometheus rule re-evaluation, a heavy Grafana dashboard load, an e2e burst against the backend)?
- Inspect `docker stats <name>` directly for a live view of CPU% relative to the cap.

## Mitigation

- If the workload spike was legitimate and recurring, raise the container's `cpus:` value in `docker-compose.yml` and rerun `docker compose --profile observability up -d` so the change takes effect.
- If the throttling is from a regression (a previously cheap operation now expensive), file a follow-up on the offending service rather than papering over with a higher cap.
- If a single one-off spike (e.g. dashboard load during incident triage) is the cause, no action needed — the alert resolves on its own once throttling drops below 25%.

## Escalation

- File a ticket assigning the owner of the firing container's service (backend, observability, etc.) with the throttled container name and the relevant dashboard snapshot.
- Page only if throttling is observed simultaneously on multiple critical containers (`postgres`, `prometheus`) AND user-visible latency is climbing — that escalation pattern indicates the *host* itself is overcommitted, which is a different problem.
