# InpSloFastBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of INP samples slower than 200ms exceeds `14.4 × (1 - 0.95) = 0.72` on both the 1h and 5m windows.
- The Frontend overview INP p75 panel shows a clear regression.

## Impact

- Most user interactions feel laggy; the INP 30d budget burns at ~14× the SLO-allowed rate.
- Sustained at this pace, the entire 30d budget is exhausted in ~2 days.

## Triage

- Check the Frontend overview long-task panel for an obvious main-thread block correlated in time.
- Look at recent frontend deploys for new event handlers or heavy synchronous code paths in click/keydown listeners.
- Identify which route's interactions dominate the regression.

## Mitigation

- Roll back the responsible deploy.
- Move expensive work out of event handlers (debounce, defer, scheduler.yield).
- Reduce JS execution cost during the long-task window.

## Escalation

- Page the on-call frontend engineer.
