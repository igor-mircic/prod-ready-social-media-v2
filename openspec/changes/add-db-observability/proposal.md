## Why

The observability arc has covered every layer that lives *inside* the JVM and the browser — Hikari pool gauges, JDBC trace spans, request RED, FE RUM — but nothing about Postgres itself. When an incident traces back to "the database," operators see app-side symptoms (pool pending, request latency rising) without a view into the engine: connection pressure against `max_connections`, deadlocks, cache hit ratio, or which statements are burning time. This slice plugs that gap before any of the missing pieces (sampling strategy, profiling, deploy) make further obs work bigger.

## What Changes

- New `postgres-exporter` service under the `observability` docker-compose profile — pinned `quay.io/prometheuscommunity/postgres-exporter` image at `infra/observability/postgres-exporter/`, scraped by Prometheus as a new `postgres-exporter` job. Configured with a custom-queries file so per-statement metrics from `pg_stat_statements` are emitted alongside the default `pg_stat_database` / `pg_settings` series.
- Postgres container reconfigured to load the `pg_stat_statements` shared library and create the extension on first boot: `command:` flag sets `shared_preload_libraries=pg_stat_statements`, and a new `infra/observability/postgres/init/01-pg-stat-statements.sql` script runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` via `/docker-entrypoint-initdb.d/`. Existing local volumes will need to be recreated for the extension to register; called out in the README.
- New `infra/observability/grafana/dashboards/database-overview.json` (sibling of `backend-overview` and `frontend-overview`) — connection count vs. `max_connections`, transactions/sec (commit + rollback), cache hit ratio, tuples affected, deadlock rate, database size, top-N slow queries from `pg_stat_statements`. Picked up automatically by existing dashboards provisioner (no provisioning YAML change).
- New `infra/observability/prometheus/rules/database-alerts.yml`, loaded by the existing rule-files glob — two backend-tier infra alerts:
  - `PostgresConnectionSaturation` — `pg_stat_database_numbackends{datname="social"} / on() pg_settings_max_connections > 0.8` for 5m, severity `page`.
  - `PostgresDeadlocks` — `increase(pg_stat_database_deadlocks{datname="social"}[5m]) > 0` (the v0.17.x exporter emits the counter without a `_total` suffix), severity `ticket`.
  Both carry `runbook_url` annotations pointing at new stubs under `infra/observability/runbooks/`. Routing uses the existing severity tree from slice 11; no Alertmanager change needed.
- New runbook stubs: `infra/observability/runbooks/PostgresConnectionSaturation.md`, `infra/observability/runbooks/PostgresDeadlocks.md` — follow the existing Symptoms / Impact / Triage / Mitigation / Escalation shape.
- Update `promtool` test rules with a new `infra/observability/prometheus/rules/database-tests.yml` exercising both new alerts against synthetic series and asserting their `runbook_url` annotations.
- Integration test in the backend proves the exporter surface end-to-end in-process: bootstraps the testcontainers Postgres with the extension preloaded, drives some traffic, asserts that `postgres-exporter`'s `/metrics` (run as a sibling container) emits both `pg_stat_database_xact_commit{datname="..."}` and `pg_stat_statements_*` series.
- README updates: the local observability run loop section gains a "Database internals" subsection (what the exporter shows, how to view the dashboard, the volume-rebuild note for first-time enablement of `pg_stat_statements`).

Explicit non-goals (called out so reviewers know the boundary):

- Slow-query log shipping from Postgres → Collector → Loki is deferred to a follow-up slice. `pg_stat_statements` covers the "which statement is slow" question for now.
- DB-level SLOs are not added — the existing API-availability and feed-read SLOs already cover effective DB health from a user perspective.
- Replication-lag metrics are not added — the local stack runs a single Postgres instance.

## Capabilities

### New Capabilities

(None — this slice extends the existing `observability` capability.)

### Modified Capabilities

- `observability`: gains requirements for the postgres-exporter container, the Postgres `pg_stat_statements` enablement (config flag + init script), the postgres-exporter Prometheus scrape job, the `database-overview` provisioned dashboard, the two database-tier alerting rules with `runbook_url` annotations, the runbook stubs, the `promtool` assertions for the new rules, the in-process integration proof, and the README run-loop documentation.

## Impact

- **Affected files / directories:**
  - `docker-compose.yml` — new `postgres-exporter` service under the `observability` profile; existing `postgres` service gains a `command:` override and an init-script mount.
  - `infra/observability/postgres-exporter/` (new) — exporter config including the custom `queries.yaml` for `pg_stat_statements`.
  - `infra/observability/postgres/init/01-pg-stat-statements.sql` (new) — one-shot extension creation.
  - `infra/observability/prometheus/prometheus.yml` — new `postgres-exporter` scrape job.
  - `infra/observability/prometheus/rules/database-alerts.yml` (new), `database-tests.yml` (new).
  - `infra/observability/grafana/dashboards/database-overview.json` (new).
  - `infra/observability/runbooks/PostgresConnectionSaturation.md`, `PostgresDeadlocks.md` (new).
  - Backend integration test under `backend/src/test/java/...` (new) proving the exporter pipeline.
  - Top-level `README.md` — Database internals subsection added to the observability run loop.
- **Dependencies:** new pinned `postgres-exporter` container image. No application-code dependencies change on the backend or frontend. Postgres image (`postgres:16-alpine`) is unchanged.
- **Compatibility:** no breaking changes to running applications. Local developers with an existing `postgres-data` volume must recreate it once for `pg_stat_statements` to register (documented in README). The default (non-observability) profile is unaffected — the new exporter only runs when the `observability` profile is enabled.
- **CI:** the new e2e proof runs only when the observability profile is up; CI does not currently run that profile, so no new CI gates land. The new `promtool` test fixture runs inside the existing `promtool test rules` step.
