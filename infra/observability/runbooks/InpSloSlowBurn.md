# InpSloSlowBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of INP samples slower than 200ms exceeds `6 × (1 - 0.95) = 0.30` on both the 6h and 30m windows.
- p75 INP sits modestly above 200ms over a sustained period.

## Impact

- A noticeable minority of user interactions feel laggy; the 30d budget burns at ~6× the SLO-allowed rate.
- At this pace the 30d budget is exhausted in ~5 days.

## Triage

- Check whether `InpSloFastBurn` is also firing — if so, treat as a fast-burn incident.
- Look at routes by INP p75 and cross-reference with recent code changes to event handlers.
- Inspect long-task durations and identify the dominant handler in the FE traces.

## Mitigation

- Address the slow handler; defer or split expensive work.
- Roll back if a recent deploy correlates with the regression.

## Escalation

- Page the on-call frontend engineer if the burn rate does not subside within one hour.
