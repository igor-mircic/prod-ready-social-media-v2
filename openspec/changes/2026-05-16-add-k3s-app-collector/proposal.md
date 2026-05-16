## Why

Slice 17 (`add-local-k3s-obs-cluster`) stood up the second Lima VM with an empty LGTM stack. The arc's next step — bridging the app cluster's telemetry into the obs cluster's grafana — was originally planned as a single slice ("`add-k3s-app-collector`": collector pod in app cluster + cross-cluster export + obs grafana datasources). On closer reading that one bullet packed three architecturally independent decisions (cross-VM transport, browser OTLP path, BE log path) and ~30 file touches across six directories. Splitting buys real value: each piece becomes independently revertable, the cross-cluster transport decision is isolated from the data-plane refactor, and the FE→BE trace-propagation gap flagged on slice 16 has a clean diagnostic window between the splits.

This is **the first of three splits**: the app cluster gets its own collector pod, the backend's OTLP target flips from `host.lima.internal:4318` (transitional shim) to an in-cluster ClusterIP Service, and the collector pod relays traces unchanged to the still-in-compose collector for tempo ingestion. No data crosses a cluster boundary yet. No browser change yet. No obs-cluster cutover yet. The host docker-compose collector keeps running and keeps doing everything it does today; this slice introduces a new hop *inside* the app cluster, then exits via the same `host.lima.internal:4317` bridge the backend was using directly. End state: visibility is identical to today, but the topology is one step closer to "BE has no concept of the host."

A future `bridge-collectors-to-obs-cluster` slice (18b) replaces the app collector's exporter target with the obs cluster's receiver. A subsequent `route-browser-otlp-through-nginx` slice (18c) flips the browser's OTLP path to same-origin via the FE pod's nginx. Slice 19+ (`add-cross-cluster-mtls`, `add-k3s-pod-log-shipping`, `add-k3s-cluster-metrics`, `retire-compose-observability`, `add-hetzner-deploy`) follow the slice 17 design doc unchanged.

## What Changes

- **New `infra/k8s/base/collector/` Kustomize directory** containing:
  - `kustomization.yaml` listing the slice's resources, default labels (`app.kubernetes.io/name=collector`), and the image tag pinned in one place.
  - `deployment.yaml` — single-replica `collector` Deployment. Image `otel/opentelemetry-collector-contrib:0.111.0` (same pin as compose). Args `--config=/etc/otelcol-contrib/config.yaml`. ContainerPorts `4317` (otlp-grpc) and `4318` (otlp-http). The config ConfigMap is mounted read-only at `/etc/otelcol-contrib/`. Resource requests `cpu=50m / memory=128Mi`; limits `cpu=500m / memory=256Mi`. Liveness/readiness probes against the collector's bundled `:13133/` health-check extension. No startupProbe — the collector starts in under a second.
  - `service.yaml` — ClusterIP Service named `collector` in the `social` namespace, exposing port `4317` (otlp-grpc) → targetPort `otlp-grpc` and port `4318` (otlp-http) → targetPort `otlp-http`. No LoadBalancer, no NodePort: only the in-cluster backend dials this Service.
  - `configmap.yaml` — declares the collector pipeline. Receivers `otlp` (gRPC `:4317` and HTTP `:4318`, NO CORS — only in-cluster pods reach it). Processors `batch` and `transform/redact-path-ids` (the OTTL statements from `infra/observability/collector/collector-config.yaml` mirrored verbatim — same redactions on UUID, opaque-hex, and numeric path segments over `span.name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full`). One exporter `otlp/compose-relay` pointing at `host.lima.internal:4317` (the compose collector's published OTLP/gRPC port) with `tls.insecure: true`. One traces pipeline. **No metrics pipeline** (the OTel Java agent has `OTEL_METRICS_EXPORTER=none` per the observability spec; metrics are Prometheus pull). **No logs pipeline** (BE-in-k3s does not write to host-mounted log files; slice 20 owns pod log shipping via a DaemonSet).
- **`infra/k8s/base/kustomization.yaml` updated** to include `./collector` alongside the existing `./postgres`, `./backend`, `./frontend`.
- **`infra/k8s/base/backend/deployment.yaml` env update** — `OTEL_EXPORTER_OTLP_ENDPOINT` flips from `http://host.lima.internal:4318` to `http://collector.social.svc.cluster.local:4318`. The agent's other `OTEL_*` vars are unchanged.
- **`infra/k8s/overlays/local/kustomization.yaml`** — no patch needed for the collector (no image-tag iteration story; the image is a pinned public tag). Backend's existing `imagePullPolicy: Always` patch is unchanged.
- **`infra/k8s/overlays/hetzner/kustomization.yaml`** gains a commented stub block listing what the Hetzner deploy will add for the collector: production resource caps, the cross-cluster exporter endpoint (the eventual obs-cluster Service), TLS material reference, and tighter probe timings. Comments only — no live resources.
- **`justfile`** gains two recipes mirroring the existing `backend-*` / `frontend-*` shape:
  - `collector-logs` — `kubectl logs -n social deploy/collector -f` for quick verification that the pipeline is healthy and spans are flowing through.
  - `collector-rollout` — `kubectl rollout restart deploy/collector -n social` for picking up ConfigMap changes (Kubernetes does not auto-restart pods when a mounted ConfigMap is edited; the rollout-restart is the documented pattern).
- **`README.md`** gains a short subsection under "Run the backend in cluster (optional)" titled "Collector relay (in-cluster)" describing the new hop, the transitional `host.lima.internal:4317` exporter target, and the explicit non-goal that the obs cluster is NOT yet wired in. The "Local observability" section's BE-in-k3s narrative is updated to reflect that BE no longer dials `host.lima.internal:4318` directly.

Explicit non-goals:

- **No data crosses the app-cluster / obs-cluster boundary.** The new in-cluster collector's only exporter points at the compose collector via `host.lima.internal:4317`. Obs-cluster collector receiver, obs-grafana datasource provisioning, and the cross-VM network decision are all in the next slice (`bridge-collectors-to-obs-cluster`).
- **No browser OTLP path change.** The FE bundle still bakes `VITE_OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces`; the browser still POSTs directly to the compose collector cross-origin (CORS allowlist for `:13000` from slice 16 is unchanged). The FE pod's nginx config is untouched. Browser-side trace shipping moves in the third sub-slice (`route-browser-otlp-through-nginx`).
- **No backend metrics path change.** Backend metrics continue to be Prometheus pull against `/actuator/prometheus`; the in-cluster collector has no metrics pipeline. The pre-existing gap that compose Prometheus does not reach in-cluster backends (slice 15 inherited) remains as-is; slice 21 (`add-k3s-cluster-metrics`) addresses it.
- **No backend log path change.** BE-in-k3s pod logs continue to live on stdout / `kubectl logs`, not in compose loki — same as today. Slice 20 (`add-k3s-pod-log-shipping`) introduces the DaemonSet that solves this.
- **No removal of `host.lima.internal:4317` reachability.** The compose collector's host-published port `4317` is what the new in-cluster collector dials; the slice depends on it. Slice 22 (`retire-compose-observability`) handles removal once the obs cluster has absorbed everything.
- **No collector autoscaling, no HPA, no PDB, no NetworkPolicy.** Single replica, no eviction guards. Cluster is single-node and dev-only; same posture as backend/frontend.
- **No image signing, no SBOM publication.** Same posture as slices 15 and 16.
- **No CI job exercising the in-cluster collector path.** CI continues to use compose-only for tests. A future slice may add a Lima + k3s smoke check once enough of the arc lands.
- **No multi-collector tier (edge + central).** The in-cluster collector is the only collector in the app cluster; the compose collector is the receiving side of the bridge.

## Capabilities

### Modified Capabilities

- `kubernetes` — modifies the slice-15 requirement "The backend pod sends OTLP to the host-side collector" so the target becomes the in-cluster `collector` Service's FQDN (`collector.social.svc.cluster.local:4318`) instead of the VM-host alias. Adds new requirements covering: (a) the collector Deployment shape (image source, port surface, resource caps, probe configuration), (b) the collector ConfigMap pipeline (receivers, processors, exporter to compose for the transitional period), (c) the ClusterIP Service surfacing OTLP/gRPC and OTLP/HTTP, and (d) the Hetzner overlay's commented stub for the collector.
- `observability` — replaces the explicitly-transitional slice-15 requirement "An in-cluster backend pod sends OTLP to the host-side collector via the VM-host alias" with its successor: an in-cluster backend pod SHALL send OTLP to the in-cluster collector Service. The original requirement's text foreshadowed this exact replacement; this slice is the one that triggers the revision. Adds a new requirement: the in-cluster collector SHALL relay traces to the compose collector via `host.lima.internal:4317` until the obs-cluster bridge slice lands.

### New Capabilities

(none — `kubernetes` and `observability` are the natural homes for the collector Deployment and the OTLP routing requirements respectively.)

## Impact

- **Affected files / directories:**
  - `infra/k8s/base/collector/kustomization.yaml`, `deployment.yaml`, `service.yaml`, `configmap.yaml` (new)
  - `infra/k8s/base/kustomization.yaml` — appends `./collector` to `resources:`
  - `infra/k8s/base/backend/deployment.yaml` — `OTEL_EXPORTER_OTLP_ENDPOINT` value changes
  - `infra/k8s/overlays/hetzner/kustomization.yaml` — appends a commented stub for the collector
  - `justfile` — two new recipes (`collector-logs`, `collector-rollout`)
  - `README.md` — new subsection; backend-in-k3s narrative refreshed
- **New tool dependencies:**
  - No new host dependencies. `kubectl` (already required), `kustomize` (already required), `docker` (registry profile already in use) cover everything.
  - One new container image: `otel/opentelemetry-collector-contrib:0.111.0`. Same image already used in compose; the image is fetched from Docker Hub on first apply and cached on the Lima VM thereafter.
- **Dependencies on external services:**
  - The compose collector's published OTLP/gRPC port `:4317` MUST be reachable from inside the Lima VM via `host.lima.internal`. This is the same alias the slice-15 backend uses today; this slice's only new claim is that the collector pod's network stack resolves the alias identically to the backend pod's, which is true for any pod scheduled on the Lima node.
- **CI:** no new CI jobs. The k3s flow remains dev-only. A future slice may add a Lima + k3s smoke check once cross-cluster traffic is interesting to assert.
- **Compatibility:** additive at the topology level, transitional at the requirement level. Anyone who pulls this branch and runs `just backend-apply` gets the new collector pod and a backend pod whose OTLP target points in-cluster; compose grafana continues to show traces unchanged because the in-cluster collector relays to compose. A reader who only runs `./gradlew bootRun` (the host loop) sees no behavior change. A reader who never runs the k3s flow sees no behavior change.
- **Rollback:** `git revert` the merge. The new Kustomize subdirectory, the backend env update, the justfile recipes, and the overlay stub disappear. The compose collector keeps running; the backend pod's OTLP target reverts to `host.lima.internal:4318`. If the in-cluster collector misbehaves before a full revert, a one-line edit to the backend Deployment's `OTEL_EXPORTER_OTLP_ENDPOINT` (back to `host.lima.internal:4318`) restores the prior path immediately; the collector Deployment can then be deleted independently.
