## Why

Slice 8 stood up Alertmanager and wired Prometheus rules at it, but routed every firing to the built-in `null` receiver — alerts are accepted, visible via the v2 API, and then silently dropped. The eight slices of telemetry plumbing that lead up to this one are unproven end-to-end: no one would be paged if a real SLO burned, and no operator would have a triage path even if the page arrived. This slice closes that loop with a real receiver, severity-based routing, an inhibition rule, runbook annotations, and an executable end-to-end proof.

## What Changes

- New `webhook-sink` service under the `observability` docker-compose profile — a small custom container (Node + Express, multi-stage Dockerfile, pinned base image) at `infra/observability/webhook-sink/` exposing `POST /page`, `POST /ticket`, and `GET /received` (in-memory ring of recent payloads, queryable for tests).
- Rewrite `infra/observability/alertmanager/alertmanager.yml`: real routing tree keyed on the existing `severity` label (`page` → `/page`, `ticket` → `/ticket`); two webhook receivers with `send_resolved: true`; one inhibition rule where `BackendDown` firing suppresses all alerts that carry `slo=~".+"`. Existing `group_by`, `group_wait`, `group_interval`, `repeat_interval` settings preserved.
- Add `runbook_url` annotation to every alert in `infra/observability/prometheus/rules/slo-alerting.yml` and `infra/observability/prometheus/rules/fe-slo-alerting.yml`. URLs point to GitHub blob paths under `infra/observability/runbooks/<AlertName>.md`.
- New `infra/observability/runbooks/` directory with one Markdown stub per alert (twelve files: ApiAvailabilityFastBurn, ApiAvailabilitySlowBurn, ApiAvailabilityBudgetBurn, FeedReadLatencyFastBurn, FeedReadLatencySlowBurn, PostCreateLatencyFastBurn, PostCreateLatencySlowBurn, BackendDown, LcpSloFastBurn, LcpSloSlowBurn, InpSloFastBurn, InpSloSlowBurn). Each stub has Symptoms / Impact / Triage / Mitigation / Escalation sections.
- Update `promtool` test fixtures (`slo-tests.yml`, `fe-slo-tests.yml`) to assert the new `runbook_url` annotation on the alerts they exercise.
- New e2e spec at `e2e/tests/observability.alerting.spec.ts` — POSTs synthetic alerts directly to Alertmanager's `/api/v2/alerts` endpoint, polls `GET /received` on the webhook sink, asserts severity routing, runbook-annotation preservation, and the BackendDown→SLO inhibition behaviour. Self-skips when the observability profile is not running, matching the slice-9 pattern.
- README updates: the alerting run loop section gains a "what the webhook sink shows" subsection and a `docker compose logs webhook-sink` invocation.

## Capabilities

### New Capabilities

(None — this slice extends the existing observability capability.)

### Modified Capabilities

- `observability`: gains requirements for the webhook-sink service, the severity-based routing tree, the BackendDown inhibition rule, `runbook_url` annotations on every alert, the runbook stub corpus under `infra/observability/runbooks/`, the promtool annotation assertions, the alerting end-to-end proof spec, and the README documentation of the run loop.

## Impact

- **Affected files / directories:**
  - `docker-compose.yml` — new `webhook-sink` service under the `observability` profile (the profile now runs seven containers).
  - `infra/observability/webhook-sink/` (new) — server source, `package.json`, `Dockerfile`, short README.
  - `infra/observability/alertmanager/alertmanager.yml` — rewritten routing tree, receivers, inhibition rule.
  - `infra/observability/prometheus/rules/slo-alerting.yml`, `fe-slo-alerting.yml` — `runbook_url` annotation added to every alert.
  - `infra/observability/prometheus/rules/slo-tests.yml`, `fe-slo-tests.yml` — promtool assertions extended to cover the new annotation.
  - `infra/observability/runbooks/` (new) — twelve Markdown stubs.
  - `e2e/tests/observability.alerting.spec.ts` (new).
  - Top-level `README.md` (alerting run loop section).
- **Dependencies:** the webhook-sink container introduces a pinned Node base image plus `express`. No application-code dependencies on the backend or frontend change.
- **Compatibility:** no breaking changes to existing surfaces. The `null` receiver disappears, but nothing in or out of the repo relied on it. Existing `severity` and `slo` labels on alerts are unchanged; they were defined in slice 8 specifically to support this slice's routing.
- **CI:** the new e2e spec self-skips when the observability profile is not up. CI does not currently run that profile, so this slice does not add new CI gates beyond the existing `promtool test rules` step (which gains assertions but no new step).
