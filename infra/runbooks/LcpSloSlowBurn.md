# LcpSloSlowBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of LCP samples slower than 2500ms exceeds `6 × (1 - 0.95) = 0.30` on both the 6h and 30m windows.
- p75 sits modestly above 2500ms over a sustained period.

## Impact

- A noticeable minority of page loads exceed the LCP target; the 30d budget burns at ~6× the SLO-allowed rate.
- At this pace the 30d budget is exhausted in ~5 days.

## Triage

- Check whether `LcpSloFastBurn` is also firing — if so, treat as a fast-burn incident.
- Look at top routes by p75 LCP and compare with last week's baseline.
- Investigate whether a third-party script or new asset has appeared in the page.

## Mitigation

- Identify the offending route or asset; ship a fix or roll back the responsible deploy.
- Use the slice-6 metrics-to-trace pivot to confirm the dominant cause.

## Escalation

- Page the on-call frontend engineer if the burn rate does not subside within one hour.
