## 1. Author the three container-saturation rules

- [ ] 1.1 Confirm the exact OTel-translated metric names + label set the obs prom is actually receiving from the slice-21 agents: `curl -sS 'http://localhost:9090/api/v1/label/__name__/values' | jq '.data[] | select(startswith("k8s_container_") or startswith("k8s_pod_"))'`. The design names the expected metrics (`k8s_container_cpu_limit_utilization_ratio`, `k8s_container_memory_limit_utilization_ratio`, `k8s_container_restarts`) — verify the trailing `_ratio` suffix and the lack-of-suffix on `restarts` against actual series.
- [ ] 1.2 Confirm the actual label names used: `curl -sS 'http://localhost:9090/api/v1/series?match[]=k8s_container_cpu_limit_utilization_ratio' | jq '.data[0]'`. The design assumes `k8s_namespace_name`, `k8s_container_name`, `k8s_pod_name`, `k8s_cluster_name` (dotted-to-underscored) — verify against the chart's `prometheusremotewrite` translation defaults.
- [ ] 1.3 Create `infra/k8s-obs/base/prometheus/rules/container-alerts.yml`. File-level shape: one `groups:` array with one `name: container-saturation` group, three rules under it (`ContainerCpuLimitNearExhaustion`, `ContainerMemoryNearLimit`, `ContainerRestartingFrequently`). Header comment block: name the slice (`add-k8s-container-saturation-alerts`), the OTel-family source (slice 21), the alert→runbook mapping, and reference design.md Decision 1 + 2 for the rename rationale.
- [ ] 1.4 `ContainerCpuLimitNearExhaustion` rule: `expr: k8s_container_cpu_limit_utilization_ratio > 0.9`, `for: 5m`, `labels: {severity: page, slo: container_cpu}`, annotations as named in proposal.md (summary, description with `{{ $labels.k8s_namespace_name }}/{{ $labels.k8s_container_name }}`, runbook_url).
- [ ] 1.5 `ContainerMemoryNearLimit` rule: `expr: k8s_container_memory_limit_utilization_ratio > 0.9`, `for: 5m`, `labels: {severity: page, slo: container_memory}`, annotations.
- [ ] 1.6 `ContainerRestartingFrequently` rule: `expr: increase(k8s_container_restarts[5m]) > 1`, no `for:` (per design.md Decision 2), `labels: {severity: page, slo: container_restarts}`, annotations.
- [ ] 1.7 `promtool check rules infra/k8s-obs/base/prometheus/rules/container-alerts.yml` — exit 0.

## 2. Rename and rewrite the runbook stubs

- [ ] 2.1 `git mv infra/runbooks/ContainerCpuThrottling.md infra/runbooks/ContainerCpuLimitNearExhaustion.md` — verify `git status` shows a rename, not delete+add.
- [ ] 2.2 `git mv infra/runbooks/ContainerOomKilled.md infra/runbooks/ContainerRestartingFrequently.md` — same verification.
- [ ] 2.3 Rewrite `infra/runbooks/ContainerCpuLimitNearExhaustion.md` body: name the new alert, describe the OTel proxy semantics ("sustained >90% of CPU limit; CFS throttling correlates"), diagnosis steps (`kubectl top pod`, `kubectl describe pod`, slice-21 cluster-overview dashboard link), remediation tree (raise limit / right-size / scale out).
- [ ] 2.4 Rewrite `infra/runbooks/ContainerRestartingFrequently.md` body: name the new alert, describe restart-without-reason limitation, diagnosis steps as design.md Decision 2 enumerates (`kubectl describe pod` → Last State, `kubectl logs --previous`, loki query for kubelet OOM-kill log lines), remediation tree per termination reason.
- [ ] 2.5 `infra/runbooks/ContainerMemoryNearLimit.md` — light edit if needed to update metric names referenced in the body (likely already generic; verify).

## 3. Rewrite container-tests.yml against the new rules

- [ ] 3.1 `infra/k8s-obs/base/prometheus/tests/container-tests.yml` — replace the entire file content. Header comment block: name the slice, the rules under test, the previous content's deletion (cAdvisor-keyed assertions).
- [ ] 3.2 `rule_files:` block: single entry pointing at `../rules/container-alerts.yml` (relative path matching the slice-22b relocation discipline).
- [ ] 3.3 One `tests:` group per rule, each with two `input_series` cases: one that fires the rule, one that does not. Coverage:
  - `ContainerCpuLimitNearExhaustion`: 0.95 sustained for 5m → fires; 0.85 sustained for 5m → does not.
  - `ContainerMemoryNearLimit`: same shape, on `k8s_container_memory_limit_utilization_ratio`.
  - `ContainerRestartingFrequently`: 3 restarts over 5m → fires; 1 restart over 5m → does not.
- [ ] 3.4 `alert_rule_test:` blocks assert each `exp_alerts:` is correctly empty or populated at the eval timestamp, with the expected label set on the firing alert (severity=page, slo=...).
- [ ] 3.5 `promtool test rules infra/k8s-obs/base/prometheus/tests/container-tests.yml` — exit 0.

## 4. Apply + smoke-verify locally

- [ ] 4.1 `just obs-apply` — the `prometheus-extra-rules` ConfigMap regenerates (suffix changes); the prom pod rolls.
- [ ] 4.2 `curl -sS 'http://localhost:9090/api/v1/rules' | jq '.data.groups[] | select(.name == "container-saturation")'` — confirm the three rules are loaded under the expected group name.
- [ ] 4.3 Provoke `ContainerCpuLimitNearExhaustion`: `kubectl -n social run cpu-stress --image=polinux/stress --restart=Never --requests='cpu=100m' --limits='cpu=200m' -- stress --cpu 4 --timeout 600s`. Wait 6 minutes. Confirm the alert appears in `curl -sS 'http://localhost:9090/api/v1/alerts'` and that webhook-sink received a POST: `just obs-webhook-sink-received | jq '.[] | select(.alerts[].labels.alertname == "ContainerCpuLimitNearExhaustion")'`.
- [ ] 4.4 Clean up the stress pod: `kubectl -n social delete pod cpu-stress`. Confirm the alert resolves within 2 evaluation intervals.
- [ ] 4.5 (Optional, only if memory/restart provocations are easy on the dev box) Repeat 4.3-style provocation for the other two rules. Recommended at least once before merge; skippable if time-bound.

## 5. README, Hetzner overlay stubs, prior-slice cross-references

- [ ] 5.1 `README.md` — find the "container-saturation alerting gap" caveat (currently in the `Local observability cluster` / Forward arc / slice 22b bullet area). Flip to past-tense; cite this slice (`add-k8s-container-saturation-alerts`) as the closeout.
- [ ] 5.2 `infra/k8s/overlays/hetzner/kustomization.yaml` — delete the "Container-saturation alerting gap" bullets (currently around lines 182–193 per the slice-22b stub). The bullets named this slice as the prerequisite; once landed they are stale.
- [ ] 5.3 `infra/k8s-obs/overlays/hetzner/kustomization.yaml` — same deletion (currently around lines 188–201 per the slice-22b stub).
- [ ] 5.4 `git grep -n "add-k8s-container-saturation-alerts"` — every remaining hit should be in (a) this slice's own artifacts, (b) the openspec/changes/archive/2026-05-17-* slices (historical record). No active code or stub should still flag the gap as "open."

## 6. OpenSpec validation, branch, commit

- [ ] 6.1 `openspec validate add-k8s-container-saturation-alerts --strict` — exit 0. (Run at proposal time, before implementation begins.)
- [ ] 6.2 Branch from `main` named `add-k8s-container-saturation-alerts` and commit the proposal + design + tasks + specs delta (proposal-only commit per `feedback_branch_commit_proposal_first.md`).
- [ ] 6.3 Implementation commit after sections 1–5 complete. PR against `main`. Per `feedback_openspec_apply_autonomous_to_merge.md`: drive commit → push → PR → watch-CI → archive → re-watch CI without prompting; ask only at merge time.
- [ ] 6.4 After PR is green: `openspec archive add-k8s-container-saturation-alerts --yes` to fold the spec delta into the canonical `openspec/specs/observability-cluster/spec.md`. Re-watch CI on the archive commit.
