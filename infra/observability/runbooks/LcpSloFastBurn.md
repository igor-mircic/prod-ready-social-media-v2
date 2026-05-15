# LcpSloFastBurn

Stub runbook — fill in with real incident learnings as they accumulate.

## Symptoms

- Multi-window burn-rate alert: the fraction of LCP samples slower than 2500ms exceeds `14.4 × (1 - 0.95) = 0.72` on both the 1h and 5m windows.
- The Frontend overview LCP p75 panel sits well above 2500ms.

## Impact

- Most page loads feel sluggish to users; the LCP 30d budget burns at ~14× the SLO-allowed rate.
- Sustained at this pace, the entire 30d budget is exhausted in ~2 days.

## Triage

- Check the slice-6 Frontend overview dashboard for which routes drive the regression.
- Compare against the latest frontend deploy: a new bundle, font, or above-the-fold image often correlates with LCP regressions.
- Inspect the FE trace for the slowest route in Tempo — look for blocking fetches or long render spans.

## Mitigation

- Roll back the most recent frontend deploy if it correlates with the regression.
- Preload critical resources, defer non-critical scripts, optimise above-the-fold images.

## Escalation

- Page the on-call frontend engineer.
- Escalate to platform if a CDN or origin-network problem is implicated.
