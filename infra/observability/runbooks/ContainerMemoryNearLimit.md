# ContainerMemoryNearLimit

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- `container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""}` has been above `0.9` for at least 5 minutes for one container.
- The firing container's `name` label is included in the alert summary.
- Grafana → Infrastructure overview → "Per-container memory working set vs. limit" panel shows the same container's bar gauge in the warning / red zone.

## Impact

- The container is within 10% of its declared `mem_limit` in `docker-compose.yml`. If the working set crosses the limit, the Linux OOM killer will terminate the container's main process (and on the next scrape `ContainerOomKilled` will page).
- Files a ticket rather than paging: this is a forward-looking signal that something must change before the OOM-kill happens. The container is still functioning.

## Triage

- Read the firing container's `name` from the alert payload (webhook sink `/received` for local dev).
- Open Grafana → Infrastructure overview → "Per-container memory working set vs. limit". Both the bar gauge and the companion time series with limit overlay are relevant. Compare against the working-set baseline over the last 1–6 hours: is this a slow leak (steady climb) or a step-change (workload spike)?
- Cross-reference with the affected service's own dashboards — for `postgres` check `Database overview` for an open-transaction spike; for `prometheus` check whether a new rule group or large remote-write is the cause; for `loki` / `tempo` check ingest rate.
- Inspect `docker stats <name>` directly for a live `MEM USAGE / LIMIT` ratio.

## Mitigation

- If the baseline has stepped up legitimately (e.g. a new dashboard, a new rule group, more spans being ingested), raise the container's `mem_limit:` value in `docker-compose.yml` and rerun `docker compose --profile observability up -d`.
- If the climb looks like a leak (working set rising continuously without a workload change), restart the container as an immediate mitigation (`docker compose --profile observability restart <name>`) and file a follow-up bug on the upstream image / our config that pinned the leak.
- If the climb is from a transient workload (e.g. a one-off backfill), no action needed once it subsides.

## Escalation

- File a ticket assigning the owner of the firing container's service with the dashboard snapshot and a recommendation (raise cap vs. investigate leak).
- Escalate to a page if `ContainerOomKilled` fires for the same container shortly afterwards.
