## MODIFIED Requirements

### Requirement: The obs prometheus chart mounts the migrated rule files via a kustomize-generated ConfigMap

The kustomization at `infra/k8s-obs/base/prometheus/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `prometheus-extra-rules` sourcing every `.yml` file in the `infra/k8s-obs/base/prometheus/rules/` directory. The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL declare a `server.extraConfigmapMounts:` entry that mounts the generated ConfigMap at `/etc/prometheus-extra-rules/` inside the prometheus pod. The chart values SHALL override `serverFiles.prometheus.yml.rule_files:` to PRESERVE the chart-default entries (`/etc/config/recording_rules.yml`, `/etc/config/alerting_rules.yml`) AND APPEND `/etc/prometheus-extra-rules/*.yml` so the migrated rules are loaded at prometheus startup.

The `infra/k8s-obs/base/prometheus/rules/` directory SHALL contain `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`, AND `container-alerts.yml` as the canonical source of truth. `container-alerts.yml` is authored against the slice-21 OTel families (`k8s_container_*` via the `kubeletstats` receiver) and SHALL NOT reference cAdvisor-shaped series (`container_cpu_*`, `container_memory_*`, `kube_pod_container_status_*`). The contents and label semantics of `container-alerts.yml`'s three rules are pinned by a separate requirement (`Container-saturation alerts pin the three OTel-family rules`).

The four promtool test fixtures (`slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`) SHALL live at `infra/k8s-obs/base/prometheus/tests/` (relocated from `infra/observability/prometheus/rules/` in slice 22b). The CI `prometheus-rules` job's `promtool test rules` step reads from this directory. `container-tests.yml` SHALL be the active fixture for `container-alerts.yml` — its previous historical-record content (cAdvisor-keyed assertions) is replaced by assertions matching the new OTel-family PromQL.

#### Scenario: ConfigMap generator picks up every migrated rule file

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a ConfigMap whose name begins with `prometheus-extra-rules-`
- **AND** the ConfigMap's `data:` map contains exactly six keys: `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`, `container-alerts.yml`

#### Scenario: Prometheus pod mounts the ConfigMap at the expected path

- **WHEN** a reader inspects the prometheus chart's rendered Deployment / StatefulSet
- **THEN** the pod-spec `volumes:` references the `prometheus-extra-rules` ConfigMap
- **AND** the prometheus container's `volumeMounts:` mounts that volume at `/etc/prometheus-extra-rules/` read-only

#### Scenario: Rule files are loaded at prometheus startup

- **GIVEN** the obs cluster has applied this slice and the prometheus pod has restarted
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field begins with `/etc/prometheus-extra-rules/`
- **AND** the groups together declare every alert from the six migrated files (`ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `BackendDown`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`, `PostgresConnectionSaturation`, `PostgresDeadlocks`, `ContainerCpuLimitNearExhaustion`, `ContainerMemoryNearLimit`, `ContainerRestartingFrequently`)

#### Scenario: Promtool test fixtures live in a dedicated `tests/` directory, not in `rules/`

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** no file in the directory ends in `-tests.yml`
- **AND** the directory `infra/k8s-obs/base/prometheus/tests/` contains exactly four files: `slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`
- **AND** no equivalent file exists under `infra/observability/prometheus/`

#### Scenario: container-tests.yml exercises the new OTel-family rules

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/tests/container-tests.yml`
- **THEN** the file's `rule_files:` block references `../rules/container-alerts.yml` (relative path)
- **AND** the file contains `alert_rule_test:` blocks asserting the firing and non-firing behaviour of each of `ContainerCpuLimitNearExhaustion`, `ContainerMemoryNearLimit`, `ContainerRestartingFrequently`
- **AND** `promtool test rules infra/k8s-obs/base/prometheus/tests/container-tests.yml` exits 0

## ADDED Requirements

### Requirement: Container-saturation alerts pin the three OTel-family rules

The file `infra/k8s-obs/base/prometheus/rules/container-alerts.yml` SHALL declare a single rule group named `container-saturation` containing exactly three alerting rules: `ContainerCpuLimitNearExhaustion`, `ContainerMemoryNearLimit`, `ContainerRestartingFrequently`. Every rule's `expr:` SHALL reference only metric series the slice-21 OTel families emit (`k8s_container_*` from the `kubeletstats` receiver after `prometheusremotewrite` translation); no rule SHALL reference cAdvisor-shaped names (`container_cpu_*`, `container_memory_*`, `kube_pod_container_status_*`).

Every rule SHALL declare `labels.severity: page` so the alertmanager severity-keyed routing tree (slice 22a) delivers the firing to the `page-webhook` receiver. Every rule SHALL declare an `annotations.runbook_url` of the form `https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/<RuleName>.md`, where `<RuleName>` is the alert's rule name and points at an existing markdown file in `infra/runbooks/`. Every rule SHALL declare `annotations.summary` (single-line operator message) and `annotations.description` (longer-form, with `{{ $labels.k8s_namespace_name }}` and `{{ $labels.k8s_container_name }}` template interpolation so the firing identifies the specific pod).

The thresholds and for-windows SHALL be:

- `ContainerCpuLimitNearExhaustion`: `expr: k8s_container_cpu_limit_utilization_ratio > 0.9`, `for: 5m`. The rule is a proxy for CFS throttling — the kubeletstats receiver does not emit CFS-period counters; sustained near-limit utilisation correlates with throttling events.
- `ContainerMemoryNearLimit`: `expr: k8s_container_memory_limit_utilization_ratio > 0.9`, `for: 5m`. Direct semantic equivalent of the deleted cAdvisor-keyed rule.
- `ContainerRestartingFrequently`: `expr: increase(k8s_container_restarts[5m]) > 1`, no `for:` window. Renamed from the deleted `ContainerOomKilled` because the OTel families do not surface container termination reason; the runbook directs the operator to inspect `kubectl describe pod` for OOM vs other restart causes.

#### Scenario: container-alerts.yml is loaded and rules are queryable

- **GIVEN** the obs cluster has applied this slice and the prometheus pod has restarted
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/rules?type=alert`
- **THEN** the response contains rule entries named `ContainerCpuLimitNearExhaustion`, `ContainerMemoryNearLimit`, `ContainerRestartingFrequently`
- **AND** each is grouped under `group: container-saturation`
- **AND** each carries `labels.severity: page`

#### Scenario: PromQL references only OTel families

- **WHEN** a reader greps `infra/k8s-obs/base/prometheus/rules/container-alerts.yml` for metric names
- **THEN** every metric name referenced begins with `k8s_container_` or `k8s_pod_` (the slice-21 `kubeletstats` family namespace after `prometheusremotewrite` translation)
- **AND** no metric name begins with `container_` (cAdvisor namespace) or `kube_pod_container_status_` (kube-state-metrics namespace)

#### Scenario: Runbook annotations point at existing files

- **WHEN** a reader inspects each rule's `annotations.runbook_url`
- **THEN** the URL has the shape `https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/runbooks/<RuleName>.md`
- **AND** the file at `infra/runbooks/<RuleName>.md` exists in the working tree for each `<RuleName>` (`ContainerCpuLimitNearExhaustion.md`, `ContainerMemoryNearLimit.md`, `ContainerRestartingFrequently.md`)

#### Scenario: Cpu-limit alert fires under sustained near-limit utilisation

- **GIVEN** a pod in the `social` namespace whose container declares a CPU limit
- **WHEN** that container sustains `k8s_container_cpu_limit_utilization_ratio > 0.9` for 5 minutes (provoked locally by e.g. a `stress --cpu N` sidecar)
- **THEN** within one evaluation interval after the for-window completes, `ContainerCpuLimitNearExhaustion` appears in the response of `http://prometheus-server.observability.svc.cluster.local/api/v1/alerts` with `state: firing`
- **AND** the firing's `labels` include `k8s_namespace_name="social"` and the offending pod's `k8s_container_name`
- **AND** within one alertmanager group_interval (5m), a POST body referencing `alertname: ContainerCpuLimitNearExhaustion` appears in the webhook-sink's captured payloads (`just obs-webhook-sink-received`)

#### Scenario: Restart-loop alert fires immediately on the second restart

- **GIVEN** a pod whose container has restarted twice within a 5-minute window
- **WHEN** the second restart causes `increase(k8s_container_restarts[5m]) > 1` to evaluate true
- **THEN** within one evaluation interval, `ContainerRestartingFrequently` appears in the alerts API with `state: firing`
- **AND** no for-window delay applies (the rule has no `for:` field)

## MODIFIED Requirements

### Requirement: Hetzner overlay stubs reflect the post-slice trajectory

The two Hetzner overlay stubs at `infra/k8s/overlays/hetzner/kustomization.yaml` and `infra/k8s-obs/overlays/hetzner/kustomization.yaml` SHALL NOT carry any commented bullet describing "container-saturation alerting gap" or naming `add-k8s-container-saturation-alerts` as a follow-up slice. The bullets named this slice as the prerequisite for prod alerting parity; once this slice lands, the bullets are stale and SHALL be removed.

Both overlay stubs MAY continue to carry other commented follow-up bullets unrelated to container saturation (cert-manager, real DNS, secrets strategy, etc.); those are out of scope for this requirement.

#### Scenario: No container-saturation follow-up bullet remains in either stub

- **WHEN** a reader greps both `infra/k8s/overlays/hetzner/kustomization.yaml` and `infra/k8s-obs/overlays/hetzner/kustomization.yaml` for the strings `container-saturation`, `container-alerts`, `ContainerCpuThrottling`, `ContainerOomKilled`, `ContainerMemoryNearLimit`
- **THEN** no match is returned in either file
