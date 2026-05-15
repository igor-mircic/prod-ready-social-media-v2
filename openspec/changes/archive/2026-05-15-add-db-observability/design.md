## Context

Eleven slices of the observability arc have built and closed a complete telemetry loop *around* the JVM and the browser. The application's view of Postgres is well-instrumented — Hikari pool metrics, JDBC trace spans, request-level latency that bottoms out in a database call — but Postgres itself is a black box. When a backend metric flares, an operator sees the symptom in the app but cannot answer the natural follow-up questions: are we close to `max_connections`? are we deadlocking? which statement is consuming the most time? what's the cache hit ratio doing?

The local stack already runs Postgres under the default compose profile; the `observability` profile already runs Prometheus, Grafana, Tempo, Loki, Alertmanager, and the slice-11 webhook sink. Adding a dedicated exporter for the database fits naturally inside that profile, behind the same gating: developers who don't care about observability never see it; developers running the profile pay a small marginal cost for a meaningful new view.

`pg_stat_statements` is a Postgres-shipped extension that records per-statement performance counters (calls, total time, mean time, rows, IO). It's the canonical answer to "which query is slow." Enabling it requires both a server-side library load (`shared_preload_libraries`) and a `CREATE EXTENSION` in the target database. The first is a compose-level change; the second is a one-shot init script. `postgres_exporter` can be told via a YAML file to project `pg_stat_statements` rows into Prometheus series alongside its built-in coverage of `pg_stat_database` and `pg_settings`.

This slice changes infrastructure and configuration only. Application code (backend / frontend) is unchanged. The only new test is a backend integration test proving the exporter pipeline in-process via testcontainers.

## Goals / Non-Goals

**Goals:**

- Stand up a `postgres_exporter` container under the `observability` profile, scraped by Prometheus alongside the existing backend and collector jobs.
- Enable `pg_stat_statements` on the local Postgres so per-statement metrics are real (not placeholder) signal.
- Provision a `database-overview` dashboard that lets an operator answer the connection / transaction / cache / deadlock / slow-query questions without writing PromQL.
- Add two database-tier alerts (connection saturation, deadlock rate) that ride the existing severity routing tree without changing Alertmanager config.
- Cover the new rules with `promtool test rules` fixtures matching the established pattern.
- Prove the exporter end-to-end with one backend integration test against a real testcontainers Postgres and the exporter image.

**Non-Goals:**

- Slow-query log shipping from Postgres → Collector → Loki. `pg_stat_statements` covers the diagnostic surface for now; pipe-shaping the Postgres CSV log into Loki is a follow-up slice with its own pipeline complexity.
- DB-level SLOs. The existing API availability and feed-read latency SLOs already reflect effective DB health from the user perspective. Adding a "connection pool < N% saturation" SLO would duplicate that signal without adding learning value.
- Replication-lag metrics. The local stack runs a single Postgres instance; lag is structurally zero. Multi-instance Postgres is its own arc.
- Production-grade tuning of `pg_stat_statements` (`max`, `track`, `track_utility`). Defaults are fine for a local dev stack.
- Surfacing the new dashboard panels on `backend-overview`. Database internals get their own dashboard sibling; cross-linking via Grafana navigation is the existing pattern.

## Decisions

### Decision 1 — `prometheus-community/postgres-exporter`, not `pgwatch2` or `prometheus_postgres_adapter`

The mainstream choice. Maintained by the Prometheus community, packaged as `quay.io/prometheuscommunity/postgres-exporter`, pinned by tag. Custom-queries are loaded from a YAML file via `--extend.query-path` (or `PG_EXPORTER_EXTEND_QUERY_PATH`). Coverage of `pg_stat_database`, `pg_stat_replication`, `pg_settings`, `pg_locks`, etc. is built-in; `pg_stat_statements` projection lives in our custom-queries YAML so we control fingerprint truncation and the set of columns surfaced.

Rejected: `pgwatch2` (heavy — brings its own dashboards, storage, and a Grafana plugin; more than we need); `prometheus_postgres_adapter` (write-path adapter for storing Prometheus in Postgres, not what we want); building our own exporter (defeats the slice).

### Decision 2 — `pg_stat_statements` in the same slice, behind a compose flag + init script

Without `pg_stat_statements` the slice is plumbing: connection counts and deadlocks are useful but don't unlock "which query is slow," which is the highest-leverage question DB observability answers. Including it doubles the surface (Postgres config change + init script + custom-queries YAML) but makes the slice deliver real diagnostic capability.

The mechanism:

- `docker-compose.yml` adds `command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]` to the `postgres` service. The library is bundled with the official `postgres:16-alpine` image — no image change needed.
- An init script mounted at `/docker-entrypoint-initdb.d/01-pg-stat-statements.sql` runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` on first boot.
- The custom-queries YAML for the exporter projects a curated set of `pg_stat_statements` columns into Prometheus: `queryid`, `calls`, `total_exec_time`, `mean_exec_time`, `rows`, plus a truncated `query` label. Fingerprint truncation (e.g. 200 chars) keeps label cardinality bounded.

The trapdoor: init scripts only execute against an **empty** data directory. Existing local `postgres-data` volumes will not pick up the extension creation; developers must `docker compose down -v && docker compose up -d postgres` once to recreate the volume. Documented in the README run-loop section and noted as a one-time migration cost.

Rejected: Flyway migration for `CREATE EXTENSION` (Flyway runs as the application user, which typically lacks privilege to create extensions — would force grant changes); a separate "pgst-enable" container in compose (more moving parts for one DDL statement); deferring `pg_stat_statements` to a follow-up slice (leaves the slice without its leverage payoff).

### Decision 3 — New `database-overview` dashboard, sibling of `backend-overview` and `frontend-overview`

The repo's convention is one dashboard per concern: backend internals on `backend-overview`, browser-side telemetry on `frontend-overview`. A third sibling `database-overview` keeps each dashboard focused and the navigation consistent. Adding a "Database" row to `backend-overview` was considered and rejected because (a) `backend-overview` already has a HikariCP-shaped DB row reflecting the *application's* view, and conflating that with engine internals muddles the mental model; (b) the slow-query table would dominate a row by sheer size.

The provisioning side needs no YAML change: `infra/observability/grafana/provisioning/dashboards/dashboards.yaml` already picks up every JSON file in the dashboards directory via glob.

Panels in the new dashboard:

- **Connection count vs. max_connections** — `pg_stat_database_numbackends{datname="social"}` over `pg_settings_max_connections`, both as a gauge (current ratio) and a time series. Gives the connection-saturation alert a visible context.
- **Transactions per second** — `rate(pg_stat_database_xact_commit_total{datname="social"}[1m])` and the rollback counterpart, stacked.
- **Cache hit ratio** — `pg_stat_database_blks_hit_total / (pg_stat_database_blks_hit_total + pg_stat_database_blks_read_total)`, time series. Healthy is "near 1.0"; a sustained dip signals working-set growth.
- **Tuples affected** — `rate(pg_stat_database_tup_{inserted,updated,deleted,fetched}_total[1m])`, stacked.
- **Deadlocks** — `rate(pg_stat_database_deadlocks_total{datname="social"}[5m])`. Same series the alert fires on, so an operator pivoting from page to dashboard sees the alert's underlying signal.
- **Database size** — `pg_database_size_bytes{datname="social"}`, single-stat. Slow-moving, mostly for ambient context.
- **Top N slow queries** — table panel sourced from `pg_stat_statements_*` series projected by the custom-queries file. Columns: query (truncated fingerprint), calls, mean exec time, total time. Top 20 by total time over the dashboard time range.
- **Locks by mode** (optional, marked as a stretch panel) — `pg_locks_count` faceted by `mode`. Useful when investigating contention; can be left for a follow-up if `postgres_exporter` doesn't surface it cleanly with default config.

### Decision 4 — Two alerts: connection saturation, deadlocks. Both reuse the slice-11 severity routing tree.

Slice 11 established `severity ∈ {page, ticket}` as the routing label. The two new alerts pick deliberately different severities:

- **`PostgresConnectionSaturation`** (`severity: page`) — `pg_stat_database_numbackends{datname="social"} / on() pg_settings_max_connections > 0.8` for 5 minutes. Triggers before the app starts failing to acquire connections; pages because an operator has to respond before user-visible impact lands.
- **`PostgresDeadlocks`** (`severity: ticket`) — `increase(pg_stat_database_deadlocks_total{datname="social"}[5m]) > 0` (no `for:` clause; a single deadlock is enough to file a ticket). Tickets, not pages: deadlocks are usually self-resolving but indicate a query-pattern bug worth investigating.

Both carry the `runbook_url` annotation contract established in slice 11, pointing at new stubs in `infra/observability/runbooks/`. No Alertmanager YAML change is needed — the existing routing tree handles both severities; the existing `BackendDown` inhibition target rule (`slo=~".+"`) does *not* match these (they have no `slo` label), so they fire even when the backend is down. That's correct: a backend-down event might mask connection saturation, but the connection-saturation alert is a useful independent signal for "Postgres itself is wedged."

Rejected: a `slo:database_*` label so the inhibition picked them up (would lie about which user-visible SLO they protect — they don't protect one directly); routing the deadlock alert to `page` (over-rotates on a usually-transient symptom); adding a long-running-transaction alert (good idea, deferred — needs `pg_stat_activity` shape work and is investigation-grade rather than page-grade).

### Decision 5 — Backend integration test, not a Playwright e2e

The existing slice patterns split end-to-end proof between (a) Playwright specs that exercise UI → backend → telemetry surface and (b) in-process backend tests that exercise the telemetry pipeline directly. This slice has no UI surface and no frontend involvement, so the proof belongs on the backend side as an integration test using testcontainers:

- Spin up Postgres with `shared_preload_libraries=pg_stat_statements` and the init script applied (the existing testcontainers `Postgres` setup with two new properties).
- Spin up `postgres_exporter` as a sibling testcontainer pointed at the test Postgres.
- Drive some real traffic against the test Postgres (e.g. through the existing JPA repositories — a few `findAll` and inserts).
- HTTP-fetch the exporter's `/metrics` endpoint and assert presence of `pg_stat_database_xact_commit_total{datname="..."}`, `pg_stat_statements_calls_total`, and the connection-saturation numerator.

The test does not need Prometheus or Grafana in the loop — it proves the exporter surface and the `pg_stat_statements` enablement. The dashboard panels are visual artefacts and are not asserted (consistent with how prior slices treat dashboards).

Rejected: a Playwright spec that runs the full `observability` profile and queries Prometheus (slow, flaky, redundant with the integration test); asserting via `docker compose exec postgres psql` (proves the SQL works but not the exporter); skipping the proof (breaks the slice pattern — every prior slice has an end-to-end test).

### Decision 6 — `promtool` fixtures, separate file

Database alerts get their own `database-tests.yml` rather than appending to `slo-tests.yml`. The existing test files are SLO-scoped; mixing infra alerts in would conflate concerns. Pattern matches the rule-files split (`slo-alerting.yml`, `fe-slo-alerting.yml`, new `database-alerts.yml`).

Each alert gets at least two test groups: one where the condition is false (no alert), one where it's true (alert fires with the expected labels and `runbook_url`).

## Risks / Trade-offs

- **`pg_stat_statements` requires recreating local Postgres volumes.** Developers who already have a local `postgres-data` volume must `docker compose down -v` once. → README run-loop section calls this out explicitly; the cost is bounded (one-time, no data loss for a dev DB).

- **Custom-queries YAML is a footgun for cardinality.** Projecting the `query` text into a Prometheus label can produce thousands of unique series. → Fingerprint truncation at 200 chars and bounding the surfaced queries (top N by total time) keeps the label set small. The custom-queries YAML is hand-maintained and reviewed in this slice; future additions are spec'd to call out the cardinality cost.

- **`pg_stat_statements` defaults track 5000 statements.** A pathological workload could overflow that and rotate out useful entries. → Acceptable for the local stack; if it bites, a future slice raises `pg_stat_statements.max` via the Postgres command line.

- **`postgres_exporter` runs as a separate container with DB credentials.** A small additional secret surface. → The exporter authenticates via a `DATA_SOURCE_URI` env (or split user/password env vars). In dev we reuse the existing `postgres` superuser credentials from the compose file. For production this would split into a dedicated read-only monitoring role with `pg_monitor` grants; documented in the dashboard's notes panel.

- **No alert when the exporter itself dies.** Same gap the `BackendDown` alert exists to close on the application side. → A future slice could add `up{job="postgres-exporter"} == 0` as a meta-alert; explicitly out of scope here to keep the slice tight.

- **The new dashboard widens the surface a developer can break by clicking around in Grafana.** Same risk as every other provisioned dashboard. → `editable: false` already applies at the datasource level (slices 1, 5, 7); the new dashboard JSON inherits that posture. Mistakes do not persist.

## Migration Plan

This is an additive change to a local-dev observability stack; there is no production deploy.

- **Local apply (fresh volume):** pull the branch, `docker compose down -v` (one-time, to recreate the Postgres data directory), then `docker compose --profile observability up -d`. The init script runs on first boot, the extension is created, the exporter starts scraping, Prometheus picks up the new job, Grafana auto-loads the new dashboard.
- **Local apply (existing volume):** the data already exists, so the init script is skipped, and `pg_stat_statements` is not registered. Two paths: (a) `docker compose down -v` and accept the data loss (dev only), or (b) `docker compose exec postgres psql -U <user> -d social -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'` — works because the library is already loaded via `shared_preload_libraries`. README documents both.
- **CI gate:** `promtool test rules` continues to run; the new fixture file is picked up by the existing glob. The backend integration test runs as part of the existing backend test suite; it brings its own testcontainers, so no CI infra change is needed.
- **Rollback:** `git revert` the merge. The `observability` profile gracefully degrades — Prometheus logs scrape failures for the missing target, Grafana shows "No data" on the database dashboard. No other component is affected.

## Open Questions

- **`pg_stat_statements` `track` setting.** Defaults to `top` (track top-level statements only) which is fine for diagnosis. `all` would track nested statements (e.g. inside functions) at higher overhead. Lean: stay on default `top` for this slice; revisit if function-heavy code paths land.
- **Exporter image tag.** `quay.io/prometheuscommunity/postgres-exporter:v0.17.x` (current latest as of the slice). Decide the exact patch at implementation; pin by tag, not digest, matching the existing convention for Prometheus / Grafana / Alertmanager images.
- **Monitoring-role credentials.** For dev, reuse the existing postgres superuser. For docs, the design says "production would use a `pg_monitor` role." Should this slice also commit a `pg_monitor` role creation in the init script (unused locally but documented), or punt entirely to a deploy-time concern? Lean: punt — adding role plumbing locally for no local benefit invites cargo-culting. Note the role split in the dashboard's notes panel only.
- **Locks-by-mode panel.** Listed as optional in Decision 3. If `postgres_exporter` default output makes it cheap, include; if it needs custom-queries plumbing, defer. Decide while building the dashboard.
