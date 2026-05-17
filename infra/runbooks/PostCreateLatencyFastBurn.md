# PostCreateLatencyFastBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of post-creates slower than 500ms exceeds `14.4 × (1 - 0.95) = 0.72` on both the 1h and 5m windows.
- The "Post create latency" panel on the Backend overview dashboard shows a clear ramp.

## Impact

- Users see noticeably slow post submission; the 30d post-create latency budget burns at ~14× the SLO-allowed rate.
- Sustained at this pace, the entire 30d budget is exhausted in ~2 days.

## Triage

- Pivot from a slow exemplar on the post-create latency panel to its Tempo trace.
- Identify the dominant span: typically the SQL insert, fanout-on-write, or a write-amplification path.
- Check write-side database metrics: lock waits, autovacuum, replication lag.

## Mitigation

- Roll back a recent deploy if it correlates with the ramp.
- Tune the offending query, drop an unused index that's slowing writes, or scale write capacity.

## Escalation

- Page the on-call backend engineer; loop in DBA if write-side database internals are implicated.
