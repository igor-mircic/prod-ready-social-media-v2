## ADDED Requirements

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

## MODIFIED Requirements

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
