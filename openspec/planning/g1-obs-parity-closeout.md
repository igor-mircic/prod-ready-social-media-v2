# G1 — Observability parity closeout

**Status:** ACTIVE · promoted to `openspec/changes/add-k8s-container-saturation-alerts/` on 2026-05-17. This planning doc remains as the trajectory record; the change directory carries the implementation-ready artifacts (proposal, design, tasks, spec delta).

## Why

Slice 22b (`retire-compose-observability`, merged 2026-05-17) deleted
`container-alerts.yml` without re-authoring the three cadvisor-keyed alerts
against the OTel-shaped families slice 21 introduced (`k8s_pod_*`,
`k8s_container_*`). The runbook stubs (`ContainerCpuThrottling.md`,
`ContainerMemoryNearLimit.md`, `ContainerOomKilled.md`) already moved to
`infra/runbooks/` in the same commit so the rewrite has a runbook URL to
point at. The slice-21 `cluster-overview` dashboard covers the visualisation
gap, but the page escalation path is missing. The README and both Hetzner
overlay stubs flag this as a "prerequisite for prod alerting parity."

## Slices in this group

```
G1.1  add-k8s-container-saturation-alerts          ← only slice
```

No follow-ups. Group is one slice.

## Slice sketch

- Re-author the three alerts in `infra/k8s-obs/base/prometheus/rules/`
  against OTel families:
  - `ContainerCpuThrottling` — rate of `container_cpu_cfs_throttled_periods_total` ÷ `container_cpu_cfs_periods_total` over 5m, threshold matches the pre-22a compose rule.
  - `ContainerMemoryNearLimit` — `k8s_container_memory_working_set` ÷ `k8s_container_memory_limit` > 0.9 for 5m.
  - `ContainerOomKilled` — `increase(k8s_container_restarts{reason="OOMKilled"}[5m]) > 0` (exact label set TBD on the OTel families inspection).
- `runbook_url` annotations point at the relocated `infra/runbooks/` paths.
- Add a fourth promtool test fixture under `infra/k8s-obs/base/prometheus/tests/` so CI catches PromQL regressions.
- e2e: extend `observability.alerting.spec.ts` (or sibling) to assert one of the three firings (CpuThrottling is the easiest to provoke — a `stress-ng` sidecar in a test pod).
- README: flip the 22b "container-saturation alerting gap" note to past-tense; remove the corresponding bullets from both `overlays/hetzner/kustomization.yaml` stub comments.

## Non-goals

- No new dashboards. The slice-21 `cluster-overview` dashboard is the steady state.
- No alertmanager routing tree change. The three alerts inherit the slice-22a routing (page-webhook).
- No widening of metric coverage beyond the three deleted alerts.

## Sequencing

Independent of every other group. Can land any time. Smallest unit of value in the whole queue.

## Risk

Low. Self-contained, fully revertable, no app-side change. The only failure mode is "PromQL doesn't match the OTel family shape" — caught by the promtool test fixture before merge.

## Size estimate

One evening. ~5 file touches + one new test fixture + one e2e tweak.
