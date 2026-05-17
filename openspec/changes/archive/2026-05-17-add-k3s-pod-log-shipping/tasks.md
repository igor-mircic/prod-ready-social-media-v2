## 1. Gateway collector — rename and re-scope the logs-pipeline filter

- [x] 1.1 In `infra/k8s/base/collector/configmap.yaml`, rename the `filter/frontend_only` processor entry under `processors:` to `filter/exclude_observability_self`.
- [x] 1.2 Rewrite the new processor's OTTL to drop log records whose `resource.attributes["k8s.namespace.name"] == "observability"` (replacing the old `service.name != "frontend"` clause).
- [x] 1.3 Update the `service.pipelines.logs.processors` list to use the new processor name in the same position (`[batch, transform/redact-path-ids, filter/exclude_observability_self]`).
- [x] 1.4 Apply via `just k8s-apply` and confirm `just collector-logs` shows the new pipeline boots without errors.
- [x] 1.5 Verify browser FE error logs still land in obs grafana → Explore → Loki for `service.name=frontend` (regression check on slice-18c flow).

## 2. log-agent base directory — scaffold the manifest set

- [x] 2.1 Create `infra/k8s/base/log-agent/` directory.
- [x] 2.2 Create `infra/k8s/base/log-agent/kustomization.yaml` with `resources:` listing the five files (`daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, `rbac.yaml`) and a `labels:` block setting `app.kubernetes.io/name: log-agent`.
- [x] 2.3 Create `infra/k8s/base/log-agent/serviceaccount.yaml` declaring a `ServiceAccount` named `log-agent` in namespace `social`.
- [x] 2.4 Create `infra/k8s/base/log-agent/rbac.yaml` declaring a `ClusterRole` with `get`/`list`/`watch` on `pods`, `namespaces`, `replicasets`, plus a `ClusterRoleBinding` binding the role to the `log-agent` ServiceAccount in `social`.
- [x] 2.5 Append `./log-agent` to `infra/k8s/base/kustomization.yaml` `resources:` list (alongside `./postgres`, `./backend`, `./frontend`, `./collector`).

## 3. log-agent ConfigMap — declare the filelog → k8sattributes → otlp pipeline

- [x] 3.1 Create `infra/k8s/base/log-agent/configmap.yaml` declaring a `ConfigMap` named `log-agent-config` with a single data key `config.yaml`.
- [x] 3.2 Inside `config.yaml`, declare the `filelog` receiver with `include: [/var/log/pods/social_*/*/*.log]` and `start_at: beginning`.
- [x] 3.3 Declare the filelog `operators:` chain: CRI envelope strip → `router` on JSON-shaped body (predicate: starts with `{` after whitespace) → `json_parser` with `on_error: send_quiet` on the JSON branch.
- [x] 3.4 In the JSON branch, promote `timestamp` → record timestamp, `level` → severity, `message` → body, and normalize MDC keys `trace.id` / `span.id` to the underscored `trace_id` / `span_id` log-record fields Grafana expects for trace-to-logs correlation.
- [x] 3.5 Declare the `k8sattributes` processor with `auth_type: serviceAccount` and `extract.metadata` covering `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`; `extract.labels` covering `app.kubernetes.io/name`.
- [x] 3.6 Declare the `batch` processor.
- [x] 3.7 Declare the `otlp` exporter with `endpoint: collector.social.svc.cluster.local:4317` and `tls.insecure: true`.
- [x] 3.8 Declare the `health_check` extension and register it in `service.extensions:`.
- [x] 3.9 Declare the single `logs` pipeline: `receivers: [filelog]`, `processors: [k8sattributes, batch]`, `exporters: [otlp]`. No traces, no metrics pipeline.

## 4. log-agent DaemonSet — pod-spec and probes

- [x] 4.1 Create `infra/k8s/base/log-agent/daemonset.yaml` declaring a `DaemonSet` named `log-agent` in namespace `social`.
- [x] 4.2 Set `spec.template.spec.serviceAccountName: log-agent`.
- [x] 4.3 Declare `tolerations:` with one entry `operator: Exists` (covers the control-plane taint and any future worker-node taints).
- [x] 4.4 Declare the container `image: otel/opentelemetry-collector-contrib:0.111.0` and `args: ["--config=/etc/otelcol-contrib/config.yaml"]`.
- [x] 4.5 Declare a `containerPort` named `healthcheck` on port `13133`.
- [x] 4.6 Declare a `livenessProbe` with `httpGet.port: healthcheck, path: /` and a `readinessProbe` with the same target.
- [x] 4.7 Declare resource requests `cpu=50m, memory=128Mi` and limits `cpu=200m, memory=256Mi`.
- [x] 4.8 Declare a `hostPath` volume `varlogpods` with `path: /var/log/pods` and mount it at `/var/log/pods` `readOnly: true` in the container.
- [x] 4.9 Declare a `configMap` volume named `config` referencing `log-agent-config` and mount it at `/etc/otelcol-contrib/` in the container.

## 5. justfile — log-agent recipes

- [x] 5.1 Add a `log-agent-logs` recipe to the root `justfile` that runs `kubectl logs -n social -l app.kubernetes.io/name=log-agent --tail=200 -f` (or DaemonSet-targeted equivalent).
- [x] 5.2 Add a `log-agent-rollout` recipe that runs `kubectl rollout restart daemonset/log-agent -n social` followed by `kubectl rollout status daemonset/log-agent -n social --timeout=120s`.
- [x] 5.3 Verify `just --list` enumerates both new recipes with one-line descriptions.

## 6. Hetzner overlay stub

- [x] 6.1 Open `infra/k8s/overlays/hetzner/kustomization.yaml`.
- [x] 6.2 Append a commented stub naming what the Hetzner-deploy slice will add for the log-agent: multi-node resource caps, optional namespace-scope widening (with Loki retention review), structured-log volume implications for the obs Loki PVC sizing.
- [x] 6.3 Confirm no live resources are added in this slice's hetzner overlay edit.

## 7. README documentation

- [x] 7.1 Locate the "Local observability" / "Log shipping" tree in `README.md`.
- [x] 7.2 Add a new "k3s pod log shipping" subsection naming the agent's namespace scope (`social` only), the apply behavior, the end-to-end loop, and trace-to-logs correlation in grafana.
- [x] 7.3 Add an explicit non-goals paragraph: no `kube-system`/`default` scope, no audit logs, no log-based alerting, no retention tuning.
- [x] 7.4 Update the "Forward arc" section so slice 20 is marked done.

## 8. End-to-end verification on the local mirror

- [x] 8.1 Run `just vm-up && just obs-up` (or confirm both already up).
- [x] 8.2 Run `just k8s-apply` and watch `kubectl get pods -n social` until `log-agent-*` reaches `Ready 1/1`.
- [x] 8.3 Tail `just log-agent-logs` in a side terminal; confirm filelog opens files matching `/var/log/pods/social_*/*/*.log` without parser errors.
- [x] 8.4 In another terminal: `just backend-forward` and issue a request that the backend logs at INFO (e.g. health check or any authenticated endpoint).
- [x] 8.5 Capture the exact log line from `kubectl logs deploy/backend -n social --tail=1`.
- [x] 8.6 Open `just obs-grafana`, navigate Explore → Loki, query `{k8s_namespace_name="social", k8s_container_name="backend"}`.
- [x] 8.7 Confirm the log line from step 8.5 appears within 30 seconds; spot-check `trace_id`, `span_id`, `k8s_pod_name`, `k8s_node_name` attributes are populated.
- [x] 8.8 Click trace correlation on a Loki entry; confirm grafana navigates to the matching Tempo trace.
- [x] 8.9 Regression check: trigger a browser FE error and confirm it still appears in obs grafana → Loki for `service.name=frontend` (filter rename did not break the slice-18c path).
- [x] 8.10 Regression check: open compose grafana on `:3000` and confirm backend pod logs ALSO land there via the `otlphttp/compose-relay-logs` dual-write leg.

## 9. OpenSpec — validate and capture

- [x] 9.1 Run `openspec validate add-k3s-pod-log-shipping --strict` and confirm no errors.
- [ ] 9.2 Commit the implementation against the proposal branch (one commit per logical group: gateway-filter rename; log-agent manifests; configmap; daemonset; justfile + README).
- [ ] 9.3 Open the PR and watch CI; iterate on failures until green.
- [ ] 9.4 Archive the change via `openspec archive add-k3s-pod-log-shipping`.
- [ ] 9.5 Re-watch CI post-archive merge to confirm the spec sync is clean.
