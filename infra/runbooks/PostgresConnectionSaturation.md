# PostgresConnectionSaturation

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Active backends on the `social` database have exceeded 80% of `max_connections` for at least 5 minutes (see Grafana → Database overview → Connection count).
- The backend's HikariCP pool may be reporting `connectionsPending` > 0 on `backend-overview`.

## Impact

- The connection pool is approaching its hard cap. Once it saturates, the application starts failing to acquire connections — every endpoint that hits the database returns 500s.
- This alert pages because the next escalation step (pool exhaustion) is user-visible and Postgres recovers slowly from connection-storm scenarios.

## Triage

- Check `pg_stat_database_numbackends` on the Database overview dashboard against `pg_settings_max_connections`. Confirm the trend is sustained, not a single spike.
- Inspect `pg_stat_activity` for long-running queries or idle-in-transaction sessions:
  - `docker compose exec postgres psql -U social -d social -c "SELECT pid, state, wait_event, query_start, query FROM pg_stat_activity WHERE state != 'idle' ORDER BY query_start LIMIT 20;"`
- Cross-reference with the backend's HikariCP gauges (`backend-overview`) — if pool size matches active backends, the app is correctly using its budget; the cause is likely a leak or an unexpected traffic surge.

## Mitigation

- If long-running transactions are the cause, identify the offending session and either ask the owner to commit/rollback or `SELECT pg_terminate_backend(<pid>);` after confirming it is safe to kill.
- If a traffic surge is the cause, scale the backend or rate-limit the offending caller upstream.
- If the application is leaking connections, restart the backend to release them and file a follow-up bug.
- As a last resort raise `max_connections` in Postgres, but this is a tuning decision that needs DBA review — connection memory cost is non-trivial.

## Escalation

- Page the on-call backend engineer first; they own the application's connection budget.
- If the cause is inside Postgres (long-running maintenance, vacuum, replication-related), also page the on-call DBA.
