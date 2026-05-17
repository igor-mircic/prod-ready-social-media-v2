# PostgresDeadlocks

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- `pg_stat_database_deadlocks{datname="social"}` increased by at least 1 in the last 5 minutes.
- Postgres logs contain a `deadlock detected` ERROR line with the two competing transactions and the relations involved.
- Application logs may show `SQLException`s referencing `deadlock detected` propagating from a JPA / JDBC call site.

## Impact

- One of the two competing transactions is aborted by Postgres's deadlock-resolution. That transaction's request fails (5xx from the API or visible retry path in the caller).
- Deadlocks are usually self-resolving — Postgres breaks the cycle automatically — so the alert files a ticket rather than paging. Sustained deadlocks indicate a query-pattern or locking-order bug that will keep recurring.

## Triage

- Read the Postgres log (`docker compose logs postgres | grep -i deadlock`) to identify the two competing statements and the relations involved.
- Inspect the relevant code paths: are two write paths touching the same rows in opposite order? Are foreign-key constraints causing an unexpected lock-acquisition order?
- Check `pg_stat_database_deadlocks` over a longer window in Grafana → Database overview to distinguish a one-off from a sustained pattern.

## Mitigation

- For an isolated deadlock: confirm the originating request retried or the user was informed. No immediate action needed.
- For a repeating pattern: open a follow-up to fix the underlying lock-ordering bug (re-order writes, take an advisory lock, or use `SELECT ... FOR UPDATE` consistently across competing paths). Until the fix lands, instrument the failing path with bounded retries on `SQLException` whose SQLSTATE matches `40P01` (`deadlock_detected`).

## Escalation

- File a ticket assigning the on-call backend engineer with the offending statement pair from the Postgres log and the affected code paths.
- Page only if deadlocks recur at high rate (multiple per minute sustained) AND the application's retry path is failing visibly to users — that escalation pattern means the routing label needs reconsideration.
