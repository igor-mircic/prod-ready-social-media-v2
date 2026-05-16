# observability-cluster Specification

## Purpose
TBD - created by archiving change add-local-k3s-obs-cluster. Update Purpose after archive.
## Requirements
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

The grafana deployment in the obs cluster SHALL provision exactly four datasources via the chart's `datasources:` configuration block, each pointing at the corresponding in-cluster `Service` DNS name in the `observability` namespace:

- `Tempo` → `http://tempo.observability.svc.cluster.local:3200` (tempo's HTTP query endpoint, NOT the OTLP receiver port).
- `Prometheus` → `http://prometheus-server.observability.svc.cluster.local` (port 80 chart-default).
- `Loki` → `http://loki.observability.svc.cluster.local:3100`.
- `Alertmanager` → `http://alertmanager.observability.svc.cluster.local:9093`.

Only Tempo carries real data when this slice lands — the others render "no data" in grafana panels until their data-plane slices land (slice 20 for loki, slice 21 for prometheus, future alerting slice for alertmanager). Pre-staging all four now avoids three rounds of churn against the same `datasources:` block in later slices.

#### Scenario: Grafana renders datasources page with all four
- **WHEN** an operator runs `just obs-grafana` and logs in
- **AND** the operator opens `Configuration → Data sources`
- **THEN** exactly four datasources are listed: Tempo, Prometheus, Loki, Alertmanager
- **AND** each datasource's `URL` field shows the in-cluster Service DNS for its target

#### Scenario: Datasource provisioning lives in the chart values
- **WHEN** a reader inspects `infra/k8s-obs/base/grafana/values.yaml`
- **THEN** the file contains a `datasources:` block with four entries named `Tempo`, `Prometheus`, `Loki`, `Alertmanager`
- **AND** each entry's `url` is the in-cluster Service DNS for its target
- **AND** no entry uses an external (host or off-cluster) URL

#### Scenario: Tempo datasource enables service-graph visualization
- **WHEN** a reader inspects the Tempo datasource entry in `infra/k8s-obs/base/grafana/values.yaml`
- **THEN** the entry's `jsonData` (or chart-equivalent) enables the service-graph view, matching the compose-side tempo datasource's stance from the frontend-tracing spec
- **AND** the chart-default service-graph configuration is not disabled

#### Scenario: Operator queries traces in obs grafana end-to-end
- **WHEN** the in-cluster backend has served real traffic with the dual-write configuration applied
- **AND** the operator opens obs grafana → Explore → Tempo
- **THEN** trace data appears for `service.name=backend`
- **AND** clicking through to a span shows attributes consistent with the same trace as seen in compose grafana

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

### Requirement: An OpenTelemetry Collector Deployment lives at `infra/k8s-obs/base/collector/`

The obs cluster SHALL run its own OpenTelemetry Collector as a single-replica Deployment declared under `infra/k8s-obs/base/collector/`. The directory SHALL contain four files: `kustomization.yaml`, `deployment.yaml`, `service.yaml`, and `configmap.yaml`. The image SHALL be `otel/opentelemetry-collector-contrib:0.111.0` — the same pin used by the compose collector and the app cluster collector. The container SHALL declare a `livenessProbe` and a `readinessProbe` against the bundled `health_check` extension on port `13133`. The container SHALL declare CPU and memory resource `requests` (`cpu=50m`, `memory=128Mi`) and `limits` (`cpu=500m`, `memory=512Mi`); the memory limit is intentionally higher than the app collector's `256Mi` because the obs collector is the cross-cluster aggregation point.

#### Scenario: Directory contains the four Kustomize files
- **WHEN** a reader lists `infra/k8s-obs/base/collector/`
- **THEN** the directory contains exactly `kustomization.yaml`, `deployment.yaml`, `service.yaml`, `configmap.yaml`
- **AND** no other files are present

#### Scenario: Deployment image and args are pinned and consistent with the rest of the project
- **WHEN** a reader inspects `infra/k8s-obs/base/collector/deployment.yaml`
- **THEN** the container's `image` is `otel/opentelemetry-collector-contrib:0.111.0`
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`
- **AND** the ConfigMap is mounted read-only at `/etc/otelcol-contrib/`

#### Scenario: Probes target the health_check extension
- **WHEN** a reader inspects the obs collector container spec
- **THEN** both `livenessProbe.httpGet.port` and `readinessProbe.httpGet.port` are the named port `healthcheck` (or numeric `13133`)
- **AND** the path is `/`
- **AND** the container declares a `containerPorts:` entry `name: healthcheck, containerPort: 13133`

#### Scenario: Resources are declared with the documented envelope
- **WHEN** a reader inspects the obs collector container's `resources:` block
- **THEN** `requests.cpu=50m`, `requests.memory=128Mi`, `limits.cpu=500m`, `limits.memory=512Mi`

### Requirement: The obs collector Service is type LoadBalancer and exposes OTLP gRPC and HTTP

A Kubernetes `Service` named `collector` SHALL exist in the `observability` namespace with `type: LoadBalancer`. It SHALL expose two ports: `4317` (otlp-grpc) targeting `otlp-grpc`, and `4318` (otlp-http) targeting `otlp-http`. klipper-lb SHALL assign the obs VM's primary IP as the Service's external IP. The Service's selector SHALL match the collector Deployment's pod labels.

LoadBalancer (rather than ClusterIP or NodePort) is the established pattern from slice 14's postgres path; klipper-lb assigning the VM IP plus Lima portForwards routing host-side traffic into the VM is the layered shape the rest of the arc uses for off-cluster reachability.

#### Scenario: Service is type LoadBalancer with two ports
- **WHEN** a reader inspects `infra/k8s-obs/base/collector/service.yaml`
- **THEN** `spec.type` is `LoadBalancer`
- **AND** two ports are declared: `4317` → `otlp-grpc` and `4318` → `otlp-http`
- **AND** no other port is declared

#### Scenario: klipper-lb assigns the VM IP
- **WHEN** the obs cluster has applied this slice and the collector pod has reached Ready
- **AND** an operator runs `kubectl --context social-obs -n observability get svc collector -o wide`
- **THEN** the `EXTERNAL-IP` column shows the obs VM's primary IP
- **AND** the column is not `<pending>`

#### Scenario: Selector matches the Deployment's pod labels
- **WHEN** a reader inspects the Service's `spec.selector` and the Deployment's `spec.template.metadata.labels`
- **THEN** the selector matches the Deployment template labels (`app.kubernetes.io/name=collector`)

### Requirement: The obs collector ConfigMap declares the OTLP-receiver → batch → redact → otlp/tempo pipeline

The obs collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `observability` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block), `batch` and `transform/redact-path-ids` processors (OTTL statements identical to the app cluster collector's), a `health_check` extension on `:13133/`, and exactly one exporter `otlp/tempo` pointing at `tempo.observability.svc.cluster.local:4317` with `tls.insecure: true`. The single declared pipeline SHALL be `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/tempo]`. No metrics or logs pipeline SHALL be declared in this slice — slices 20 and 21 add those exporters.

The redact-path-ids processor is defense-in-depth at this hop: every collector in the path applies the same redaction so a future regression at the app collector does not leak high-cardinality path segments into the obs cluster's storage.

#### Scenario: ConfigMap key projects as a file at the expected path
- **WHEN** a reader inspects `infra/k8s-obs/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP without CORS
- **WHEN** a reader inspects the `receivers:` block in the obs collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`

#### Scenario: Redaction policy mirrors the app cluster collector verbatim
- **WHEN** a reader inspects the `processors:` block in the obs collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` are byte-identical to those in `infra/k8s/base/collector/configmap.yaml` for the same patterns (UUID, opaque-hex, numeric path-segment) over `span.name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full`

#### Scenario: Exporter targets in-cluster tempo
- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** exactly one exporter `otlp/tempo` is declared
- **AND** its `endpoint` is `tempo.observability.svc.cluster.local:4317`
- **AND** its `tls.insecure` is `true`

#### Scenario: One traces pipeline; no metrics or logs pipelines
- **WHEN** a reader inspects the `service.pipelines:` block in the obs collector config
- **THEN** exactly one pipeline named `traces` is declared
- **AND** the pipeline's `receivers` list is `[otlp]`
- **AND** the pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the pipeline's `exporters` list is `[otlp/tempo]`
- **AND** no `metrics`, `logs/backend`, or `logs/frontend` pipeline is declared

#### Scenario: health_check extension is enabled and registered
- **WHEN** a reader inspects the obs collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

### Requirement: The obs Lima VM publishes the obs collector's OTLP ports on the macOS host with a +10000 offset

The obs VM's `infra/lima/obs.yaml` `portForwards:` block SHALL declare two additional entries before the catch-all `ignore: true` rule: guestPort `4317` → hostPort `14317` (otlp-grpc), and guestPort `4318` → hostPort `14318` (otlp-http). The host-side ports are deliberately offset by `+10000` from the in-VM Service ports, symmetric with the apiserver disambiguation (app `:16443`, obs `:16444`); this guarantees no collision with the compose collector's already-published `:4317`/`:4318` and gives operators one consistent rule for "obs-cluster analogue of compose port X."

#### Scenario: obs.yaml publishes 14317 and 14318
- **WHEN** a reader inspects the `portForwards:` block in `infra/lima/obs.yaml`
- **THEN** an entry maps `guestPort: 4317` to `hostPort: 14317`
- **AND** an entry maps `guestPort: 4318` to `hostPort: 14318`
- **AND** both entries appear BEFORE the catch-all `guestPortRange: [1, 65535], ignore: true` entry

#### Scenario: Host-side ports do NOT collide with compose
- **WHEN** the host docker-compose observability profile is up
- **AND** the obs VM is up after Lima has applied this slice's portForwards
- **THEN** `:4317` and `:4318` on the macOS host are bound by docker-compose (compose collector)
- **AND** `:14317` and `:14318` on the macOS host are bound by Lima (obs VM port-forwarder)
- **AND** no port conflict occurs at either layer

### Requirement: A `just` recipe surface drives the obs collector lifecycle

The repo-root `justfile` SHALL declare two recipes covering the obs collector's daily verbs: log tailing and rolling restart. Recipe names SHALL follow the `obs-collector-<verb>` convention (mirroring the app cluster's `collector-<verb>` pair from slice 18a).

#### Scenario: `just --list` enumerates the obs collector verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least `obs-collector-logs` and `obs-collector-rollout`

#### Scenario: `obs-collector-rollout` issues the rollout against the obs context
- **WHEN** an operator runs `just obs-collector-rollout`
- **THEN** the recipe issues `kubectl --context social-obs rollout restart deploy/collector -n observability`
- **AND** waits for the rollout to complete via `kubectl rollout status` before returning

### Requirement: The obs Hetzner overlay declares a commented stub for the collector

The `infra/k8s-obs/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the obs collector: production resource caps, real TLS material (cert-manager-issued client/server certs that slice 19 introduces), an Ingress or LoadBalancer that terminates inbound OTLP on the obs box's public/private IP, tighter probe timings, and storage / retention sizing for the obs box. The stub SHALL be comments only — no live resources.

#### Scenario: obs Hetzner overlay names the collector additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s-obs/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, TLS material, ingress strategy, and probe-timing changes the Hetzner slice will add for the obs collector
- **AND** none of those declarations are uncommented in this slice

