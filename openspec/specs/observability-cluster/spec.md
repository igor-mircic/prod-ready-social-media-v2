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

The obs collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `observability` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block). Both `otlp.protocols.grpc` and `otlp.protocols.http` SHALL declare a `tls:` block requiring mutual TLS:

- `cert_file: /etc/otelcol-contrib/certs/server.crt`
- `key_file: /etc/otelcol-contrib/certs/server.key`
- `client_ca_file: /etc/otelcol-contrib/certs/ca.crt`
- `require_client_cert: true` (the OTLP receiver's documented YAML key in otelcol-contrib v0.111.0; if the actual key name differs in the running binary, the spec-compatible key SHALL be used and a comment SHALL note the divergence)

The receivers SHALL NOT accept plaintext connections. A client that does not present a certificate signed by the configured CA SHALL be rejected at the TLS handshake.

The pipeline SHALL also declare `batch` and `transform/redact-path-ids` processors (OTTL statements identical to the app cluster collector's, including `url.path` alongside the deprecated `http.url`/`http.target`/`url.full` attributes), a `health_check` extension on `:13133/`, and three exporters: `otlp/tempo` pointing at `tempo.observability.svc.cluster.local:4317` with `tls.insecure: true` (traces, in-cluster), `otlphttp/loki` pointing at `http://loki.observability.svc.cluster.local:3100/otlp` with `tls.insecure: true` (logs, using Loki 3.x's native OTLP ingest path), and `prometheusremotewrite/in-cluster` pointing at `http://prometheus-server.observability.svc.cluster.local/api/v1/write` with `tls.insecure: true` (metrics). These in-cluster exporters remain plaintext because they do not cross a VM boundary.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/tempo]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlphttp/loki]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [prometheusremotewrite/in-cluster]`.

The redact-path-ids processor is defence-in-depth at this hop: every collector in the path applies the same redaction so a future regression at the app collector does not leak high-cardinality path segments into the obs cluster's storage.

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP and require client cert

- **WHEN** a reader inspects the `receivers:` block in the obs collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`
- **AND** each protocol block declares a `tls:` sub-block with `cert_file: /etc/otelcol-contrib/certs/server.crt`, `key_file: /etc/otelcol-contrib/certs/server.key`, `client_ca_file: /etc/otelcol-contrib/certs/ca.crt`
- **AND** each `tls:` block sets `require_client_cert: true` (or the v0.111.0 contrib-binary equivalent key, with a comment naming any divergence)

#### Scenario: A client without a valid cert is rejected at handshake

- **WHEN** an operator runs `openssl s_client -connect host.lima.internal:14317 < /dev/null` from the macOS host
- **THEN** the handshake fails with a TLS alert (e.g. `certificate required` or `bad certificate`)
- **AND** the obs collector logs the rejected connection

#### Scenario: A client presenting a cert NOT signed by the CA is rejected

- **WHEN** the app collector dials the obs collector while configured with a cert signed by a different CA
- **THEN** the obs collector rejects the handshake
- **AND** the app collector logs a TLS handshake error against the obs-cluster exporter

#### Scenario: Redaction policy mirrors the app cluster collector and includes `url.path`

- **WHEN** a reader inspects the `processors:` block in the obs collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` target the attribute key `url.path` for every redaction pattern (UUID, opaque-hex, numeric)
- **AND** the OTTL statements also target `span.name`, `attributes["http.url"]`, `attributes["http.target"]`, `attributes["url.full"]` (kept as defence-in-depth for legacy instrumentation)
- **AND** the OTTL statements are byte-equivalent to those in `infra/k8s/base/collector/configmap.yaml` for the same set of patterns and attributes

#### Scenario: In-cluster exporters remain plaintext

- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** an exporter named `otlp/tempo` is declared with `endpoint: tempo.observability.svc.cluster.local:4317` and `tls.insecure: true`
- **AND** an exporter named `otlphttp/loki` is declared with `endpoint: http://loki.observability.svc.cluster.local:3100/otlp` and `tls.insecure: true`
- **AND** an exporter named `prometheusremotewrite/in-cluster` is declared with `endpoint: http://prometheus-server.observability.svc.cluster.local/api/v1/write` and `tls.insecure: true`

#### Scenario: Three pipelines are declared, each with its single exporter

- **WHEN** a reader inspects the `service.pipelines:` block in the obs collector config
- **THEN** exactly three pipelines are declared: `traces`, `logs`, and `metrics`
- **AND** the `traces` pipeline's `receivers` is `[otlp]`, `processors` is `[batch, transform/redact-path-ids]`, `exporters` is `[otlp/tempo]`
- **AND** the `logs` pipeline's `receivers` is `[otlp]`, `processors` is `[batch, transform/redact-path-ids]`, `exporters` is `[otlphttp/loki]`
- **AND** the `metrics` pipeline's `receivers` is `[otlp]`, `processors` is `[batch]`, `exporters` is `[prometheusremotewrite/in-cluster]`

#### Scenario: health_check extension is enabled and registered

- **WHEN** a reader inspects the obs collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

#### Scenario: Operator queries logs in obs grafana end-to-end

- **WHEN** the in-cluster backend has served real traffic and a frontend user has triggered an FE error
- **AND** the operator opens obs grafana → Explore → Loki
- **THEN** log entries appear for `event.dataset=frontend.error` (the slice-7 dataset tag)
- **AND** at least one such entry corresponds to the FE error the user triggered

#### Scenario: Operator queries FE web-vitals in obs grafana end-to-end

- **WHEN** the in-cluster frontend has emitted at least one web-vitals export cycle
- **AND** the operator opens obs grafana → Explore → Prometheus
- **AND** the operator queries `web_vitals_lcp_bucket`
- **THEN** the query returns at least one series with non-zero buckets

### Requirement: The obs Lima VM publishes the obs collector's OTLP ports on the macOS host with a +10000 offset

The obs VM's `infra/lima/obs.yaml` `portForwards:` block SHALL declare seven entries before the catch-all `ignore: true` rule. Each entry SHALL declare `guestIP: 0.0.0.0` so the host-side bind succeeds for Services backed by k3s's klipper-lb (svclb) ingress (project lesson: Lima 2.x portForwards remapping a LoadBalancer Service port require the explicit `guestIP: 0.0.0.0` setting):

- guestPort `4317` → hostPort `14317` (obs collector OTLP gRPC, +10000 offset, retained from slice 17)
- guestPort `4318` → hostPort `14318` (obs collector OTLP HTTP, +10000 offset, retained from slice 17)
- guestPort `9090` → hostPort `9090` (obs prometheus HTTP API, new in slice 22b — replaces the compose prometheus on the same host port)
- guestPort `3200` → hostPort `3200` (obs tempo HTTP API, new in slice 22b — replaces the compose tempo on the same host port)
- guestPort `3100` → hostPort `3100` (obs loki HTTP API, new in slice 22b — replaces the compose loki on the same host port)
- guestPort `9093` → hostPort `9093` (obs alertmanager HTTP API, new in slice 22b — replaces the compose alertmanager on the same host port)
- guestPort `8080` → hostPort `8081` (obs webhook-sink HTTP API; the obs Service binds `:8080` per slice 22a's chart-default discipline, but the e2e alerting spec's URL constant points at `:8081` — the Lima portForward absorbs the asymmetry so the spec stays unchanged, per design.md Decision 2)

The five new mappings (`:9090`, `:3200`, `:3100`, `:9093`, `:8081`) become operational the moment the compose `observability` profile stops binding those host ports — which is the same commit that deletes the compose services. No port-collision window exists.

The host-side ports for the OTLP receivers are deliberately offset by `+10000` from the in-VM Service ports, symmetric with the apiserver disambiguation (app `:16443`, obs `:16444`); this guarantees no collision with the app collector's host-side OTLP receivers and gives operators one consistent rule for "obs-cluster analogue of compose port X."

#### Scenario: obs.yaml publishes all seven portForwards before the catch-all

- **WHEN** a reader inspects the `portForwards:` block in `infra/lima/obs.yaml`
- **THEN** entries map `guestPort: 4317` → `hostPort: 14317` and `guestPort: 4318` → `hostPort: 14318`
- **AND** entries map `guestPort: 9090` → `hostPort: 9090`, `guestPort: 3200` → `hostPort: 3200`, `guestPort: 3100` → `hostPort: 3100`, `guestPort: 9093` → `hostPort: 9093`
- **AND** an entry maps `guestPort: 8080` → `hostPort: 8081` (the webhook-sink remap)
- **AND** every entry above declares `guestIP: 0.0.0.0`
- **AND** all seven entries appear BEFORE the catch-all `guestPortRange: [1, 65535], ignore: true` entry

#### Scenario: Host-side ports do NOT collide with anything post-22b

- **GIVEN** the slice has been applied (compose observability profile deleted) and the obs VM is up after Lima has applied this slice's portForwards
- **WHEN** an operator inspects host port bindings via `lsof -iTCP -sTCP:LISTEN -P -n | grep -E ':(4317|4318|9090|3200|3100|9093|8081|14317|14318)\b'`
- **THEN** `:14317`, `:14318`, `:9090`, `:3200`, `:3100`, `:9093`, and `:8081` are bound by the Lima port-forwarder
- **AND** no compose container is bound to any of those ports (the compose `observability` profile no longer exists)

#### Scenario: The five new portForwards reach the obs cluster Services end-to-end

- **GIVEN** the slice has been applied and the obs cluster's LGTM stack pods are Running
- **WHEN** an operator issues `curl -sS http://localhost:9090/-/healthy`, `curl -sS http://localhost:3200/ready`, `curl -sS http://localhost:3100/ready`, `curl -sS http://localhost:9093/-/healthy`, and `curl -sS http://localhost:8081/healthz`
- **THEN** every response is 2xx
- **AND** the response bodies (where applicable) identify the in-VM workload (`prometheus`, `tempo`, `loki`, `alertmanager`, `webhook-sink`)

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

The `infra/k8s-obs/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the obs collector: production resource caps, TLS material distribution (the cross-cluster self-signed CA from slice 19 stays the trust anchor; slice 23 introduces cert-manager-managed Certificate resources backed by a self-signed `ClusterIssuer` so the CA private key is no longer kept on disk on a developer machine; the production server cert SAN list swaps `host.lima.internal` for the obs box's private-network IP or DNS name; renewals become automated via cert-manager rather than manual recipe re-runs), an Ingress or LoadBalancer that terminates inbound OTLP on the obs box's public/private IP, tighter probe timings, and storage / retention sizing for the obs box. The stub SHALL be comments only — no live resources.

#### Scenario: obs Hetzner overlay names the collector additions a future slice will plug in

- **WHEN** a reader inspects `infra/k8s-obs/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, TLS material distribution (cert-manager-managed Certificates backed by a self-signed ClusterIssuer for the cross-cluster CA, separate ACME issuer for any external ingress), ingress strategy, and probe-timing changes the Hetzner slice will add for the obs collector
- **AND** the narrative explicitly names that the slice-19 self-signed CA remains the trust anchor (only its distribution mechanism changes) and that the CA private key is NOT kept on disk in production
- **AND** none of those declarations are uncommented in this slice

### Requirement: The obs cluster prometheus chart enables the remote-write receiver

The slice-17 prometheus chart values (`infra/k8s-obs/base/prometheus/values.yaml`) SHALL declare the remote-write receiver feature so the obs collector's `prometheusremotewrite/in-cluster` exporter has a destination to push to. The flag SHALL be added via the chart's `server.extraFlags` (or chart-equivalent) values path; the modern flag name `web.enable-remote-write-receiver` is preferred over the older `enable-feature=remote-write-receiver` form. The receiver SHALL light up at `POST /api/v1/write` on the existing `prometheus-server` Service in the `observability` namespace; no new Service or Ingress is required.

#### Scenario: Chart values declare the remote-write receiver flag

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/values.yaml`
- **THEN** the `server.extraFlags` list (or chart-equivalent) contains `web.enable-remote-write-receiver`
- **AND** no other prometheus chart values reference a remote-write feature flag

#### Scenario: prometheus pod started with the flag

- **WHEN** the obs cluster has applied the updated values
- **AND** an operator runs `kubectl --context social-obs -n observability get pod -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].spec.containers[0].args}'`
- **THEN** the args list contains the string `--web.enable-remote-write-receiver`

#### Scenario: Remote-write endpoint accepts a synthetic push

- **WHEN** an operator port-forwards the prometheus-server Service
- **AND** issues a minimal valid `POST /api/v1/write` with `Content-Encoding: snappy` and a single sample
- **THEN** the response is HTTP 204 (or 200), NOT 404 or 405

#### Scenario: Obs collector metrics land in prometheus

- **WHEN** the obs collector has been processing the app collector's metrics pipeline for at least one batch interval
- **AND** an operator port-forwards prometheus-server and queries the federated UI
- **THEN** at least one FE web-vitals metric (e.g. `web_vitals_lcp_bucket`) is present in the metric name list

### Requirement: A self-signed CA + leaf certs back the cross-cluster mTLS

The repository SHALL contain `infra/observability/certs/` as the canonical home for the cross-cluster trust anchor. The directory SHALL contain:

- `ca.crt` — the self-signed CA certificate (PEM). Public material; SHALL be committed.
- `ca.key` — the self-signed CA private key. SHALL NOT be committed; SHALL be excluded by `infra/observability/certs/.gitignore` (or the repo-root `.gitignore`) and SHALL be regeneratable by the `just obs-certs` recipe.
- `openssl.cnf` — the openssl configuration the cert-gen recipe consumes (CA subject, validity, leaf cert SAN extensions). SHALL be committed so cert generation is reproducible.
- `.gitignore` — at minimum excludes `*.key`.

The CA SHALL be the single trust anchor for both the app collector (client) and the obs collector (server). Both per-cluster cert directories (`infra/k8s/base/collector/certs/` and `infra/k8s-obs/base/collector/certs/`) SHALL contain a copy of `ca.crt` so each side can verify the other's leaf certificate.

The CA SHALL have at least 10-year validity. Leaf certs (server cert in the obs cluster, client cert in the app cluster) SHALL have at least 1-year validity. Rotation is manual via the recipe.

The CA private key on disk is acceptable for the local mirror; the Hetzner overlay stubs SHALL name "CA private key not on disk in production" as a slice-23 concern (cert-manager-managed via a self-signed `ClusterIssuer`).

#### Scenario: Trust anchor files live in `infra/observability/certs/`

- **WHEN** a reader lists `infra/observability/certs/`
- **THEN** the directory contains `ca.crt`, `openssl.cnf`, and `.gitignore`
- **AND** `ca.key` is present in a fresh-clone-then-`just obs-certs` flow but is excluded from git via `.gitignore`

#### Scenario: CA cert is the shared trust anchor

- **WHEN** a reader inspects `infra/k8s/base/collector/certs/ca.crt` and `infra/k8s-obs/base/collector/certs/ca.crt`
- **THEN** both files are byte-identical to `infra/observability/certs/ca.crt`

#### Scenario: Validity is suitable for the local mirror

- **WHEN** an operator runs `openssl x509 -in infra/observability/certs/ca.crt -noout -dates`
- **THEN** the `notAfter` date is at least 10 years after the `notBefore` date

### Requirement: `just obs-certs` generates the cross-cluster trust material end-to-end

The repo-root `justfile` SHALL declare a recipe `obs-certs` that drives openssl to produce the CA, the obs collector's server cert + key, and the app collector's client cert + key. The recipe SHALL:

- Assert `openssl` is on `$PATH` and bail with an installation hint if not.
- Generate the CA key + self-signed CA cert into `infra/observability/certs/` using `infra/observability/certs/openssl.cnf` as the openssl config.
- Sign an obs collector server cert + key into `infra/k8s-obs/base/collector/certs/` with SAN entries covering at minimum `host.lima.internal`, `localhost`, and `collector.observability.svc.cluster.local`.
- Sign an app collector client cert + key into `infra/k8s/base/collector/certs/` with subject CN `app-collector` (or equivalent; subject is not enforced by the receiver, only verifiable signature against the CA is).
- Copy `ca.crt` into both per-cluster certs directories so each side can verify the other.
- Be idempotent: re-running the recipe regenerates every artifact (keys are re-keyed; certs are re-signed).

The `obs-up` recipe SHALL invoke `obs-certs` automatically if `infra/observability/certs/ca.crt` is missing, so a fresh-clone bootstrap is one command.

#### Scenario: `just --list` enumerates the cert-gen recipe

- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes `obs-certs`

#### Scenario: Recipe is idempotent and produces all three identities

- **WHEN** an operator runs `just obs-certs` twice on a clean checkout
- **THEN** the second invocation produces fresh `ca.crt`, `ca.key`, `server.crt`, `server.key`, `client.crt`, `client.key` files without errors
- **AND** every leaf certificate verifies against the CA cert via `openssl verify -CAfile infra/observability/certs/ca.crt <leaf.crt>`

#### Scenario: Recipe bails loudly if openssl is missing

- **WHEN** an operator runs `just obs-certs` on a host where `openssl` is not on `$PATH`
- **THEN** the recipe exits with a non-zero status
- **AND** the error message names `openssl` and a hint for installing it (e.g. brew / apt)

#### Scenario: `just obs-up` auto-invokes the cert-gen recipe on a fresh checkout

- **WHEN** an operator runs `just obs-up` with `infra/observability/certs/ca.crt` absent
- **THEN** the recipe invokes `obs-certs` before bringing up the obs Lima VM
- **AND** the subsequent obs-cluster apply succeeds (the secretGenerators have certs to read)

### Requirement: The obs collector pod mounts the cross-cluster server-cert Secret

The collector container in `infra/k8s-obs/base/collector/deployment.yaml` SHALL declare a second `volumeMount` named `certs` mounted read-only at `/etc/otelcol-contrib/certs/`, and the Deployment's `volumes:` block SHALL declare a corresponding `secret`-typed volume named `certs` referencing a Secret produced by a Kustomize `secretGenerator`. The secretGenerator entry in `infra/k8s-obs/base/collector/kustomization.yaml` SHALL read the per-cluster certs directory `./certs/` (containing `server.crt`, `server.key`, and `ca.crt`) and SHALL NOT disable name suffixing (so a regenerated cert produces a new Secret name and the Deployment rolls automatically). The mounted directory SHALL be the same path the obs collector's receiver `tls:` blocks reference in `cert_file`, `key_file`, and `client_ca_file`.

#### Scenario: Deployment declares the certs volume and mount

- **WHEN** a reader inspects the collector container spec in `infra/k8s-obs/base/collector/deployment.yaml`
- **THEN** the container's `volumeMounts:` list contains an entry `name: certs, mountPath: /etc/otelcol-contrib/certs, readOnly: true`
- **AND** the pod's `volumes:` list contains an entry `name: certs` of type `secret` whose `secretName` matches the Secret produced by the kustomization's secretGenerator
- **AND** the existing `config` volume mount at `/etc/otelcol-contrib/` is unchanged

#### Scenario: kustomization.yaml declares the secretGenerator for the obs collector certs

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/kustomization.yaml`
- **THEN** the file declares a `secretGenerator:` block with an entry whose `name` is the Secret name referenced by the Deployment's `certs` volume
- **AND** the entry's `files:` list materializes `server.crt`, `server.key`, and `ca.crt` from `infra/k8s-obs/base/collector/certs/`
- **AND** the generator does NOT set `disableNameSuffixHash: true`

#### Scenario: Per-directory `.gitignore` keeps private key out of git

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/certs/.gitignore` (or the repo-root `.gitignore` patterns)
- **THEN** the pattern excludes `server.key` (or `*.key`)
- **AND** `server.crt` and `ca.crt` are NOT excluded

### Requirement: The obs prometheus chart values' comment block reflects slice-21 reality

The slice-17 prometheus chart values file at `infra/k8s-obs/base/prometheus/values.yaml` SHALL carry comments that accurately describe the chart's role in the data flow as of slice 21. Specifically:

- The bundled subcharts `alertmanager`, `prometheus-pushgateway`, `kube-state-metrics`, and `prometheus-node-exporter` SHALL remain disabled in the YAML keys (no runtime change), but the comment block SHALL name the slice-21 OTel-receiver-side path (`metrics-agent` DaemonSet + `metrics-cluster-agent` Deployment in the app cluster) as the replacement for the kube-state-metrics and prometheus-node-exporter subcharts.
- The default scrape jobs (`prometheus`, `kubernetes-api-servers`, `kubernetes-nodes`, `kubernetes-nodes-cadvisor`, `kubernetes-service-endpoints`, `kubernetes-service-endpoints-slow`, `prometheus-pushgateway`, `kubernetes-services`, `kubernetes-pods`, `kubernetes-pods-slow`) SHALL remain `enabled: false` in the YAML keys, and the comment block SHALL name remote-write (slice 18c) as the data-flow path that obviates them.
- The comment block SHALL NOT contain any forward-looking references to slice 21 as the home for scrape configs or for the kube-state-metrics / prometheus-node-exporter subcharts — those hints were misleading slice-17-era guesses and SHALL be retracted now that slice 21 has chosen the OTel-receiver-side path.

This is a narrative-only requirement: the chart's runtime configuration is unchanged. The intent is to keep the values.yaml's comments truthful for the next operator who reads it.

#### Scenario: Subchart keys stay disabled

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/values.yaml`
- **THEN** `alertmanager.enabled`, `prometheus-pushgateway.enabled`, `kube-state-metrics.enabled`, and `prometheus-node-exporter.enabled` are all `false`

#### Scenario: Default scrape jobs stay disabled

- **WHEN** a reader inspects the `scrapeConfigs:` block
- **THEN** every default job key (the ten named above) has `enabled: false`

#### Scenario: Comment block no longer promises slice-21 scrape configs

- **WHEN** a reader greps the file for `slice 21` or `add-k3s-cluster-metrics`
- **THEN** any reference to slice 21 describes the OTel-receiver-side path (metrics-agent / metrics-cluster-agent agents shipping via remote-write), NOT a future chart-side scrape-job activation
- **AND** no comment claims that kube-state-metrics or prometheus-node-exporter subcharts will be enabled in slice 21

### Requirement: The obs collector promotes OTel resource attributes to prometheus labels

The obs collector's `prometheusremotewrite/in-cluster` exporter (at `infra/k8s-obs/base/collector/configmap.yaml`) SHALL declare `resource_to_telemetry_conversion.enabled: true`. Without this setting, the exporter drops OTel resource attributes (`k8s.node.name`, `k8s.namespace.name`, `k8s.pod.name`, `host.name`, etc.) and emits unlabeled prometheus series — the cluster-overview dashboard's per-node / per-namespace / per-pod queries would have nothing to group by.

This is a one-key addition; the rest of the obs collector's metrics pipeline shape (`otlp` receiver → `batch` processor → `prometheusremotewrite/in-cluster` exporter) is unchanged from slice 18c.

#### Scenario: Resource attribute promotion is enabled

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/configmap.yaml`
- **THEN** the `exporters.prometheusremotewrite/in-cluster:` block declares `resource_to_telemetry_conversion:` with `enabled: true`

#### Scenario: Series carry the cluster-shaped labels

- **WHEN** both new app-cluster pods have been Ready for at least 30s
- **AND** an operator queries `k8s_deployment_available{k8s_deployment_name="backend"}` against obs prometheus
- **THEN** the returned series carries at least the labels `k8s_deployment_name`, `k8s_namespace_name`, and `k8s_cluster_name` (the standard k8s_cluster resource attribute set, dotted-to-underscored)

### Requirement: The obs grafana chart provisions the `cluster-overview` dashboard

The obs grafana chart (`infra/k8s-obs/base/grafana/`) SHALL provision a `cluster-overview.json` dashboard automatically alongside the existing slice-17 `custom-dashboard.json`. The provisioning mechanism SHALL be whichever shape the slice-17 chart already uses (a `dashboardProviders:` + `dashboards:` block in values.yaml, or a sibling ConfigMap mounted via `extraConfigmapMounts`) — slice 21 SHALL NOT introduce a competing provisioning mechanism alongside the existing one.

The dashboard JSON SHALL live at `infra/k8s-obs/base/grafana/dashboards/cluster-overview.json` (the directory created by this slice if not present). The slice-17 `custom-dashboard.json` SHALL remain unchanged.

#### Scenario: Dashboard JSON file lives at the documented path

- **WHEN** a reader runs `ls infra/k8s-obs/base/grafana/dashboards/cluster-overview.json`
- **THEN** the file exists and parses as valid JSON

#### Scenario: Provisioning reuses the slice-17 mechanism

- **WHEN** a reader compares the provisioning declaration for `cluster-overview.json` with the declaration for `custom-dashboard.json`
- **THEN** both dashboards are loaded via the same chart-level mechanism (no new helm chart, no new sidecar, no new ConfigMap pattern)

#### Scenario: Dashboard appears in obs grafana

- **WHEN** the obs cluster has applied the slice's manifests
- **AND** an operator opens obs grafana
- **AND** navigates to Dashboards → Browse
- **THEN** a dashboard titled `Cluster overview` is listed without any manual JSON import

### Requirement: The obs prometheus chart mounts the migrated rule files via a kustomize-generated ConfigMap

The kustomization at `infra/k8s-obs/base/prometheus/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `prometheus-extra-rules` sourcing every `.yml` file in the `infra/k8s-obs/base/prometheus/rules/` directory. The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL declare a `server.extraConfigmapMounts:` entry that mounts the generated ConfigMap at `/etc/prometheus-extra-rules/` inside the prometheus pod. The chart values SHALL override `serverFiles.prometheus.yml.rule_files:` to PRESERVE the chart-default entries (`/etc/config/recording_rules.yml`, `/etc/config/alerting_rules.yml`) AND APPEND `/etc/prometheus-extra-rules/*.yml` so the migrated rules are loaded at prometheus startup.

The `infra/k8s-obs/base/prometheus/rules/` directory SHALL contain `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, and `database-alerts.yml` as the canonical source of truth — they are no longer parity-window copies of a compose-side original (the compose-side originals are deleted in slice 22b). `container-alerts.yml` SHALL NOT be present — it is keyed on cadvisor-shaped series that do not exist in the slice-21 OTel families and is deferred to a follow-up slice (`add-k8s-container-saturation-alerts`).

The four promtool test fixtures (`slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`) SHALL live at `infra/k8s-obs/base/prometheus/tests/` (relocated from `infra/observability/prometheus/rules/` in slice 22b). The CI `prometheus-rules` job's `promtool test rules` step reads from this directory. `container-tests.yml` is retained as a historical record of the deferred container-saturation alerting; it is not currently active against any rule file in `infra/k8s-obs/base/prometheus/rules/`.

#### Scenario: ConfigMap generator picks up every migrated rule file

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a ConfigMap whose name begins with `prometheus-extra-rules-`
- **AND** the ConfigMap's `data:` map contains exactly five keys: `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`

#### Scenario: Prometheus pod mounts the ConfigMap at the expected path

- **WHEN** a reader inspects the prometheus chart's rendered Deployment / StatefulSet
- **THEN** the pod-spec `volumes:` references the `prometheus-extra-rules` ConfigMap
- **AND** the prometheus container's `volumeMounts:` mounts that volume at `/etc/prometheus-extra-rules/` read-only

#### Scenario: Rule files are loaded at prometheus startup

- **GIVEN** the obs cluster has applied this slice and the prometheus pod has restarted
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field begins with `/etc/prometheus-extra-rules/`
- **AND** the groups together declare every alert from the five migrated files (`ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `BackendDown`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`, `PostgresConnectionSaturation`, `PostgresDeadlocks`)

#### Scenario: Promtool test fixtures live in a dedicated `tests/` directory, not in `rules/`

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** no file in the directory ends in `-tests.yml`
- **AND** the directory `infra/k8s-obs/base/prometheus/tests/` contains exactly four files: `slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`
- **AND** no equivalent file exists under `infra/observability/prometheus/`

#### Scenario: Container-alerts stays deferred

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** the directory does NOT contain `container-alerts.yml`
- **AND** the deferred container-saturation alerting work is named in the Hetzner overlay stub or the design narrative as a follow-up slice

### Requirement: The obs prometheus chart wires the in-cluster alertmanager as its alerting target

The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL set `server.alertmanagers:` to a single-entry list whose entry declares a `static_configs:` target of `alertmanager.observability.svc.cluster.local:9093`. The chart-default value (`alertmanagers: []`) SHALL be replaced. No additional alertmanager target SHALL be declared in this slice.

#### Scenario: Values file declares exactly one alertmanager target

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/values.yaml`
- **THEN** `server.alertmanagers:` is a list of exactly one element
- **AND** that element's `static_configs:` targets contains exactly the string `alertmanager.observability.svc.cluster.local:9093`

#### Scenario: Prometheus reports the alertmanager as up after apply

- **GIVEN** the obs cluster has applied this slice
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/alertmanagers`
- **THEN** the response's `activeAlertmanagers` list contains the URL of the in-cluster alertmanager Service
- **AND** no `droppedAlertmanagers` entry is present for the in-cluster target

### Requirement: The obs alertmanager values declare the severity-keyed routing tree migrated from compose

The chart values at `infra/k8s-obs/base/alertmanager/values.yaml` SHALL replace the slice-17 placeholder `config:` block with a routing tree mirroring the compose-side `infra/observability/alertmanager/alertmanager.yml`. The top-level `route:` SHALL declare `receiver: 'default'`, `group_by: ['alertname', 'slo']`, `group_wait: 10s`, `group_interval: 5m`, `repeat_interval: 4h`, and two child routes: one matching `severity="page"` targeting receiver `page-webhook`, one matching `severity="ticket"` targeting receiver `ticket-webhook`. Each child route SHALL declare `continue: false`. The receivers list SHALL declare `default` (no webhook_configs), `page-webhook`, and `ticket-webhook`. Each webhook receiver SHALL declare `send_resolved: true`.

#### Scenario: Top-level route declares severity-keyed children

- **WHEN** a reader inspects the `config:` block in `infra/k8s-obs/base/alertmanager/values.yaml`
- **THEN** the top-level `route:` block names a `default` receiver
- **AND** the `route.routes:` list contains exactly two entries
- **AND** the two entries match `severity="page"` and `severity="ticket"` respectively
- **AND** neither child route sets `continue: true`
- **AND** the `group_by`, `group_wait`, `group_interval`, and `repeat_interval` values match the compose configuration (`['alertname', 'slo']`, `10s`, `5m`, `4h`)

#### Scenario: Webhook URLs target the in-cluster webhook-sink Service

- **WHEN** a reader inspects the `receivers:` block
- **THEN** the `page-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink.observability.svc.cluster.local:8080/page` and `send_resolved: true`
- **AND** the `ticket-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink.observability.svc.cluster.local:8080/ticket` and `send_resolved: true`
- **AND** the `default` receiver declares no `webhook_configs`

#### Scenario: BackendDown inhibition rule is declared

- **WHEN** a reader inspects the `config.inhibit_rules:` list
- **THEN** the list contains exactly one rule
- **AND** that rule's `source_matchers:` contain `alertname="BackendDown"`
- **AND** that rule's `target_matchers:` contain `slo=~".+"`
- **AND** that rule's `equal:` is the empty list

#### Scenario: Null receiver from slice 17 is gone

- **WHEN** a reader greps the values file for `'null'`
- **THEN** the file does NOT contain a receiver named `null`

### Requirement: A `webhook-sink` Deployment + Service runs in the `observability` namespace

A new Deployment workload SHALL run a single `webhook-sink` pod in the `observability` namespace of the obs cluster. The image SHALL be built from `infra/k8s-obs/base/webhook-sink/src/` (the Dockerfile + Node sources relocated from `infra/observability/webhook-sink/` in slice 22b) and pushed to the local OCI registry as `registry.local:5000/webhook-sink:dev` (same image flow as slice-15 backend/frontend). The Deployment manifests SHALL live at `infra/k8s-obs/base/webhook-sink/` with `kustomization.yaml`, `deployment.yaml`, and `service.yaml`. The base kustomization at `infra/k8s-obs/base/kustomization.yaml` SHALL list `./webhook-sink` in its `resources:` array. The `Service/webhook-sink` SHALL be of type `ClusterIP` exposing port `8080`; it SHALL be reachable from the alertmanager pod at `http://webhook-sink.observability.svc.cluster.local:8080`.

The obs Lima VM publishes the webhook-sink Service on the macOS host at `localhost:8081` via the portForward declared by the slice's portForwards requirement (host `:8081` → guest `:8080`); the asymmetry between the host port and the in-cluster port is intentional and described in design.md Decision 2.

#### Scenario: Kustomization includes the webhook-sink

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a Deployment named `webhook-sink` in the `observability` namespace
- **AND** the pod-spec image is `registry.local:5000/webhook-sink:dev`
- **AND** a `Service/webhook-sink` of type `ClusterIP` on port `8080` is present

#### Scenario: Image is built from the consumer-local source path

- **WHEN** a reader inspects the `just` recipe that builds the webhook-sink image
- **THEN** the recipe's `docker build` context is `infra/k8s-obs/base/webhook-sink/src/`
- **AND** no committed Dockerfile or Node source file remains under `infra/observability/webhook-sink/`

#### Scenario: Service selector matches the Deployment's pod labels

- **WHEN** a reader inspects the Service's `selector:` and the Deployment's pod-template labels
- **THEN** every key/value in the Service selector also appears in the Deployment's pod-template labels

#### Scenario: Alertmanager can reach the webhook-sink in-cluster

- **GIVEN** the slice has been applied and both pods are Running
- **WHEN** an operator runs `kubectl --context obs -n observability exec deploy/alertmanager -- wget -qO- http://webhook-sink.observability.svc.cluster.local:8080/healthz` (or the equivalent endpoint the image exposes)
- **THEN** the response is a 2xx HTTP status

#### Scenario: Host operator can reach the webhook-sink via the Lima portForward

- **GIVEN** the slice has been applied, the webhook-sink pod is Running, and the obs Lima VM is up with this slice's portForwards in effect
- **WHEN** an operator runs `curl -sS http://localhost:8081/healthz` from the macOS host
- **THEN** the response is a 2xx HTTP status (proving the host `:8081` → guest `:8080` remap reaches the in-cluster Service end-to-end)

### Requirement: The obs grafana chart provisions the three migrated dashboards

The chart values at `infra/k8s-obs/base/grafana/values.yaml` SHALL declare provisioning entries for three additional dashboards alongside the slice-21 `cluster-overview` entry: `backend-overview`, `frontend-overview`, `database-overview`. Each dashboard SHALL be sourced from `infra/k8s-obs/base/grafana/dashboards/<name>.json`. The JSON files SHALL be byte-similar copies of the compose-side `infra/observability/grafana/dashboards/<name>.json` with the following allowed edits: (i) `instance="host.docker.internal:8080"` selectors (and equivalent compose-only instance pins) relaxed to `instance=~".*"`; (ii) no other systematic edit. The compose `infrastructure-overview.json` SHALL NOT be copied — the slice-21 `cluster-overview.json` covers the same operator role under k8s-shaped families.

#### Scenario: Three new dashboard JSON files exist

- **WHEN** a reader inspects `infra/k8s-obs/base/grafana/dashboards/`
- **THEN** the directory contains `backend-overview.json`, `frontend-overview.json`, `database-overview.json` alongside the slice-21 `cluster-overview.json`
- **AND** the directory does NOT contain `infrastructure-overview.json`

#### Scenario: Compose-only instance selectors are relaxed

- **WHEN** a reader greps each migrated dashboard JSON for `host.docker.internal`
- **THEN** no occurrences are present
- **AND** any panel query that filtered on a compose-only `instance` value now uses `instance=~".*"` or omits the selector

#### Scenario: All four dashboards appear in the obs grafana UI after provisioning

- **GIVEN** the slice has been applied and grafana has restarted
- **WHEN** an operator opens obs grafana → Dashboards → Browse
- **THEN** `Backend overview`, `Frontend overview`, `Database overview`, and `Cluster overview` each appear in the list without manual import
- **AND** each renders without "No data" on every panel under a workload-running cluster (the alerting/SLO panels may show recently-empty windows but no schema mismatch)

### Requirement: A `just` recipe surfaces the obs webhook-sink received payloads

The repository's `justfile` SHALL declare a recipe named `obs-webhook-sink-received` that returns the captured payloads from the in-cluster webhook-sink, mirroring the compose-side equivalent. The recipe SHALL run inside the webhook-sink pod (avoiding the need for a port-forward) and SHALL pipe through `jq` (if available locally) so the response is human-readable.

#### Scenario: Recipe is defined in the justfile

- **WHEN** a reader inspects `justfile`
- **THEN** a recipe named `obs-webhook-sink-received` exists
- **AND** the recipe body runs `kubectl --context obs -n observability exec ... deploy/webhook-sink -- ...` against the `/received` endpoint on `:8080`

#### Scenario: Recipe returns valid JSON when the webhook-sink is running

- **GIVEN** the slice has been applied and the webhook-sink pod is Running
- **WHEN** an operator runs `just obs-webhook-sink-received`
- **THEN** the recipe exits 0
- **AND** stdout is parseable as JSON (or an empty JSON array if no payloads have been received)

