# ApiAvailabilityBudgetBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Ticket-level burn alert: 5xx ratio on `/api/v1/*` exceeds `1 × (1 - 0.995) = 0.005` on both the 3d and 6h windows.
- Steady low-level error rate rather than a spike.

## Impact

- Background API errors slowly consume the 30d budget at the SLO-allowed rate — anything above this and we end the period out of budget.
- Customer impact is hard to spot in real time; the budget burn is the trigger.

## Triage

- Open Grafana "Backend overview" and look at the 5xx rate over the last week — is the elevated rate a single offender or broad?
- Cross-reference with recent deploys, schema migrations, or dependency upgrades.
- Look at top URI paths by 5xx count for the affected window.

## Mitigation

- This is a ticket, not a page — schedule remediation in the normal sprint cadence.
- Investigate persistent low-rate failures and address root causes (often a specific code path or input combination).

## Escalation

- No paging — file a ticket against the owning team.
- Escalate to SRE leadership only if the trend continues for a second consecutive 3d window.
