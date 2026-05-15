# BackendDown

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Prometheus has been unable to scrape `up{job="backend"}` for at least 2 minutes.
- Health checks against `/actuator/health` from the developer's machine fail.

## Impact

- The backend is fully unavailable; every user-facing surface that depends on the API is broken.
- SLO burn-rate alerts cannot fire (no samples to divide), so this alert is the canonical signal for "everything is down".
- The Alertmanager inhibition rule suppresses every other SLO alert while BackendDown is firing.

## Triage

- Check whether the backend process is running (`./gradlew :backend:bootRun`, container status, deploy target's process supervisor).
- If the process is up, inspect logs for a startup failure or repeated crash loop.
- Verify the database (Postgres) is reachable from the backend host.

## Mitigation

- Restart the backend process if it has crashed; investigate the crash cause in stdout / `bootRun` logs.
- If the database is the proximate cause, restore database availability first.
- Roll back a failing deploy if startup correlates with a recent release.

## Escalation

- Page the on-call backend engineer immediately.
- If the database is implicated, also page the on-call DBA.
