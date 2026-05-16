## Why

The current observability stack (prometheus, grafana, tempo, loki, alertmanager, otel-collector) runs as docker-compose on the macOS host while application workloads run inside the Lima/k3s app cluster. Backends in k3s ship OTLP back out of the VM to `host.lima.internal:4318` — a transitional shim that has no Hetzner analogue. The slice 14–16 arc closed leaving the production observability home as an explicit open question on the Hetzner overlay placeholder.

The chosen production target is the **two-cluster pattern**: app workloads on one box, observability stack on a separate box (separate k3s cluster). This is the production-realistic answer because the cluster you are observing is the one most likely to break, and observability must survive the outage it needs to explain ("who watches the watchmen"). This change introduces the local mirror of that pattern — a second Lima VM running its own k3s cluster, standing up the LGTM stack with no app data flowing in yet. Wiring app telemetry into it is deferred to the next slice; this slice is pure layout, validating that the two-cluster shape works on a developer laptop before any cross-cluster bridge is built.

The host docker-compose observability stack keeps running throughout this slice so visibility into the app cluster is not lost; retirement of the compose stack lands in a later slice (currently planned as `retire-compose-observability`, post-cutover).

## What Changes

- New Lima VM definition at `infra/lima/obs.yaml` describing a second single-node Linux VM (arm64, Ubuntu 24.04 LTS) with a shape sized for the LGTM stack at learning-project scale (4 vCPU, 8 GiB RAM, 64 GiB disk — same envelope as the app VM, with the disk headroom going to prometheus TSDB, loki chunks, and tempo blocks rather than postgres).
- The new Lima VM reuses `infra/provisioning/install-k3s.sh` unchanged (the script's host-agnostic invariant is validated by this second consumer).
- New kustomize tree at `infra/k8s-obs/` with `base/` + `overlays/local/` + `overlays/hetzner/` mirroring the existing `infra/k8s/` layout. The `hetzner/` overlay starts as a placeholder; only `overlays/local/` is wired into the justfile for this slice.
- The LGTM stack is deployed inside the obs cluster via Kustomize `helmCharts:` directives, with each component a separately-versioned chart (prometheus, loki, tempo, grafana, alertmanager) — deliberately NOT `kube-prometheus-stack`, which hides too much behind the Prometheus Operator and its ~30 CRDs for the learning intent of this project.
- Each LGTM component gets a dedicated PVC backed by the obs cluster's `local-path` provisioner. Sizes are tuned for learning-project retention (short-window: prometheus 5Gi, loki 5Gi, tempo 5Gi, grafana 1Gi, alertmanager 1Gi).
- Grafana is deployed with NO datasources configured yet — datasources land in the slice that pipes data across (slice 18, `add-k3s-app-collector`). Grafana's UI must load successfully on `localhost:<port>` and show "no data sources configured."
- Host-side kubeconfig contexts: the app cluster's existing context (whatever name the current lima.yaml exposes) stays; the new VM adds a non-colliding context (proposed name: `social-obs`), so an operator can `kubectl --context social-obs get pods -A` from the host without touching the app cluster's context.
- New `justfile` recipes: `obs-up`, `obs-down`, `obs-status`, `obs-grafana` (port-forward to the obs cluster's grafana), mirroring the existing app-cluster recipe shape.
- Host docker-compose observability stack is NOT modified in this slice. Both stacks run in parallel (the in-VM one empty of app data, the host one continuing to receive app data) until slice 20 makes the cut and slice 22 retires the compose stack.
- The cross-cluster network boundary stays push-only by design: the obs cluster does NOT get any inbound credential or kubeconfig access to the app cluster. This is a property to lock in now even though no traffic crosses the boundary in this slice — it shapes which Services are exposed and which are clusterIP-only.

## Capabilities

### New Capabilities
- `observability-cluster`: The local infrastructure pattern for running a dedicated observability cluster — a second Lima VM, its own k3s install (reusing the shared provisioning script), its own kubeconfig context, and the LGTM stack deployed via Kustomize+helmCharts. Covers what runs inside the obs cluster, how it is reached from the host, and the fate-separation invariants (push-only ingress, no app-cluster credentials inside it) that distinguish it from a same-cluster colocated stack.

### Modified Capabilities
- (none)

The existing `kubernetes` spec already declares the shared `install-k3s.sh` host-agnostic invariant and the Lima-VM-with-k3s pattern; the new spec consumes those patterns by reference rather than modifying them. The existing `observability` spec describes the docker-compose host stack as it stands today; this slice does not change it (the stack keeps running). When slice 22 retires the docker-compose stack, that change will carry the `observability` spec delta.

## Impact

- **Infra (new)**: `infra/lima/obs.yaml`, `infra/k8s-obs/base/**`, `infra/k8s-obs/overlays/local/**`, `infra/k8s-obs/overlays/hetzner/**` (placeholder).
- **Infra (unchanged)**: `infra/lima/lima.yaml`, `infra/k8s/**`, `infra/provisioning/install-k3s.sh` (reused, not modified — this slice's second-consumer validates the script's host-agnostic claim).
- **Infra (parallel, untouched this slice)**: `infra/observability/**` and the docker-compose observability services remain running.
- **Tooling**: `justfile` gains obs-cluster recipes (`obs-up`, `obs-down`, `obs-status`, `obs-grafana`).
- **Documentation**: `README.md` and/or a new `infra/k8s-obs/README.md` documents the two-cluster shape, the kubeconfig context name, and that the obs cluster has no app data wired in until the next slice.
- **Developer machine**: each operator runs a second Lima VM concurrently with the app VM (adds ~8 GiB committed RAM, ~64 GiB disk allocation). Documented as a known cost of the two-cluster pattern. Operators may stop the obs VM (`just obs-down`) when not working on observability.
- **CI**: out of scope for this slice. The obs cluster is local-only for now; CI continues to exercise only the app cluster's kustomize tree. A future slice may add a kustomize-build smoke check for `infra/k8s-obs/overlays/local/`.
- **Disk**: PVCs total ~17 GiB at declared sizes on the obs VM's local-path; well within the 64 GiB envelope. No retention enforcement beyond chart defaults in this slice.
- **Cost**: zero monetary cost (no managed observability subscriptions, no extra cloud resources). Hetzner two-box deployment cost (~€10/mo additional for a small obs box) deferred to the `add-hetzner-deploy` slice.
