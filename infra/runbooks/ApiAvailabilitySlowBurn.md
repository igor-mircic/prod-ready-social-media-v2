# ApiAvailabilitySlowBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: 5xx ratio on `/api/v1/*` exceeds `6 × (1 - 0.995) = 0.03` on both the 6h and 30m windows.
- Less acute than the fast-burn variant but sustained over a longer period.

## Impact

- API consumers see a smaller but persistent fraction of 5xx responses; the 30d budget burns at ~6× the SLO-allowed rate.
- At this pace the 30d budget is exhausted in ~5 days.

## Triage

- Open the Alertmanager UI and confirm whether `ApiAvailabilityFastBurn` is also firing (if so, treat as a fast-burn incident).
- Inspect backend access logs grouped by `url.path` for which routes drive the elevated 5xx rate.
- Check whether a partial outage in a downstream service is the cause.

## Mitigation

- Identify the offending code path or downstream dependency; deploy a fix or revert.
- If load-driven, consider scaling the backend horizontally or shedding non-essential traffic.

## Escalation

- Page the on-call backend engineer if the burn rate does not subside within one hour.
- Escalate to platform on-call if a shared infrastructure component is involved.
