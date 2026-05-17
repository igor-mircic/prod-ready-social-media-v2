## Why

After slice 18b, the obs cluster's Loki has been ready to receive logs — the obs collector's `otlphttp/loki` exporter, the grafana Loki datasource, and the cross-cluster mTLS envelope (slice 19) are all in place. After slice 18c, browser FE error logs already flow end-to-end through that pipe. But the second (and louder) log source — the in-cluster Spring backend's structured JSON via `kubectl logs deploy/backend` — has nowhere to go: the existing app collector's logs pipeline carries an explicit `filter/frontend_only` processor that drops every record whose `service.name` is not `frontend`. README §"Forward arc" line 457 names this exact slice (slice 20, `add-k3s-pod-log-shipping`) as the moment node-local pod logs join the same transport spine, closing the data-plane gap for the second of three signal types before slice 21 closes the third (metrics).

Doing it now means slice 20 plugs into a fully-built transport: one new DaemonSet on the app cluster, one renamed filter at the existing gateway, zero changes on the obs side. The agent/gateway pattern this slice introduces is also the shape slice 21 will reuse for cluster metrics — getting the pattern right once amortizes across two slices.

## What Changes

- **New DaemonSet `log-agent` at `infra/k8s/base/log-agent/`** in the `social` namespace, one pod per node, running the same `otel/opentelemetry-collector-contrib:0.111.0` image the rest of the project pins. The pod's config declares:
  - A `filelog` receiver tailing `/var/log/pods/social_*/*/*.log` (CRI / containerd format on k3s), plus `/var/log/pods/social_log-agent-*/*/*.log` so the shipper can observe itself. Other namespaces (`kube-system`, `default`, `observability` — which doesn't exist on this cluster anyway but kept explicit for clarity) are NOT tailed in this slice. Scope can widen in a later slice without changing the transport.
  - An `operators:` chain on the filelog receiver that (a) strips the CRI envelope, (b) detects whether the body parses as JSON (backend pods do, frontend nginx pods don't), and (c) for JSON-shaped bodies, promotes the inner fields to log-record attributes (timestamp, severity, message, MDC keys like `trace.id` / `span.id`). For non-JSON bodies the raw text becomes `body` and severity stays unset.
  - A `k8sattributes` processor enriching every record with `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`, and the workload-level `app.kubernetes.io/name` label. Uses `auth_type: serviceAccount` against the pod's mounted token.
  - A `batch` processor and an `otlp` exporter pointing at `collector.social.svc.cluster.local:4317` (gRPC, plaintext, in-cluster).
  - One logs pipeline: `filelog → k8sattributes → batch → otlp/gateway`. No traces or metrics pipeline.
- **New ServiceAccount + ClusterRole + ClusterRoleBinding** at `infra/k8s/base/log-agent/rbac.yaml` granting the agent's pod identity read access to `pods`, `namespaces`, and `replicasets` (the apiGroups/resources `k8sattributes` documents as the minimum for its standard extraction set). The binding is cluster-scoped because the processor enriches records for any pod, not just pods in `social`.
- **DaemonSet pod-spec details**: `hostNetwork: false`, `hostPID: false`, `tolerations:` set to tolerate the control-plane taint (one-node k3s cluster — without this, the DaemonSet skips the only node), `nodeSelector:` empty. The container `volumeMounts:` mount the host's `/var/log/pods` read-only at the same path, plus the `config` ConfigMap at `/etc/otelcol-contrib/`. Resource requests `cpu=50m`, `memory=128Mi`; limits `cpu=200m`, `memory=256Mi`.
- **App collector ConfigMap update at `infra/k8s/base/collector/configmap.yaml`**: the `filter/frontend_only` processor is renamed to `filter/exclude_observability_self` and its OTTL is rewritten. New behavior: drop log records whose `resource.attributes["k8s.namespace.name"] == "observability"` (defence-in-depth against feedback loops in case future scope adds tailing of the obs namespace — today none, but the filter is the cheap insurance). The processor stays in the logs pipeline's `processors:` list, in the same position; the rest of the pipeline (`batch`, `transform/redact-path-ids`, then dual-write to `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs`) is unchanged.
- **App collector receiver remains unchanged**: the `otlp` receiver already accepts gRPC on `:4317`, which is what the DaemonSet uses; no new receiver needed.
- **Backend image / chart values UNCHANGED**: the backend already emits structured JSON to stdout via logback (slice-2). The filelog receiver picks it up off the node's pod-log file with no app-side change.
- **justfile gains `log-agent-logs` and `log-agent-rollout` recipes**, mirroring the `collector-*` recipe convention from slice 18a. `log-agent-rollout` issues `kubectl rollout restart daemonset/log-agent -n social` and waits on `rollout status`.
- **Hetzner overlay stub at `infra/k8s/overlays/hetzner/kustomization.yaml`** gains a commented note naming the production-side concerns for the agent (multi-node tolerations, resource caps tuned to the prod box's node count, optional namespace scope widening, structured-log volume implications for the obs cluster's Loki retention). Comments only — no live resources.
- **README "Local observability" section** gains a "k3s pod log shipping" subsection naming the agent's scope, the apply order (`just k8s-apply` already covers it once the base kustomization lists `./log-agent`), and the expected end-to-end loop (apply → trigger a backend request → log line visible in obs grafana Explore → Loki).
- **NON-GOALS** (called out explicitly so a future slice has a clean handoff):
  - Tailing logs from `kube-system`, `default`, or the obs cluster (slice 20 is social-only; widening scope is a future concern).
  - Metrics pipeline (slice 21).
  - Loki retention / index tuning (chart defaults stay).
  - Log-based alerting (future alerting slice).
  - Shipping audit logs, container runtime logs, or kernel logs (out of scope; this is application pod logs).
  - Per-container log-format negotiation beyond JSON-vs-text autodetect (postgres and nginx pods land as raw text; that's acceptable — operators querying them in Loki use full-text search instead of structured filters).

## Capabilities

### New Capabilities

None. This slice extends the existing `kubernetes` capability rather than introducing a new one.

### Modified Capabilities

- `kubernetes`: New requirement for the log-agent DaemonSet, its RBAC, its filelog/k8sattributes pipeline shape, and the justfile recipe surface. Modified requirement on the app collector's logs pipeline — the `filter/frontend_only` processor's name and OTTL change to `filter/exclude_observability_self`.

## Impact

- **Code / manifests**: New directory `infra/k8s/base/log-agent/` (kustomization, daemonset, configmap, serviceaccount, rbac). Modified `infra/k8s/base/collector/configmap.yaml` (filter rename + OTTL rewrite). Modified `infra/k8s/base/kustomization.yaml` (`resources:` list gains `./log-agent`). Modified `infra/k8s/overlays/hetzner/kustomization.yaml` (commented stub). Modified `justfile` (two recipes). Modified `README.md`.
- **No app-side code change**: backend logback config and frontend nginx config are untouched.
- **No new images**: reuses the contrib collector pin that's already mirrored into the local registry pull path via the existing k3s install script — except the DaemonSet image goes through the default Docker Hub pull path (the local-registry mirror is for *project* images, not third-party). This matches the existing `collector` Deployment which already pulls `otel/opentelemetry-collector-contrib:0.111.0` from upstream.
- **No new cert material**: the agent → gateway hop is in-cluster plaintext; the cross-cluster mTLS envelope (slice 19) stays exactly where it is, on the gateway → obs collector hop.
- **CI impact**: None. CI runs the e2e harness against compose, not against the local k3s cluster.
- **Backwards-compatibility impact**: The renamed filter at the gateway is the only existing-behavior change. Browser FE error logs continue to flow into Loki (they still pass through the renamed filter because they originate from a request whose `resource.attributes["k8s.namespace.name"]` is unset, not `observability`). Operators with pinned manifests will re-render via `kustomize build` and see one renamed processor — no data drop, no schema change.
- **Resource impact on local Lima VM**: one extra pod (`log-agent`) per node = +50m CPU request, +128Mi memory request. Fits inside the 8 GiB VM envelope alongside the existing postgres, backend, frontend, and gateway collector pods (current pre-slice headroom is ~6 GiB).
- **Loki storage impact**: backend pod logs are structured JSON, ~200-500 bytes per record after attribute extraction, ~5-20 records per HTTP request at INFO level. At local-dev request volume (manual testing + e2e harness when run) this is negligible against the obs Loki's 5Gi PVC. A future Hetzner slice will revisit retention.
- **Backout**: Single revert. Pre-slice-20 state has the gateway's `filter/frontend_only` in place and no log-agent DaemonSet; reverting removes the DaemonSet + RBAC + base kustomization entry and restores the gateway's old filter. No data migration. The obs Loki keeps any logs already shipped (they sit in storage until TTL).
