## Why

Slice 22b (`retire-compose-observability`, merged 2026-05-17) deleted `infra/observability/prometheus/rules/container-alerts.yml` without re-authoring its three rules against the slice-21 OTel-shaped families. The slice-22a/22b design narrative named this gap explicitly (slice-22a design.md Decision 6) and deferred the rewrite to a follow-up slice (this one). The runbook stubs (`ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, `ContainerOomKilled.md`) already moved to `infra/runbooks/` in slice 22b so the new rules have annotation targets ready. The slice-21 `cluster-overview` grafana dashboard covers the visualisation gap, but the page escalation path is missing — that's the gap this slice closes.

Both Hetzner overlay stubs (`infra/k8s/overlays/hetzner/kustomization.yaml`, `infra/k8s-obs/overlays/hetzner/kustomization.yaml`) name `add-k8s-container-saturation-alerts` as the prerequisite for prod alerting parity with the pre-22a compose stack. This slice is the unblocker.

## What Changes

- **Add `infra/k8s-obs/base/prometheus/rules/container-alerts.yml`** declaring three alerting rules against the slice-21 OTel families (`k8s_container_*`, `k8s_pod_*` via `kubeletstats`):
  - `ContainerCpuLimitNearExhaustion` — `k8s_container_cpu_limit_utilization > 0.9` for 5m. (Rename from the cadvisor-era `ContainerCpuThrottling` because the OTel kubeletstats receiver does not emit a CFS-throttling counter; design.md Decision 1 covers the rename and the proxy semantics.)
  - `ContainerMemoryNearLimit` — `k8s_container_memory_limit_utilization > 0.9` for 5m. (Direct rename — semantics identical to the deleted rule.)
  - `ContainerRestartingFrequently` — `increase(k8s_container_restarts[5m]) > 1` for 0m (no for-window — restart loops are paging-loud). (Rename from `ContainerOomKilled` because the OTel families surface restart counts but not termination reason; design.md Decision 2 covers the rename and points OOM-specific diagnosis at the runbook.)
- **Annotations on each rule**: `severity: page`, `summary:` one-liner, `description:` template with `{{ $labels.k8s_namespace_name }}` / `{{ $labels.k8s_container_name }}` interpolation, `runbook_url:` pointing at `https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/<RuleName>.md`.
- **Rename two runbook stubs** under `infra/runbooks/` so the file names match the renamed alerts: `ContainerCpuThrottling.md` → `ContainerCpuLimitNearExhaustion.md`; `ContainerOomKilled.md` → `ContainerRestartingFrequently.md`. `ContainerMemoryNearLimit.md` keeps its name. Bodies updated to describe the new alert semantics + diagnosis steps (e.g. ContainerRestartingFrequently's runbook documents how to check `kubectl describe pod` for `last_terminated.reason: OOMKilled`).
- **Rewrite `infra/k8s-obs/base/prometheus/tests/container-tests.yml`** (relocated in slice 22b, currently a historical record per the slice-22a/22b spec language) into a working promtool test fixture exercising the three new rules' PromQL. At minimum: one test per rule covering one firing condition + one non-firing condition.
- **Update the CI `prometheus-rules` job's expectation** that `container-tests.yml` is active: no workflow-file edit required (the job already runs `promtool test rules` against every `*.yml` in `infra/k8s-obs/base/prometheus/tests/`), but the slice's verification step asserts the four-fixture run is green.
- **README**: flip the "container-saturation alerting gap" caveat in the `Local observability cluster` / Forward arc sections to past-tense; remove the "open follow-up" status from the slice 22b bullet.
- **Hetzner overlay stubs**: drop the "container-saturation alerting gap" follow-up bullets from both `infra/k8s/overlays/hetzner/kustomization.yaml` and `infra/k8s-obs/overlays/hetzner/kustomization.yaml`. The bullets named this slice as the prerequisite; once this slice lands the bullets are stale.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `observability-cluster`: small delta. The existing "obs prometheus chart mounts the migrated rule files" requirement is updated so `container-alerts.yml` is now PART of the canonical rule set (currently SHALL NOT be present). The existing "promtool test fixtures" requirement is updated so `container-tests.yml` is now active (currently retained as a historical record). One new requirement is added pinning the three container-saturation alerts' content + label shape + runbook annotation contract.

- `observability`, `kubernetes`, `ci`: no delta. The CI job already iterates `*.yml` in `tests/`; the kubernetes spec's collector pipeline is unaffected; the observability spec's alertmanager routing tree (severity-keyed) already routes any `severity=page` rule unchanged.

## Impact

- **Code / manifests**: one new file (`container-alerts.yml`), one rewritten file (`container-tests.yml`), two renamed files (runbook stubs).
- **No app-side code change**: `backend/` and `frontend/` are untouched.
- **No new images, no chart-value changes, no Lima portForward edits**.
- **CI impact**: net-zero step count. Same `promtool test rules` invocation, one more fixture file (`container-tests.yml`) now contributes assertions instead of being a no-op.
- **Obs prom storage impact**: three new alert rules emit one series each per 30s evaluation interval. At 7d retention (slice 17 default), additional cost is < 1 MB on the 5 GiB PVC.
- **Alertmanager impact**: three new `severity=page` alerts route through the existing `page-webhook` receiver. No alertmanager config change.
- **Backwards-compatibility**: no breaking changes. Adds alerting coverage that did not exist post-22b.
- **Backout**: single revert. The CI job continues to function with `container-tests.yml` reverted to the historical-record content.
