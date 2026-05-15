## ADDED Requirements

### Requirement: Postgres loads the `pg_stat_statements` shared library at startup

The `postgres` service in `docker-compose.yml` SHALL be configured so the running Postgres process loads the `pg_stat_statements` extension library at startup. The mechanism SHALL be a `command:` override on the service that sets `shared_preload_libraries=pg_stat_statements` (other server defaults preserved). The `postgres:16-alpine` image already ships the library, so no image change is required.

#### Scenario: docker-compose declares the shared_preload_libraries override
- **WHEN** a reader inspects the `postgres` service definition in `docker-compose.yml`
- **THEN** the service declares a `command:` (or equivalent) that runs `postgres` with `-c shared_preload_libraries=pg_stat_statements`
- **AND** the override is present unconditionally (not gated by the `observability` profile — the library is cheap to load and the extension is only exercised when the exporter scrapes it)

#### Scenario: Running container exposes the extension as installed
- **WHEN** an operator runs `docker compose exec postgres psql -U <app-user> -d social -c "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'"` against a fresh data directory
- **THEN** the query returns exactly one row whose `extname` is `pg_stat_statements`

### Requirement: A first-boot init script creates the `pg_stat_statements` extension

The repository SHALL provide a SQL init script at `infra/observability/postgres/init/01-pg-stat-statements.sql` that runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`. The script SHALL be mounted into the postgres container at `/docker-entrypoint-initdb.d/01-pg-stat-statements.sql` (read-only) so the official `postgres` image executes it on first boot against an empty data directory.

#### Scenario: Init script file exists in the repository
- **WHEN** a reader inspects `infra/observability/postgres/init/`
- **THEN** it contains a file named `01-pg-stat-statements.sql`
- **AND** the file's contents include exactly the SQL statement `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` (whitespace and comments allowed)

#### Scenario: docker-compose mounts the init script into the postgres container
- **WHEN** a reader inspects the `postgres` service's `volumes:` block in `docker-compose.yml`
- **THEN** there is a bind mount of `./infra/observability/postgres/init/01-pg-stat-statements.sql` to `/docker-entrypoint-initdb.d/01-pg-stat-statements.sql`
- **AND** the mount is read-only (`:ro`)

#### Scenario: Init script runs on first boot against an empty data directory
- **WHEN** an operator runs `docker compose down -v && docker compose up -d postgres`
- **THEN** the official Postgres entrypoint executes the mounted init script during initialisation
- **AND** subsequent queries against the `social` database can see the `pg_stat_statements_*` system views without further action

### Requirement: `postgres-exporter` is provisioned under the `observability` docker-compose profile

A single `postgres-exporter` service runs under the `observability` profile, exposing Prometheus-format metrics about the running Postgres instance on port `9187`. The container image SHALL be `quay.io/prometheuscommunity/postgres-exporter` pinned to an explicit tag (not `latest`). The exporter SHALL authenticate to Postgres using the same credentials the application uses in dev (a future production deploy would split this to a `pg_monitor`-granted role).

#### Scenario: Observability profile starts the postgres-exporter container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-postgres-exporter` container is started in addition to the other observability containers
- **AND** the container's `/metrics` endpoint is reachable from the prometheus container at `http://postgres-exporter:9187/metrics`

#### Scenario: Default invocation does not start postgres-exporter
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-postgres-exporter` container is NOT started

#### Scenario: postgres-exporter image is pinned by tag
- **WHEN** the docker-compose `postgres-exporter` service definition is read
- **THEN** the `image:` field is `quay.io/prometheuscommunity/postgres-exporter:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: postgres-exporter is configured to connect to the local postgres
- **WHEN** the docker-compose `postgres-exporter` service definition is read
- **THEN** it declares a `DATA_SOURCE_URI` (or equivalent split env vars `DATA_SOURCE_USER` / `DATA_SOURCE_PASS` / `DATA_SOURCE_NAME`) that targets the local `postgres` service on the shared docker network
- **AND** the service declares `depends_on: [postgres]` so the exporter does not start before Postgres is ready

### Requirement: `postgres-exporter` projects `pg_stat_statements` via a custom-queries file

The repository SHALL include `infra/observability/postgres-exporter/queries.yaml` declaring custom-query projections that surface a curated subset of `pg_stat_statements` columns as Prometheus metrics. The file SHALL be mounted into the postgres-exporter container and referenced via the `--extend.query-path` flag (or `PG_EXPORTER_EXTEND_QUERY_PATH` env var). The set of columns surfaced SHALL be bounded to keep Prometheus label cardinality manageable.

#### Scenario: Custom-queries file exists and declares pg_stat_statements projection
- **WHEN** a reader inspects `infra/observability/postgres-exporter/queries.yaml`
- **THEN** the file declares a metric set named `pg_stat_statements` (or equivalent identifier) that projects per-statement counters
- **AND** the projected metrics include `calls`, `total_exec_time`, `mean_exec_time`, and `rows`
- **AND** the SQL underlying the projection truncates the `query` text to at most 200 characters (to bound label cardinality)
- **AND** the SQL limits the row set surfaced to at most the top 100 statements by `total_exec_time` (to bound emitted-series count)

#### Scenario: docker-compose mounts the custom-queries file and configures the exporter to load it
- **WHEN** a reader inspects the `postgres-exporter` service in `docker-compose.yml`
- **THEN** the service mounts `./infra/observability/postgres-exporter/queries.yaml` into the container (path consistent with the exporter's expectations) read-only
- **AND** the service is configured (via flag or env var) to load that file as its extend-query path

### Requirement: Prometheus scrapes `postgres-exporter` as a new job

The Prometheus configuration at `infra/observability/prometheus/prometheus.yml` SHALL include a scrape job for the postgres-exporter container. The job SHALL be additive to the existing scrape jobs (the existing `backend` and `collector` jobs are unchanged in name, target, and interval).

#### Scenario: Prometheus config declares the postgres-exporter scrape job
- **WHEN** a reader inspects `infra/observability/prometheus/prometheus.yml`
- **THEN** `scrape_configs:` contains an entry with `job_name: postgres-exporter`
- **AND** the entry targets `postgres-exporter:9187`
- **AND** the entry's `scrape_interval` is `15s` (matching the existing `backend` job)
- **AND** the entry's `metrics_path` is `/metrics` (the exporter's default)

#### Scenario: Prometheus scrapes the exporter when the observability profile is up
- **WHEN** the `observability` profile is running and a reader queries `http://localhost:9090/api/v1/targets`
- **THEN** the `postgres-exporter` target appears with `health: "up"` after one scrape interval

### Requirement: Grafana provisions a `Database overview` dashboard

The repository SHALL include `infra/observability/grafana/dashboards/database-overview.json` declaring a Grafana dashboard that visualises Postgres internals. The dashboard SHALL be picked up automatically by the existing dashboards-provisioning glob (no provisioning YAML change required). Panels SHALL be sourced from `postgres-exporter` metrics; no panel SHALL require ad-hoc PromQL knowledge from the operator to read.

#### Scenario: Dashboard JSON file exists alongside the existing siblings
- **WHEN** a reader inspects `infra/observability/grafana/dashboards/`
- **THEN** it contains `database-overview.json` alongside `backend-overview.json` and `frontend-overview.json`

#### Scenario: Dashboard contains the core panel set
- **WHEN** Grafana loads the dashboard
- **THEN** the dashboard contains at least one panel each for: connection count vs. `max_connections`, transactions per second (commit and rollback), cache hit ratio, tuples affected (insert/update/delete/fetch), deadlock rate, database size, and a top-N table of slow queries from `pg_stat_statements`

#### Scenario: Slow-query table draws from pg_stat_statements custom-queries series
- **WHEN** a reader inspects the slow-query table panel
- **THEN** the panel's PromQL queries reference series projected from `pg_stat_statements` (e.g. `pg_stat_statements_calls_total`, `pg_stat_statements_total_exec_time_seconds_total`, or equivalent names emitted by the custom-queries file)
- **AND** the table is ordered by total execution time across the dashboard time range, descending

### Requirement: Database alert rules live in `infra/observability/prometheus/rules/database-alerts.yml`

The repository SHALL include a Prometheus rules file at `infra/observability/prometheus/rules/database-alerts.yml` declaring database-tier infra alerts. The file SHALL be loaded by Prometheus via the existing `rule_files:` glob in `prometheus.yml` (no glob change required).

#### Scenario: Rules file exists in the expected directory
- **WHEN** a reader inspects `infra/observability/prometheus/rules/`
- **THEN** it contains `database-alerts.yml` alongside the existing SLO rule files

#### Scenario: Prometheus loads the rules at startup
- **WHEN** Prometheus starts with the observability profile up
- **THEN** `http://localhost:9090/api/v1/rules` reports the `database-alerts` rule group with at least the alerts named in this spec

### Requirement: A `PostgresConnectionSaturation` alert covers connection pressure

The repository's `database-alerts.yml` SHALL declare an alerting rule named `PostgresConnectionSaturation` that fires when the running Postgres approaches its connection limit. The alert SHALL carry severity `page` (so it routes via the existing severity tree from slice 11 to the page-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/PostgresConnectionSaturation.md`.

#### Scenario: Alert is declared with the saturation expression
- **WHEN** a reader inspects `database-alerts.yml`
- **THEN** the file declares an alert named `PostgresConnectionSaturation`
- **AND** the alert's `expr` measures the ratio `pg_stat_database_numbackends{datname="social"} / on() pg_settings_max_connections` exceeding `0.8`
- **AND** the alert's `for:` clause is `5m`

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `PostgresConnectionSaturation` alert
- **THEN** the alert's `labels:` block contains `severity: page`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/PostgresConnectionSaturation.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description`

### Requirement: A `PostgresDeadlocks` alert covers deadlock occurrences

The repository's `database-alerts.yml` SHALL declare an alerting rule named `PostgresDeadlocks` that fires when one or more deadlocks are recorded by Postgres in the recent 5-minute window. The alert SHALL carry severity `ticket` (routing to the ticket-webhook receiver) and SHALL carry a `runbook_url` annotation pointing at `infra/observability/runbooks/PostgresDeadlocks.md`.

#### Scenario: Alert is declared with the deadlock-rate expression
- **WHEN** a reader inspects `database-alerts.yml`
- **THEN** the file declares an alert named `PostgresDeadlocks`
- **AND** the alert's `expr` is `increase(pg_stat_database_deadlocks_total{datname="social"}[5m]) > 0` (or equivalent series name if the exporter emits a different metric name; the test fixture below pins the exact name)
- **AND** the alert has no `for:` clause (single occurrence is sufficient to file a ticket)

#### Scenario: Alert carries the routing and runbook annotations
- **WHEN** a reader inspects the `PostgresDeadlocks` alert
- **THEN** the alert's `labels:` block contains `severity: ticket`
- **AND** the alert's `annotations:` block contains a `runbook_url` value matching the GitHub blob URL pattern used by other alerts and pointing at `infra/observability/runbooks/PostgresDeadlocks.md`
- **AND** the alert's `annotations:` block contains a non-empty `summary` and `description`

### Requirement: Runbook stubs exist for the two database alerts

The repository SHALL include Markdown runbook stubs at `infra/observability/runbooks/PostgresConnectionSaturation.md` and `infra/observability/runbooks/PostgresDeadlocks.md`, matching the shape of the slice-11 stubs (Symptoms / Impact / Triage / Mitigation / Escalation).

#### Scenario: Stubs exist with the canonical section shape
- **WHEN** a reader inspects `infra/observability/runbooks/`
- **THEN** the directory contains `PostgresConnectionSaturation.md` and `PostgresDeadlocks.md`
- **AND** each file contains the section headings `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in any reasonable order and heading level)

### Requirement: `promtool test rules` covers the database alerts

The repository SHALL include `infra/observability/prometheus/rules/database-tests.yml` exercising both database alerts against synthetic series. The fixture SHALL be discovered by the existing `promtool test rules` invocation that already covers the SLO rule tests. The fixture SHALL assert both the firing condition and the presence of the `runbook_url` annotation.

#### Scenario: Test fixture lives next to the rule file
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `database-tests.yml` alongside `database-alerts.yml`

#### Scenario: Each database alert has at least one fires-as-expected test case
- **WHEN** the fixture is read
- **THEN** `PostgresConnectionSaturation` has a stanza feeding synthetic `pg_stat_database_numbackends` and `pg_settings_max_connections` series that drive the ratio above 0.8 for at least 5 minutes, and asserts the alert is in `firing` state at that simulated time with `severity: page` and a non-empty `runbook_url` annotation
- **AND** `PostgresDeadlocks` has a stanza feeding a synthetic `pg_stat_database_deadlocks_total` series that increases by at least 1 within a 5-minute window, and asserts the alert is in `firing` state with `severity: ticket` and a non-empty `runbook_url` annotation

#### Scenario: Each database alert has at least one steady-state-no-fire test case
- **WHEN** the fixture is read
- **THEN** `PostgresConnectionSaturation` has a stanza where the ratio stays below 0.8 and the alert is NOT in `firing` state
- **AND** `PostgresDeadlocks` has a stanza where the deadlock counter is flat and the alert is NOT in `firing` state

### Requirement: Backend integration test proves the exporter pipeline end-to-end

A backend integration test SHALL prove the `postgres-exporter` → metrics surface end-to-end against a real Postgres. The test SHALL use testcontainers to bring up Postgres with `shared_preload_libraries=pg_stat_statements` and the init script applied, plus a sibling postgres-exporter container pointed at it, drive real DB traffic, then HTTP-fetch the exporter's `/metrics` endpoint and assert presence of the key series.

#### Scenario: Test brings up postgres with pg_stat_statements preloaded
- **WHEN** the integration test starts the testcontainers Postgres
- **THEN** the container is started with `shared_preload_libraries=pg_stat_statements` set
- **AND** the `pg_stat_statements` extension is registered in the test database after startup

#### Scenario: Test brings up a sibling postgres-exporter container
- **WHEN** the integration test starts the postgres-exporter container
- **THEN** the container uses the same pinned image tag as `docker-compose.yml`
- **AND** the container is configured with the same `queries.yaml` file used in the compose configuration
- **AND** the container's `/metrics` endpoint is reachable from the test JVM

#### Scenario: Test asserts the exporter emits the key series after real traffic
- **WHEN** the test drives a handful of read and write queries against the test Postgres and then fetches `http://<exporter>:9187/metrics`
- **THEN** the response body contains at least one sample of `pg_stat_database_xact_commit_total{datname="..."}`
- **AND** the response body contains at least one sample of a `pg_stat_database_numbackends` series
- **AND** the response body contains at least one sample of a series projected from `pg_stat_statements` by the custom-queries file (e.g. `pg_stat_statements_calls_total` or the equivalent name declared in `queries.yaml`)

### Requirement: README documents the local database-observability run loop

The repository README's observability section SHALL gain a "Database internals" subsection that names the new exporter, the new dashboard, the alert pair, and the one-time volume-rebuild step required for `pg_stat_statements` to register on existing local installations.

#### Scenario: README documents the database-observability run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9090/api/v1/targets` as the place to verify the `postgres-exporter` scrape target is healthy
- **AND** the README names the `Database overview` dashboard and how to navigate to it from Grafana
- **AND** the README documents the two new alerts (`PostgresConnectionSaturation`, `PostgresDeadlocks`) and notes that they ride the existing severity routing to the webhook sink
- **AND** the README calls out the one-time `docker compose down -v` step (or the equivalent `CREATE EXTENSION` exec) required for `pg_stat_statements` to register on a pre-existing local data directory
- **AND** the README explicitly notes that slow-query log shipping to Loki is deferred and that `pg_stat_statements` covers the "which query is slow" question for now
