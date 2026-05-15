## 1. Postgres `pg_stat_statements` enablement

- [x] 1.1 Add `command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]` (or equivalent shell-form override) to the `postgres` service in `docker-compose.yml`. Confirm the override does not clobber other server defaults; re-running `docker compose up -d postgres` against a fresh volume should produce a healthy container that still listens on the configured port.
- [x] 1.2 Create `infra/observability/postgres/init/01-pg-stat-statements.sql` containing `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` (with a short comment header explaining the script's role and that it only runs on a fresh data directory).
- [x] 1.3 Add a read-only bind mount to the `postgres` service: `./infra/observability/postgres/init/01-pg-stat-statements.sql:/docker-entrypoint-initdb.d/01-pg-stat-statements.sql:ro`.
- [x] 1.4 Verify locally: `docker compose down -v && docker compose up -d postgres`, then `docker compose exec postgres psql -U <app-user> -d social -c "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'"` returns exactly one row.

## 2. `postgres-exporter` container and config

- [x] 2.1 Create `infra/observability/postgres-exporter/queries.yaml` declaring a custom-queries projection for `pg_stat_statements` that surfaces `calls`, `total_exec_time`, `mean_exec_time`, and `rows`. Truncate `query` text to 200 characters in SQL and `LIMIT 100` by `total_exec_time DESC`. Header-comment the file with the cardinality rationale.
- [x] 2.2 Add the `postgres-exporter` service to `docker-compose.yml` under the `observability` profile: pinned image `quay.io/prometheuscommunity/postgres-exporter:<tag>` (resolve exact tag at build time; do not use `latest`), container name `social-postgres-exporter`, `depends_on: [postgres]`, env vars for the data source pointing at the local `postgres` service, and an `--extend.query-path` (or `PG_EXPORTER_EXTEND_QUERY_PATH`) configuration loading the mounted `queries.yaml`.
- [x] 2.3 Bind-mount the queries file into the exporter container read-only at the path the exporter expects.
- [x] 2.4 Verify locally: `docker compose --profile observability up -d postgres-exporter`, then `curl -s http://localhost:9187/metrics | head -50` shows real Postgres metrics, and `curl -s http://localhost:9187/metrics | grep pg_stat_statements` produces at least one line.

## 3. Prometheus scrape job

- [x] 3.1 Add a new `postgres-exporter` scrape job to `infra/observability/prometheus/prometheus.yml`: target `postgres-exporter:9187`, `metrics_path: /metrics`, `scrape_interval: 15s`. Leave the existing `backend` and `collector` jobs untouched.
- [x] 3.2 Restart Prometheus (`docker compose --profile observability restart prometheus`) and verify on `http://localhost:9090/targets` that the new target shows `health: up`.

## 4. Grafana dashboard

- [x] 4.1 Create `infra/observability/grafana/dashboards/database-overview.json`. Match the formatting and structure of the existing `backend-overview.json` (panels, layout, datasource UIDs, timezone, refresh).
- [x] 4.2 Implement panels (in this order, top-to-bottom on the dashboard):
  - Connection count vs. `max_connections` (gauge + time series)
  - Transactions per second (commit and rollback, stacked)
  - Cache hit ratio (time series; 0.0–1.0)
  - Tuples affected (inserted/updated/deleted/fetched, stacked rate)
  - Deadlocks (rate over 5m)
  - Database size (single-stat, bytes)
  - Top-N slow queries from `pg_stat_statements` (table panel)
  - **(Stretch)** Locks by mode (only include if the default exporter output makes it cheap; skip otherwise) — skipped; default exporter labels for `pg_locks_count` need custom-queries plumbing, deferred.
- [x] 4.3 Restart Grafana (`docker compose --profile observability restart grafana`) and verify the dashboard appears in Dashboards → Browse and that every panel renders real data after a few minutes of traffic.

## 5. Database alert rules

- [x] 5.1 Create `infra/observability/prometheus/rules/database-alerts.yml` with the two alerts:
  - `PostgresConnectionSaturation`: `expr: pg_stat_database_numbackends{datname="social"} / on() pg_settings_max_connections > 0.8`, `for: 5m`, `labels: { severity: page }`, `annotations: { summary, description, runbook_url }`.
  - `PostgresDeadlocks`: `expr: increase(pg_stat_database_deadlocks{datname="social"}[5m]) > 0` (exporter v0.17.x omits the `_total` suffix), no `for:`, `labels: { severity: ticket }`, `annotations: { summary, description, runbook_url }`.
- [x] 5.2 Confirm Prometheus loads the new rule group on restart (`http://localhost:9090/rules`).

## 6. Runbook stubs

- [x] 6.1 Create `infra/observability/runbooks/PostgresConnectionSaturation.md` using the canonical Symptoms / Impact / Triage / Mitigation / Escalation section shape from slice 11.
- [x] 6.2 Create `infra/observability/runbooks/PostgresDeadlocks.md` in the same shape.
- [x] 6.3 Confirm both `runbook_url` annotations in `database-alerts.yml` point at the GitHub blob path matching these files (consistent with the slice-11 URL pattern).

## 7. `promtool` test fixture

- [x] 7.1 Create `infra/observability/prometheus/rules/database-tests.yml`. Feed synthetic `pg_stat_database_numbackends{datname="social"}` and `pg_settings_max_connections` series for the saturation test, and `pg_stat_database_deadlocks{datname="social"}` for the deadlock test.
- [x] 7.2 For each alert, declare at least one stanza that asserts firing with the expected labels and `runbook_url` annotation, and at least one stanza that asserts no firing under steady state.
- [x] 7.3 Run `promtool test rules infra/observability/prometheus/rules/*.yml` (via the pinned `prom/prometheus` image) locally and confirm all tests pass.

## 8. Backend integration test

- [x] 8.1 Add a new backend integration test under `backend/src/test/java/...` that uses testcontainers to bring up Postgres with `shared_preload_libraries=pg_stat_statements` and the init script applied.
- [x] 8.2 Bring up a sibling testcontainer running the same pinned `postgres-exporter` image, configured against the test Postgres with the same `queries.yaml` used in `docker-compose.yml`.
- [x] 8.3 Drive a handful of real DB operations through the existing JPA repositories or direct JDBC.
- [x] 8.4 HTTP-fetch the exporter's `/metrics` endpoint and assert the response body contains samples for `pg_stat_database_xact_commit{datname="..."}` (exporter v0.17.x omits `_total`), `pg_stat_database_numbackends`, and at least one `pg_stat_statements`-derived series whose name matches `queries.yaml`.
- [x] 8.5 Run the test locally and confirm it passes deterministically across at least three back-to-back runs.

## 9. README and docs

- [x] 9.1 Add a "Database internals" subsection to the README's `## Local observability` block. Cover:
  - The new `postgres-exporter` container, its host port (9187), and how to verify the scrape target's health on `http://localhost:9090/targets`.
  - The new `Database overview` Grafana dashboard and how to navigate to it.
  - The two new alerts (`PostgresConnectionSaturation`, `PostgresDeadlocks`) and the fact that they ride the existing severity routing to the slice-11 webhook sink.
  - The one-time `docker compose down -v` step (or the equivalent `CREATE EXTENSION` exec) required for `pg_stat_statements` to register against a pre-existing local data directory.
  - An explicit note that slow-query log shipping to Loki is deferred; `pg_stat_statements` covers the diagnostic surface for now.
- [x] 9.2 If the docker-compose top-of-file comment lists the containers under the `observability` profile, append `postgres-exporter` to that list.

## 10. Validate and ship

- [x] 10.1 Run `openspec validate add-db-observability --strict` and resolve any findings.
- [x] 10.2 Bring the full `observability` profile up locally, run the new backend integration test, run `promtool test rules` against the full rules directory, and confirm everything green.
- [ ] 10.3 Commit on a branch named `add-db-observability`, open the PR with the proposal/design/specs/tasks summary, and follow the autonomous-apply workflow through CI to archive.
