# ApiAvailabilityFastBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: 5xx ratio on `/api/v1/*` exceeds `14.4 × (1 - 0.995) = 0.072` on both the 1h and 5m windows.
- Grafana "Backend overview" 5xx-rate panel shows a clear ramp.

## Impact

- API consumers see elevated 5xx responses on the main backend; the 30d error budget is burning ~14× faster than the SLO allows.
- Sustained burn at this rate exhausts the entire 30d budget in ~2 days.

## Triage

- Check the Alertmanager grouping (`alertname`, `slo`) at `http://localhost:9093` to confirm scope.
- Inspect the most-recent backend access logs in Loki for `http.response.status_code >= 500`, grouped by `url.path`.
- Pivot from a 5xx exemplar diamond on the latency panel to the offending Tempo trace.

## Mitigation

- If a recent deploy correlates with the ramp, roll back via the standard deploy workflow.
- If a downstream dependency (database, external API) is the cause, fail open or shed traffic at the edge.

## Escalation

- Page the on-call backend engineer through the configured paging integration (this slice uses the local-dev webhook sink in place of a real receiver).
- If unresolved within 30 minutes, escalate to the platform on-call.
