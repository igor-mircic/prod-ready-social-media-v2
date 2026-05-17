## 1. metrics-agent DaemonSet (kubeletstats + hostmetrics)

- [x] 1.1 Create directory `infra/k8s/base/metrics-agent/` with files `kustomization.yaml`, `daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, `rbac.yaml`
- [x] 1.2 Write `serviceaccount.yaml` declaring `ServiceAccount/metrics-agent` in `social` namespace
- [x] 1.3 Write `rbac.yaml` declaring `ClusterRole/metrics-agent` with read-only verbs on `nodes`, `nodes/stats`, `nodes/proxy`, `nodes/metrics` (core apiGroup) plus a `ClusterRoleBinding/metrics-agent` to the ServiceAccount in `social`
- [x] 1.4 Write `configmap.yaml` declaring `ConfigMap/metrics-agent-config` with: `kubeletstats` receiver (`https://${NODE_NAME}:10250`, `auth_type: serviceAccount`, `insecure_skip_verify: true`, 15s interval), `hostmetrics` receiver (`root_path: /hostfs`, scrapers: cpu, memory, load, disk, filesystem, network, paging, processes, 15s interval), `batch` processor, `otlp` exporter to `collector.social.svc.cluster.local:4317` plaintext, `health_check` extension on `0.0.0.0:13133`, single `metrics:` pipeline
- [x] 1.5 Write `daemonset.yaml` declaring `DaemonSet/metrics-agent` with: image `otel/opentelemetry-collector-contrib`, args `--config=/etc/otelcol-contrib/config.yaml`, `tolerations: [{operator: Exists}]`, env `NODE_NAME` from `spec.nodeName` downward API, hostPath mount of `/` read-only at `/hostfs`, configmap mount at `/etc/otelcol-contrib`, named port `healthcheck:13133`, liveness+readiness `httpGet :healthcheck`, resources `requests cpu=50m mem=128Mi / limits cpu=200m mem=256Mi`
- [x] 1.6 Write `kustomization.yaml` referencing the four manifests above and the `images:` directive resolving `otel/opentelemetry-collector-contrib:0.111.0` (mirroring the slice-20 log-agent kustomization pattern)
- [x] 1.7 Append `./metrics-agent` to the `resources:` list in `infra/k8s/base/kustomization.yaml`

## 2. metrics-cluster-agent Deployment (k8s_cluster)

- [x] 2.1 Create directory `infra/k8s/base/metrics-cluster-agent/` with files `kustomization.yaml`, `deployment.yaml`, `configmap.yaml`, `serviceaccount.yaml`, `rbac.yaml`
- [x] 2.2 Write `serviceaccount.yaml` declaring `ServiceAccount/metrics-cluster-agent` in `social` namespace
- [x] 2.3 Write `rbac.yaml` declaring `ClusterRole/metrics-cluster-agent` with read-only verbs on the resource kinds the `k8s_cluster` contrib receiver documents (events, namespaces[+/status], nodes[+/status], persistentvolumeclaims, persistentvolumes, pods[+/status], replicationcontrollers[+/status], resourcequotas, services in core; daemonsets, deployments, replicasets, statefulsets in apps; daemonsets, deployments, replicasets in extensions; jobs, cronjobs in batch; horizontalpodautoscalers in autoscaling) plus a `ClusterRoleBinding/metrics-cluster-agent` to the ServiceAccount in `social`
- [x] 2.4 Write `configmap.yaml` declaring `ConfigMap/metrics-cluster-agent-config` with: `k8s_cluster` receiver (`auth_type: serviceAccount`, `collection_interval: 15s`, `node_conditions_to_report: [Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]`), `batch` processor, `otlp` exporter to `collector.social.svc.cluster.local:4317` plaintext, `health_check` extension on `0.0.0.0:13133`, single `metrics:` pipeline
- [x] 2.5 Write `deployment.yaml` declaring `Deployment/metrics-cluster-agent` with `replicas: 1`, NO `tolerations:` and NO `nodeSelector:`, configmap mount, named port `healthcheck:13133`, liveness+readiness probes, resources `requests cpu=50m mem=128Mi / limits cpu=200m mem=256Mi`
- [x] 2.6 Write `kustomization.yaml` referencing the four manifests above and the `images:` directive resolving `otel/opentelemetry-collector-contrib:0.111.0`
- [x] 2.7 Append `./metrics-cluster-agent` to the `resources:` list in `infra/k8s/base/kustomization.yaml`

## 3. Obs grafana cluster-overview dashboard

- [x] 3.1 Inspect `infra/k8s-obs/base/grafana/values.yaml` and the slice-17 chart's existing `custom-dashboard.json` provisioning shape (sidecar / `extraConfigmapMounts` / `dashboardProviders+dashboards` block) — identify the exact mechanism so the new dashboard reuses it
- [x] 3.2 Create `infra/k8s-obs/base/grafana/dashboards/cluster-overview.json` (the directory if not present), targeting the obs Prometheus datasource by UID
- [x] 3.3 Author panels using OTel-translated metric names: Node row (`k8s_node_cpu_utilization`, `k8s_node_memory_usage`, load1/5/15 via `system_cpu_load_average_*m`, `system_filesystem_usage`, `system_network_io`), Pod row (per-namespace sums of `k8s_pod_cpu_utilization` and `k8s_pod_memory_working_set`, top-N), Workload row (`k8s_deployment_available`/`_desired` stat panels, `k8s_pod_phase` stacked, `k8s_container_restarts` over 1h), PVC row (`k8s_persistentvolumeclaim_phase`, used %)
- [x] 3.4 Wire the new dashboard into the chart's provisioning per the mechanism identified in 3.1 (no new sidecar, no competing pattern)
- [x] 3.5 Apply to local obs cluster, open obs grafana, verify the dashboard appears under Dashboards → Browse without manual import

## 4. Obs prometheus values.yaml comment rewrite

- [x] 4.1 Read `infra/k8s-obs/base/prometheus/values.yaml` and identify every line containing `slice 21`, `add-k3s-cluster-metrics`, `kube-state-metrics`, `node-exporter`, or `scrape configs` references that were forward-looking guesses
- [x] 4.2 Rewrite the comment block (lines around 6, 10-11, 59-60, 77-80 per current file) so it names the slice-21 OTel-receiver-side path (metrics-agent + metrics-cluster-agent shipping via the gateway's remote-write to this prom) as the replacement for the kube-state-metrics / node-exporter subcharts and as the data path that obviates the default scrape jobs
- [x] 4.3 Verify no `enabled:` key changes value — runtime config stays byte-identical, only comment text is touched

## 5. Hetzner overlay stub

- [x] 5.1 Append a slice-21 commented block to `infra/k8s/overlays/hetzner/kustomization.yaml` alongside the existing slice-15..20 stubs
- [x] 5.2 The block SHALL name: multi-node tolerations review for metrics-agent, leader election for metrics-cluster-agent on multi-node prod (k8s_leader_elector extension + bump to `replicas: 2`), kubelet TLS verification (drop `insecure_skip_verify: true`, pin a CA), resource cap re-sizing for a busier cluster, prometheus PVC and retention re-sizing alongside cluster-metric volume

## 6. justfile recipes

- [x] 6.1 Add `metrics-agent-logs` recipe to `justfile` (mirroring `log-agent-logs` shape): `kubectl logs -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=metrics-agent --tail=200 -f`
- [x] 6.2 Add `metrics-agent-rollout` recipe: `kubectl rollout restart daemonset/metrics-agent -n {{PG_NAMESPACE}}` then `kubectl rollout status daemonset/metrics-agent -n {{PG_NAMESPACE}} --timeout=60s`
- [x] 6.3 Add `metrics-cluster-agent-logs` recipe: same shape but `-l app.kubernetes.io/name=metrics-cluster-agent`
- [x] 6.4 Add `metrics-cluster-agent-rollout` recipe: same shape but `deploy/metrics-cluster-agent` instead of `daemonset/`
- [x] 6.5 Add a slice-21 header comment block before the four recipes (mirroring the slice-20 `=== Slice 20 ===` header)

## 7. README "Cluster metrics" subsection

- [x] 7.1 Add a "Cluster metrics" subsection under the existing "Local observability" narrative, after the slice-20 "k3s pod log shipping" subsection
- [x] 7.2 The subsection SHALL name both agents, the apply order (`just k8s-apply` covers it once the base kustomization lists them), the OTel-receiver-side choice over prometheus chart-side scrape jobs, the agent → gateway → obs prometheus path, and the expected end-to-end loop (apply → wait one scrape interval → cluster-overview dashboard populates)
- [x] 7.3 Mark slice 21 as `(done)` in the README §"Forward arc" list so future readers can grep the progress at-a-glance (matches slice-20's `(done)` marker on line 458)

## 8. End-to-end verification

- [x] 8.1 Apply: `just k8s-apply`
- [x] 8.2 Wait for `kubectl -n social get pods -l 'app.kubernetes.io/name in (metrics-agent, metrics-cluster-agent)'` to show all pods Ready
- [x] 8.3 In obs grafana → Explore → Prometheus, run `k8s_node_cpu_utilization_ratio` and confirm at least one series with a `k8s_node_name` label (the `_ratio` suffix is the prometheusremotewrite exporter's OpenMetrics-conformant unit suffix on the OTel `k8s.node.cpu.utilization` metric)
- [x] 8.4 In obs grafana → Explore, run `system_memory_usage_bytes{state="used"}` and confirm at least one series with a `host_name` label matching the cluster's node
- [x] 8.5 In obs grafana → Explore, run `k8s_deployment_available{k8s_deployment_name="backend"}` and confirm one series with value `1`
- [x] 8.6 Open obs grafana → Dashboards → Browse, click "Cluster overview", confirm every panel renders without "No data" except the "Container restart count" panel (which is expected to read 0 on a healthy cluster)
- [x] 8.7 Run `just metrics-agent-logs` and `just metrics-cluster-agent-logs` for ~5s each; confirm no `error` / `panic` lines
- [x] 8.8 Run `just metrics-agent-rollout` and `just metrics-cluster-agent-rollout`; confirm both return successfully within the 60s timeout

## 9. OpenSpec strict validation

- [x] 9.1 Run `openspec validate add-k3s-cluster-metrics --strict` and confirm clean exit
- [x] 9.2 Fix any validation findings, re-run, repeat until clean

## 10. Commit the implementation

- [ ] 10.1 Stage all new and modified files
- [ ] 10.2 Create a commit titled `Implement add-k3s-cluster-metrics (slice 21)` following the repo's existing slice-implementation commit shape
- [ ] 10.3 Push and open the PR with the standard repo PR template
- [ ] 10.4 After CI passes, archive the change with `openspec archive add-k3s-cluster-metrics` (per the `feedback_openspec_apply_autonomous_to_merge` memory: drive commit → push → PR → watch CI → archive → re-watch CI without prompting; ask only at merge time)
