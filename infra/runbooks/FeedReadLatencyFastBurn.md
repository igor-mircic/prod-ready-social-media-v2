# FeedReadLatencyFastBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of feed reads slower than 200ms exceeds `14.4 × (1 - 0.95) = 0.72` on both the 1h and 5m windows.
- Latency panels for `feed.read.duration` show p95 well above 200ms.

## Impact

- Most users see a visibly slow feed; the 30d feed-read latency budget burns at ~14× the SLO-allowed rate.
- Sustained at this pace, the entire 30d budget is exhausted in ~2 days.

## Triage

- Use the metric → trace exemplar pivot from the feed-latency Grafana panel to a slow Tempo trace.
- Inspect the trace for the dominant span: hot SQL query, N+1 access pattern, or a downstream call.
- Check the Postgres connection pool (HikariCP metrics) for saturation.

## Mitigation

- Roll back a recent deploy if a code change correlates with the ramp.
- Add or restore a missing database index; tune the offending query.
- Scale the database read replica if connection-pool starvation is the proximate cause.

## Escalation

- Page the on-call backend engineer; loop in DBA if database internals look implicated.
