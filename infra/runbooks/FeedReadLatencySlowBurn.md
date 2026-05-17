# FeedReadLatencySlowBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of feed reads slower than 200ms exceeds `6 × (1 - 0.95) = 0.30` on both the 6h and 30m windows.
- p95 sits modestly above 200ms over a sustained period.

## Impact

- A noticeable minority of feed reads exceed the latency budget; the 30d budget burns at ~6× the SLO-allowed rate.
- At this pace the 30d budget is exhausted in ~5 days.

## Triage

- Check whether `FeedReadLatencyFastBurn` is also firing — if so, treat as a fast-burn incident.
- Look at top URIs and tenants by p95; is the regression broad or scoped?
- Inspect the trace-to-logs pivot for slow feed traces and grep their access logs for shared characteristics.

## Mitigation

- Identify the offending code path or query; deploy a fix or roll back.
- If load-driven, scale or shed traffic; if hot keys are involved, evaluate cache layout.

## Escalation

- Page the on-call backend engineer if the burn rate does not subside within one hour.
