## ADDED Requirements

### Requirement: A second Lima VM definition lives in `infra/lima/obs.yaml`

The repository SHALL contain a declarative Lima VM definition at `infra/lima/obs.yaml` describing a single-node Linux VM dedicated to the observability cluster. The VM SHALL match the shape of the application cluster's Lima VM (4 vCPU, 8 GiB RAM, 64 GiB disk, arm64, Ubuntu 24.04 LTS) so that workload behavior observed locally transfers to the eventual second Hetzner box. The VM definition SHALL be committed to git as the source of truth for the observability cluster's hardware shape.

#### Scenario: obs Lima YAML declares the target shape
- **WHEN** a reader inspects `infra/lima/obs.yaml`
- **THEN** the file declares `arch: aarch64` (or the Lima-canonical equivalent for arm64)
- **AND** the file declares `cpus: 4`
- **AND** the file declares `memory: "8GiB"` (or the Lima-canonical equivalent)
- **AND** the file declares a disk size of at least `64GiB`
- **AND** the file declares an Ubuntu 24.04 LTS image

#### Scenario: obs Lima YAML does not collide with the app VM on the host kube-apiserver port
- **WHEN** a reader inspects the `portForwards:` block in `infra/lima/obs.yaml`
- **THEN** the entry mapping the in-VM kube-apiserver port (`guestPort: 6443`) maps to a `hostPort` that is NOT `6443`
- **AND** the chosen host-side apiserver port is documented in a header comment

#### Scenario: obs Lima YAML wires the kubeconfig to the host under a non-colliding context name
- **WHEN** a reader inspects `infra/lima/obs.yaml`
- **THEN** the file declares a mechanism (either `copyToHost:` block or `provision:` step) that surfaces the k3s kubeconfig on the macOS host
- **AND** the context name written into the host-side kubeconfig does NOT collide with the application cluster's existing context name in `~/.kube/config`
- **AND** the host-facing kubeconfig points at the host-side port that the `portForwards:` block maps to the in-VM kube-apiserver port

#### Scenario: obs Lima YAML invokes the shared provision script on first boot
- **WHEN** a reader inspects the `provision:` block in `infra/lima/obs.yaml`
- **THEN** the block invokes `infra/provisioning/install-k3s.sh` (either by inline source-and-execute or by mounting and running it)
- **AND** no k3s install logic is duplicated inline inside `obs.yaml` itself
- **AND** `obs.yaml` does NOT pass any host-specific argument or environment variable to the script that would prevent the same script from running unmodified on Hetzner

### Requirement: The observability cluster reuses the shared k3s install script

The observability VM SHALL be provisioned by the same `infra/provisioning/install-k3s.sh` script that provisions the application cluster, without modification. The script's host-agnostic invariant declared in the `kubernetes` capability SHALL be honored — this slice's second consumer of the script validates that invariant.

#### Scenario: Install script is not forked or branched for the obs cluster
- **WHEN** a reader greps the repository for files named `install-k3s*.sh`
- **THEN** exactly one file is returned: `infra/provisioning/install-k3s.sh`
- **AND** no obs-cluster-specific install script exists

#### Scenario: Install script is byte-identical to the app cluster's provisioning
- **WHEN** a reader inspects the `provision:` block of both `infra/lima/lima.yaml` and `infra/lima/obs.yaml`
- **THEN** both invoke the same script at the same path
- **AND** any future modification of the script affects both clusters identically

### Requirement: A single-node k3s cluster runs inside the observability Lima VM

Running `limactl start infra/lima/obs.yaml` (or the justfile recipe wrapping it) on a fresh host SHALL produce a working single-node k3s cluster reachable from macOS via `kubectl` using the host-side kubeconfig context the slice declares. The cluster SHALL be operable concurrently with the application cluster.

#### Scenario: kubectl from the host reports a Ready node on the obs context
- **WHEN** an operator has run `just obs-up` and the VM has finished booting
- **AND** the operator runs `kubectl --context <obs-context> get nodes`
- **THEN** exactly one node is listed with `STATUS: Ready`
- **AND** the node's `ROLES` includes `control-plane`

#### Scenario: Bundled k3s components are healthy in the obs cluster
- **WHEN** the obs cluster has reached steady state
- **AND** the operator runs `kubectl --context <obs-context> -n kube-system get deploy,daemonset`
- **THEN** Traefik, klipper-lb (`svclb-*`), local-path-provisioner, and metrics-server are present
- **AND** each reports Available / Ready

#### Scenario: Both Lima VMs can be running simultaneously
- **WHEN** the app cluster VM is up (via `just vm-up`)
- **AND** the obs cluster VM is also up (via `just obs-up`)
- **THEN** `limactl list` shows both VMs in `Running` state
- **AND** `kubectl --context <app-context> get nodes` succeeds
- **AND** `kubectl --context <obs-context> get nodes` succeeds
- **AND** neither command interferes with the other

### Requirement: The observability cluster's kustomize tree lives at `infra/k8s-obs/`

The repository SHALL contain a kustomize directory tree at `infra/k8s-obs/` following the `base/<component>/` + `overlays/{local,hetzner}/` convention established by `infra/k8s/`. The `overlays/local/` overlay SHALL render and apply cleanly against the obs cluster; the `overlays/hetzner/` overlay SHALL be a placeholder marked TODO until the Hetzner-deploy slice fills it in.

#### Scenario: kustomize tree shape matches the established convention
- **WHEN** a reader lists `infra/k8s-obs/`
- **THEN** the tree contains `base/`, `overlays/local/`, and `overlays/hetzner/`
- **AND** `base/kustomization.yaml` declares the obs cluster's namespace (proposed: `observability`)
- **AND** `base/` contains one subdirectory per LGTM component (`prometheus/`, `loki/`, `tempo/`, `grafana/`, `alertmanager/`)

#### Scenario: Local overlay renders cleanly
- **WHEN** an operator runs `kustomize build --enable-helm infra/k8s-obs/overlays/local`
- **THEN** the command exits 0
- **AND** every rendered resource declares `namespace: observability` (or whatever name the slice settles on for the obs namespace)

#### Scenario: Hetzner overlay is a clearly marked placeholder
- **WHEN** a reader inspects `infra/k8s-obs/overlays/hetzner/kustomization.yaml`
- **THEN** the file declares `../../base` as a resource
- **AND** the file contains a TODO comment naming the items the Hetzner-deploy slice will add (Secret strategy, Ingress + TLS, storage sizing for the obs box)
- **AND** the file does NOT reuse any local-only Secret as-is

### Requirement: The LGTM stack is deployed via separate pinned helm charts, not kube-prometheus-stack

Each observability component (prometheus, loki, tempo, grafana, alertmanager) SHALL be deployed as a SEPARATE Helm chart declared via Kustomize `helmCharts:` directives. Each chart's `version:` field SHALL be an explicit version string (no `latest`, no channel). The Prometheus Operator and its CRDs (`ServiceMonitor`, `PodMonitor`, `PrometheusRule`, `AlertmanagerConfig`, etc.) SHALL NOT be deployed in this slice; the `kube-prometheus-stack` chart SHALL NOT be used.

#### Scenario: Each LGTM component is its own chart
- **WHEN** a reader greps `infra/k8s-obs/base/**/kustomization.yaml` for `helmCharts:` entries
- **THEN** five distinct chart names appear: `prometheus`, `loki`, `tempo`, `grafana`, `alertmanager`
- **AND** no chart named `kube-prometheus-stack` (or `kube-prom-stack`) appears

#### Scenario: Every chart version is explicitly pinned
- **WHEN** a reader inspects each `helmCharts:` entry under `infra/k8s-obs/base/`
- **THEN** every entry's `version:` field is a literal version string (e.g. `25.27.0`)
- **AND** no entry uses `latest`, `stable`, or an empty / templated version field

#### Scenario: No Prometheus Operator CRDs are installed
- **WHEN** the obs cluster has fully applied `infra/k8s-obs/overlays/local`
- **AND** an operator runs `kubectl --context <obs-context> get crd`
- **THEN** no CRD belonging to `monitoring.coreos.com` is present (e.g. `servicemonitors.monitoring.coreos.com`, `prometheusrules.monitoring.coreos.com`)

### Requirement: Each LGTM component has a dedicated PVC backed by local-path

Each LGTM component SHALL have its own PersistentVolumeClaim bound to a PersistentVolume provisioned by the obs cluster's `local-path` storage class. PVC sizes for this slice SHALL be set to the learning-project envelope: prometheus 5Gi, loki 5Gi, tempo 5Gi, grafana 1Gi, alertmanager 1Gi.

#### Scenario: PVCs bind and report the declared size
- **WHEN** the obs cluster has fully applied `infra/k8s-obs/overlays/local`
- **AND** an operator runs `kubectl --context <obs-context> -n observability get pvc`
- **THEN** five PVCs are listed (one per LGTM component)
- **AND** each PVC's `STATUS` is `Bound`
- **AND** each PVC's `STORAGECLASS` is `local-path`
- **AND** each PVC's `CAPACITY` matches the declared size for that component

#### Scenario: Storage stays inside the obs cluster
- **WHEN** a reader inspects the chart values for prometheus, loki, and tempo
- **THEN** no chart is configured with `s3:`, `gcs:`, `azure:`, or any other object-storage backend
- **AND** all stateful backends point at the local PVC

### Requirement: Grafana stands up with no datasources configured

The grafana deployment for this slice SHALL run successfully and serve its login UI on a host-reachable endpoint, but SHALL NOT have any datasources provisioned. Datasource provisioning is deferred to the slice that pipes data across the cluster boundary.

#### Scenario: Grafana UI loads
- **WHEN** an operator runs `just obs-grafana` (the port-forward helper)
- **AND** the operator opens `http://localhost:<grafana-port>` in a browser
- **THEN** the grafana login page renders
- **AND** logging in with the slice-default admin credentials succeeds

#### Scenario: No datasources are pre-configured
- **WHEN** an authenticated operator opens `Configuration → Data sources` in grafana
- **THEN** the data sources list is empty
- **AND** no provisioning sidecar or ConfigMap pre-populates a datasource

### Requirement: The obs cluster never holds credentials for the app cluster

The observability cluster SHALL NOT contain any kubeconfig, token, or Secret that grants access to the application cluster. The cross-cluster auth direction is one-way: the app cluster pushes telemetry into the obs cluster (in later slices), the obs cluster never reaches back into the app cluster. This invariant SHALL be preserved by future slices in the arc.

#### Scenario: No app-cluster credential lives in the obs kustomize tree
- **WHEN** a reader greps `infra/k8s-obs/` for anything resembling an app-cluster kubeconfig, token, or service-account binding
- **THEN** no such artifact is present
- **AND** no Secret in `infra/k8s-obs/` references the app cluster's apiserver, CA, or service-account credentials

#### Scenario: No Service in the obs cluster is intended for the obs cluster to dial into the app cluster
- **WHEN** a reader inspects the Services declared under `infra/k8s-obs/base/`
- **THEN** every Service is either ClusterIP (storage-plane internal) or a future inbound receiver / UI exposure
- **AND** no Service definition implies the obs cluster initiates connections into the app cluster

### Requirement: justfile recipes drive the obs cluster's lifecycle

The repository's root `justfile` SHALL provide recipes that mirror the application cluster's lifecycle shape for the obs cluster: `obs-up`, `obs-down`, `obs-status`, `obs-grafana`. These recipes SHALL be discoverable via `just --list` with one-line descriptions.

#### Scenario: All obs recipes are listed
- **WHEN** an operator runs `just --list`
- **THEN** `obs-up`, `obs-down`, `obs-status`, `obs-grafana` appear in the output
- **AND** each recipe has a one-line description

#### Scenario: `obs-up` boots the obs VM and waits for cluster readiness
- **WHEN** an operator runs `just obs-up` on a host where the obs VM is not running
- **THEN** the recipe starts the Lima VM via `infra/lima/obs.yaml`
- **AND** waits for the obs cluster's node to reach `Ready` before returning

#### Scenario: `obs-down` stops the obs VM without deleting it
- **WHEN** an operator runs `just obs-down` on a host where the obs VM is running
- **THEN** the recipe stops the VM (preserving its disk state and PVC contents)
- **AND** does NOT delete the VM
- **AND** does NOT touch the application cluster's VM

#### Scenario: `obs-grafana` port-forwards grafana to the host
- **WHEN** an operator runs `just obs-grafana` while the obs cluster is up
- **THEN** the recipe establishes a port-forward (or equivalent ingress path) such that a browser on the host can reach grafana via `http://localhost:<port>`

### Requirement: The host docker-compose observability stack remains unmodified by this slice

The docker-compose observability stack (prometheus, grafana, tempo, loki, alertmanager, otel-collector, postgres-exporter) SHALL continue running unchanged after this slice lands. The two stacks SHALL coexist until a later slice retires the compose stack.

#### Scenario: docker-compose.yml's observability services are unchanged
- **WHEN** a reader diffs `docker-compose.yml` against the pre-slice baseline
- **THEN** the prometheus, grafana, tempo, loki, alertmanager, collector, and postgres-exporter service blocks are byte-identical to the baseline
- **AND** no service block has been removed

#### Scenario: The compose observability stack still functions
- **WHEN** an operator runs `docker compose --profile observability up -d` after this slice has landed
- **THEN** all observability services come up Healthy
- **AND** the existing app-cluster backend's OTLP target (`host.lima.internal:4318`) still resolves to the compose collector
- **AND** dashboards in compose-grafana still render real data
