## ADDED Requirements

### Requirement: The metrics-agent DaemonSet lives at `infra/k8s/base/metrics-agent/`

A new DaemonSet workload SHALL run one pod per node of the app cluster in the `social` namespace. The directory SHALL contain a kustomization, a DaemonSet manifest, a ConfigMap with the collector pipeline, a ServiceAccount, and an RBAC manifest binding a ClusterRole to the ServiceAccount. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./metrics-agent` in its `resources:` array. The DaemonSet's container image SHALL be `otel/opentelemetry-collector-contrib:0.111.0` — the same pin every other collector in this repository uses (gateway, log-agent, obs collector).

#### Scenario: Base kustomization includes the metrics-agent

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a DaemonSet named `metrics-agent` in the `social` namespace
- **AND** the DaemonSet's pod-spec image is `otel/opentelemetry-collector-contrib:0.111.0`

#### Scenario: DaemonSet schedules on every node

- **WHEN** the cluster has applied the new manifests
- **AND** an operator runs `kubectl --context social -n social get daemonset metrics-agent`
- **THEN** the `DESIRED` and `READY` counts equal the cluster's node count
- **AND** `kubectl --context social -n social get pods -l app.kubernetes.io/name=metrics-agent -o wide` shows one pod per node

### Requirement: The metrics-agent DaemonSet tolerates all taints

The DaemonSet pod-spec SHALL declare `tolerations: [{operator: Exists}]` so that pods schedule on every node including the control-plane-tainted only node of a single-node k3s cluster. The DaemonSet SHALL NOT declare any `nodeSelector` that would narrow placement. The DaemonSet SHALL inject the node name into the pod's environment via the downward API (`spec.nodeName`) under the env var `NODE_NAME` so the `kubeletstats` receiver can dial the local kubelet by name.

#### Scenario: Toleration matches control-plane taint

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/daemonset.yaml`
- **THEN** the pod-spec `tolerations:` list contains an entry with `operator: Exists` and no `key` or `effect`

#### Scenario: NODE_NAME env var is injected

- **WHEN** a reader inspects the pod-spec `env:` list
- **THEN** an entry named `NODE_NAME` SHALL declare `valueFrom.fieldRef.fieldPath: spec.nodeName`

#### Scenario: Pod schedules on a control-plane-only single-node cluster

- **WHEN** the cluster has exactly one node carrying the `node-role.kubernetes.io/control-plane` taint
- **AND** the metrics-agent DaemonSet has been applied
- **THEN** `kubectl get pods -l app.kubernetes.io/name=metrics-agent -n social` shows exactly one Running pod

### Requirement: The metrics-agent ConfigMap declares the kubeletstats + hostmetrics → batch → otlp pipeline

The ConfigMap at `infra/k8s/base/metrics-agent/configmap.yaml` SHALL be named `metrics-agent-config` and SHALL declare a single OpenTelemetry Collector `metrics:` pipeline composed of: a `kubeletstats` receiver scraping `https://${NODE_NAME}:10250`, a `hostmetrics` receiver reading `/proc` and `/sys` from a hostPath mount at `/hostfs`, a `batch` processor, and an `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true`. The pipeline SHALL NOT declare any logs or traces pipelines.

The `kubeletstats` receiver SHALL declare `auth_type: serviceAccount`, `insecure_skip_verify: true`, and a collection interval of 15s.

The `hostmetrics` receiver SHALL declare `root_path: /hostfs` and SHALL enable the scrapers `cpu`, `memory`, `load`, `disk`, `filesystem`, `network`, `paging`, `processes` and SHALL NOT enable the scrapers `process`, `processes_temperature`, `system`. The collection interval SHALL be 15s.

The `health_check` extension SHALL bind to `0.0.0.0:13133` so the kubelet probe can reach it from outside the pod's network namespace.

#### Scenario: Two receivers, one exporter, single pipeline

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/configmap.yaml`
- **THEN** the `service.pipelines.metrics.receivers:` list contains exactly `kubeletstats` and `hostmetrics`
- **AND** the `service.pipelines.metrics.processors:` list contains exactly `batch`
- **AND** the `service.pipelines.metrics.exporters:` list contains exactly `otlp`
- **AND** the `service.pipelines:` block does NOT declare a `logs:` or `traces:` key

#### Scenario: OTLP exporter targets the gateway Service

- **WHEN** a reader inspects the `exporters.otlp:` block
- **THEN** the `endpoint:` is `collector.social.svc.cluster.local:4317`
- **AND** `tls.insecure: true` is declared

#### Scenario: hostmetrics scraper allow-list is explicit

- **WHEN** a reader inspects the `receivers.hostmetrics.scrapers:` block
- **THEN** keys exist for `cpu`, `memory`, `load`, `disk`, `filesystem`, `network`, `paging`, `processes`
- **AND** no keys exist for `process`, `processes_temperature`, or `system`

### Requirement: The metrics-agent ServiceAccount has cluster-scoped read on node stats

A ServiceAccount named `metrics-agent` SHALL exist in the `social` namespace. A ClusterRole named `metrics-agent` SHALL grant `get`, `list`, `watch` on `nodes`, `nodes/stats`, `nodes/proxy`, and `nodes/metrics` in the core (`""`) apiGroup. A ClusterRoleBinding SHALL bind the ClusterRole to the ServiceAccount. The grant SHALL be read-only — no `create`, `update`, `patch`, or `delete` verbs.

The grant is cluster-scoped because the `kubeletstats` receiver dials the local node's kubelet via its node name resolution path, which requires permissions registered at the cluster level even when the kubelet is on the same node as the pod.

#### Scenario: ClusterRole verbs are read-only

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/rbac.yaml`
- **THEN** every rule's `verbs:` list contains only members of `{"get", "list", "watch"}`
- **AND** no rule references `nodes/log` or `nodes/exec`

#### Scenario: ClusterRoleBinding refers to the correct subjects

- **WHEN** a reader inspects the ClusterRoleBinding manifest
- **THEN** `roleRef.name` is `metrics-agent`
- **AND** `subjects[0].kind` is `ServiceAccount` with name `metrics-agent` in namespace `social`

### Requirement: The metrics-agent container declares health-check probes against the `health_check` extension

The metrics-agent container SHALL declare a `livenessProbe` and a `readinessProbe` that both `httpGet` the `health_check` extension's bind port (`13133`). The probes SHALL declare conservative timings (initialDelaySeconds, periodSeconds, failureThreshold) consistent with the gateway and log-agent collector probes.

#### Scenario: Probes target the health_check extension

- **WHEN** a reader inspects the DaemonSet's `containers[0]` block
- **THEN** `livenessProbe.httpGet.port` and `readinessProbe.httpGet.port` both reference the named port `healthcheck` (or the literal `13133`)
- **AND** the named container port `healthcheck` SHALL declare `containerPort: 13133`

### Requirement: The metrics-agent container declares conservative resource requests and limits

The metrics-agent container SHALL declare `requests: cpu=50m, memory=128Mi` and `limits: cpu=200m, memory=256Mi`. These values match the slice-20 log-agent envelope so operators learn one envelope across both agents.

#### Scenario: Resources are sized like the log-agent

- **WHEN** a reader inspects the DaemonSet pod-spec
- **THEN** the container's `resources.requests` and `resources.limits` equal the slice-20 log-agent's values byte-for-byte

### Requirement: The metrics-cluster-agent Deployment lives at `infra/k8s/base/metrics-cluster-agent/`

A new Deployment workload SHALL run a singleton pod (`replicas: 1`) in the `social` namespace. The directory SHALL contain a kustomization, a Deployment manifest, a ConfigMap with the collector pipeline, a ServiceAccount, and an RBAC manifest. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./metrics-cluster-agent` in its `resources:` array. The Deployment's container image SHALL be `otel/opentelemetry-collector-contrib:0.111.0`.

The Deployment SHALL NOT declare `tolerations:` beyond the cluster default. The Deployment SHALL NOT declare a `nodeSelector` that narrows placement.

#### Scenario: Singleton Deployment exists

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a Deployment named `metrics-cluster-agent` in the `social` namespace
- **AND** the Deployment's `spec.replicas` is `1`

#### Scenario: Deployment does not duplicate cluster-state metrics

- **WHEN** the Deployment has been applied
- **AND** an operator runs `kubectl --context social -n social get pods -l app.kubernetes.io/name=metrics-cluster-agent`
- **THEN** exactly one pod is listed
- **AND** in obs prometheus, the query `count(k8s_deployment_available{deployment="backend"})` returns a single series

### Requirement: The metrics-cluster-agent ConfigMap declares the k8s_cluster → batch → otlp pipeline

The ConfigMap at `infra/k8s/base/metrics-cluster-agent/configmap.yaml` SHALL be named `metrics-cluster-agent-config` and SHALL declare a single OpenTelemetry Collector `metrics:` pipeline composed of: a `k8s_cluster` receiver, a `batch` processor, and an `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true`. The pipeline SHALL NOT declare any logs or traces pipelines.

The `k8s_cluster` receiver SHALL declare `auth_type: serviceAccount`, `collection_interval: 15s`, and `node_conditions_to_report: [Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]`.

The `health_check` extension SHALL bind to `0.0.0.0:13133`.

#### Scenario: One receiver, one exporter, single pipeline

- **WHEN** a reader inspects `infra/k8s/base/metrics-cluster-agent/configmap.yaml`
- **THEN** the `service.pipelines.metrics.receivers:` list contains exactly `k8s_cluster`
- **AND** the `service.pipelines.metrics.processors:` list contains exactly `batch`
- **AND** the `service.pipelines.metrics.exporters:` list contains exactly `otlp`
- **AND** the `service.pipelines:` block does NOT declare a `logs:` or `traces:` key

#### Scenario: All five node conditions reported

- **WHEN** a reader inspects the `receivers.k8s_cluster:` block
- **THEN** `node_conditions_to_report:` is exactly `[Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]`

### Requirement: The metrics-cluster-agent ServiceAccount has cluster-scoped read on apiserver resources

A ServiceAccount named `metrics-cluster-agent` SHALL exist in the `social` namespace. A ClusterRole named `metrics-cluster-agent` SHALL grant `get`, `list`, `watch` on the resource kinds the `k8s_cluster` contrib receiver documents as its minimum: `events`, `namespaces`, `namespaces/status`, `nodes`, `nodes/status`, `persistentvolumeclaims`, `persistentvolumes`, `pods`, `pods/status`, `replicationcontrollers`, `replicationcontrollers/status`, `resourcequotas`, `services` in the core (`""`) apiGroup; `daemonsets`, `deployments`, `replicasets`, `statefulsets` in the `apps` apiGroup; `daemonsets`, `deployments`, `replicasets` in the `extensions` apiGroup; `jobs`, `cronjobs` in the `batch` apiGroup; `horizontalpodautoscalers` in the `autoscaling` apiGroup. A ClusterRoleBinding SHALL bind the ClusterRole to the ServiceAccount.

The grant SHALL be read-only — no `create`, `update`, `patch`, or `delete` verbs.

#### Scenario: ClusterRole covers every receiver-required resource kind

- **WHEN** a reader inspects `infra/k8s/base/metrics-cluster-agent/rbac.yaml`
- **THEN** the rules block enumerates every kind named above with its correct apiGroup
- **AND** every rule's `verbs:` list contains only `get`, `list`, `watch`

#### Scenario: ClusterRoleBinding refers to the correct subjects

- **WHEN** a reader inspects the ClusterRoleBinding manifest
- **THEN** `roleRef.name` is `metrics-cluster-agent`
- **AND** `subjects[0].kind` is `ServiceAccount` with name `metrics-cluster-agent` in namespace `social`

### Requirement: The metrics-cluster-agent container declares health-check probes and conservative resources

The metrics-cluster-agent container SHALL declare `livenessProbe` and `readinessProbe` against the `health_check` extension's port `13133`. The container SHALL declare `requests: cpu=50m, memory=128Mi` and `limits: cpu=200m, memory=256Mi` (matching the metrics-agent and slice-20 log-agent envelopes).

#### Scenario: Probes and resources match the agent envelope

- **WHEN** a reader inspects the Deployment pod-spec
- **THEN** `livenessProbe.httpGet.port` and `readinessProbe.httpGet.port` both reference the named port `healthcheck` (or `13133`)
- **AND** the container's `resources.requests` and `resources.limits` equal the metrics-agent's values byte-for-byte

### Requirement: Cluster metrics land in obs prometheus end-to-end

After the slice is applied, the obs cluster's prometheus SHALL contain at least one sample of `k8s_node_cpu_utilization` (from the metrics-agent's kubeletstats receiver), at least one sample of `system_cpu_utilization` (from the metrics-agent's hostmetrics receiver), and at least one sample of `k8s_deployment_available` (from the metrics-cluster-agent's k8s_cluster receiver), within two scrape intervals (30s) of the agents becoming Ready.

#### Scenario: Per-node kubeletstats metric is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries the obs prometheus via grafana Explore: `k8s_node_cpu_utilization`
- **THEN** at least one series is returned with a `k8s_node_name` label matching the cluster's node

#### Scenario: hostmetrics scraper output is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries `system_memory_usage{state="used"}`
- **THEN** at least one series is returned with a `host_name` label matching the cluster's node

#### Scenario: k8s_cluster cluster-state metric is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries `k8s_deployment_available{k8s_deployment_name="backend"}`
- **THEN** exactly one series is returned with a value of `1` (the backend deployment is healthy)

### Requirement: A `cluster-overview` dashboard is provisioned in obs grafana

A grafana dashboard JSON file at `infra/k8s-obs/base/grafana/dashboards/cluster-overview.json` SHALL render rows of panels for nodes, pods, workloads, and PVCs. The dashboard SHALL be loaded automatically via the slice-17 grafana chart's provisioning path so an operator opening obs grafana sees it under Dashboards without manual import.

Panel coverage SHALL include at minimum:
- Node CPU utilization per node (gauge or time-series)
- Node memory used/available per node
- Node load1/load5/load15 per node
- Node disk used % per mountpoint
- Node network rx/tx bytes/sec per node
- Per-namespace pod CPU usage (time-series, summed by namespace)
- Per-namespace pod memory working-set (time-series, summed by namespace)
- Deployment desired vs available replicas (stat panel with thresholds)
- Pod phase distribution (stacked bar)
- Container restart count over the last 1h (expected 0)
- PVC phase / used %

All panel PromQL SHALL target OTel-translated metric names (e.g. `k8s_node_cpu_utilization`, `k8s_pod_memory_working_set`, `k8s_deployment_available`), NOT cAdvisor names (`container_cpu_usage_seconds_total`).

#### Scenario: Dashboard file exists

- **WHEN** a reader runs `ls infra/k8s-obs/base/grafana/dashboards/cluster-overview.json`
- **THEN** the file exists and is valid JSON

#### Scenario: Dashboard visible in obs grafana

- **WHEN** the obs cluster has applied the slice's manifests
- **AND** an operator opens obs grafana at the slice-17 published host port
- **AND** navigates to Dashboards → Browse
- **THEN** a dashboard titled `Cluster overview` is listed without manual import

#### Scenario: Dashboard PromQL targets OTel-translated names

- **WHEN** a reader greps the dashboard JSON for `"expr":`
- **THEN** the expressions reference families starting with `k8s_`, `container_`, or `system_`
- **AND** no expression references `container_cpu_usage_seconds_total` or other Docker-cAdvisor families

### Requirement: A `just` recipe surface drives the metrics-agent and metrics-cluster-agent lifecycle

The repository-root `justfile` SHALL declare four new recipes:

- `metrics-agent-logs`: tail logs from the metrics-agent DaemonSet's pods (follow).
- `metrics-agent-rollout`: restart the metrics-agent DaemonSet and wait on rollout status with a 60s timeout.
- `metrics-cluster-agent-logs`: tail logs from the metrics-cluster-agent Deployment's pod (follow).
- `metrics-cluster-agent-rollout`: restart the metrics-cluster-agent Deployment and wait on rollout status with a 60s timeout.

The recipes SHALL mirror the slice-20 `log-agent-logs` and `log-agent-rollout` recipe shape (same `kubectl` flags, same namespace variable, same timeout) so the four agents (gateway collector, log-agent, metrics-agent, metrics-cluster-agent) share one operator vocabulary.

#### Scenario: Four recipes exist with the expected shape

- **WHEN** a reader runs `just --list`
- **THEN** the list contains `metrics-agent-logs`, `metrics-agent-rollout`, `metrics-cluster-agent-logs`, `metrics-cluster-agent-rollout`

#### Scenario: Rollout recipes wait on status

- **WHEN** a reader inspects the recipe body
- **THEN** the body contains both `kubectl rollout restart` and `kubectl rollout status` with a `--timeout=60s` flag

### Requirement: The Hetzner overlay declares a commented stub for the cluster-metrics agents

The Hetzner overlay at `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL declare a commented block alongside the existing slices' stubs naming the production-side concerns for slice 21: multi-node toleration considerations, leader election for `k8s_cluster` on multi-node clusters, kubelet TLS verification (the local-overlay `insecure_skip_verify: true` MUST NOT be inherited), resource cap re-sizing for a busier cluster, and prometheus PVC / retention re-sizing alongside the higher cluster-metric volume. The stub SHALL be comments only — no live patches.

#### Scenario: Hetzner stub names the production concerns

- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains a commented block whose header references `slice 21` or `add-k3s-cluster-metrics`
- **AND** the block names at least: multi-node tolerations, leader election, kubelet TLS verification, resource caps, prometheus retention sizing

### Requirement: README documents the cluster metrics path

The repository README SHALL gain a "Cluster metrics" subsection under the local observability narrative naming the two new agents, the apply order, and the expected end-to-end loop (apply → wait one scrape interval → cluster-overview dashboard populates in obs grafana). The subsection SHALL reference the agent/gateway pattern's continuity with slice 20 and SHALL name the OTel-receiver-side choice over prometheus chart-side scrape jobs.

#### Scenario: README subsection exists

- **WHEN** a reader greps the README for a heading containing `Cluster metrics` (case-insensitive)
- **THEN** exactly one such heading is found
- **AND** the section names both `metrics-agent` and `metrics-cluster-agent`
- **AND** the section names the agent → gateway → obs prometheus path
