# PostCreateLatencySlowBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of post-creates slower than 500ms exceeds `6 × (1 - 0.95) = 0.30` on both the 6h and 30m windows.
- p95 of `posts.create.duration` sits modestly above 500ms over a sustained period.

## Impact

- A noticeable minority of post submissions feel slow; the 30d budget burns at ~6× the SLO-allowed rate.
- At this pace the 30d budget is exhausted in ~5 days.

## Triage

- Check whether `PostCreateLatencyFastBurn` is also firing — if so, treat as a fast-burn incident.
- Inspect slow post-create traces; look for new spans or longer-than-usual database spans.
- Cross-reference with deploys and database schema changes over the past 6 hours.

## Mitigation

- Identify and address the slow code path or database query.
- If load-driven, scale the write-side capacity or rate-limit excessive callers.

## Escalation

- Page the on-call backend engineer if the burn rate does not subside within one hour.
