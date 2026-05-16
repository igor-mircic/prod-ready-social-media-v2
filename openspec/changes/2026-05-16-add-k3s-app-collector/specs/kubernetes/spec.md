## ADDED Requirements

### Requirement: An OpenTelemetry Collector Deployment lives at `infra/k8s/base/collector/`

The repository SHALL contain a Kustomize directory `infra/k8s/base/collector/` declaring an OpenTelemetry Collector workload that runs inside the application Kubernetes cluster. The directory SHALL follow the established `base/<component>/` convention with `kustomization.yaml`, `deployment.yaml`, `service.yaml`, and `configmap.yaml`. The image tag SHALL be pinned via the directory's `kustomization.yaml` `images:` directive so a future bump touches a single line.

#### Scenario: Collector directory follows the established layout
- **WHEN** a reader lists `infra/k8s/base/collector/`
- **THEN** the directory contains `kustomization.yaml`, `deployment.yaml`, `service.yaml`, and `configmap.yaml`
- **AND** each file is referenced from the directory's `kustomization.yaml` `resources:` block

#### Scenario: Collector image tag is pinned in one place
- **WHEN** a reader inspects `infra/k8s/base/collector/kustomization.yaml`
- **THEN** the file declares an `images:` directive with `name: otel/opentelemetry-collector-contrib` and an explicit `newTag` value
- **AND** the `deployment.yaml` references the image by name without an inline tag (so the directive controls the resolved tag)

#### Scenario: Collector is listed in the base kustomization index
- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the `resources:` block includes `./collector` alongside `./postgres`, `./backend`, and `./frontend`

### Requirement: The collector Deployment exposes OTLP receivers via a ClusterIP Service named `collector`

The collector workload SHALL be reachable from other in-cluster pods at the stable DNS name `collector.social.svc.cluster.local`. A `Service` of `type: ClusterIP` in the `social` namespace SHALL surface the collector's OTLP/gRPC and OTLP/HTTP receivers on ports `4317` and `4318` respectively. The Service SHALL NOT publish a NodePort or LoadBalancer — only in-cluster traffic reaches the collector in this slice.

#### Scenario: Service is ClusterIP with both OTLP ports
- **WHEN** a reader inspects `infra/k8s/base/collector/service.yaml`
- **THEN** the file declares `kind: Service`, `metadata.namespace: social`, `metadata.name: collector`
- **AND** `spec.type` is `ClusterIP`
- **AND** the `ports:` list includes one entry with `name: otlp-grpc, port: 4317` and one entry with `name: otlp-http, port: 4318`
- **AND** no port declares a `nodePort` value
- **AND** the Service is NOT referenced anywhere in the repository as type `LoadBalancer`

#### Scenario: Service selector matches the collector Deployment labels
- **WHEN** a reader inspects the Service's `spec.selector` and the Deployment's `spec.template.metadata.labels`
- **THEN** the selector matches the Deployment template labels (`app.kubernetes.io/name=collector`)

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block), `batch` and `transform/redact-path-ids` processors, a `health_check` extension exposing `:13133/` for kubelet probes, and exactly one exporter `otlp/compose-relay` pointing at `host.lima.internal:4317` with `tls.insecure: true`. The single declared pipeline SHALL be `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay]`. No metrics or logs pipeline SHALL be declared in this slice.

#### Scenario: ConfigMap key projects as a file at the expected path
- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/` (so the in-pod file path is `/etc/otelcol-contrib/config.yaml`)
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP without CORS
- **WHEN** a reader inspects the `receivers:` block in the collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`

#### Scenario: Processors mirror the compose collector's redaction policy
- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` mirror those in `infra/observability/collector/collector-config.yaml` (the same UUID, opaque-hex, and numeric path-segment patterns over `span.name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full`)
- **AND** no `filter/drop_high_cardinality`, `filter/frontend_only`, `transform/pii_scrub`, or `attributes/loki_labels` processor is declared in this slice

#### Scenario: Exporter relays to the compose collector via the VM-host alias
- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** exactly one exporter `otlp/compose-relay` is declared
- **AND** its `endpoint` is `host.lima.internal:4317`
- **AND** its `tls.insecure` is `true`

#### Scenario: One traces pipeline; no metrics or logs pipelines
- **WHEN** a reader inspects the `service.pipelines:` block in the collector config
- **THEN** exactly one pipeline named `traces` is declared
- **AND** the pipeline's `receivers` list contains `otlp`
- **AND** the pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the pipeline's `exporters` list is `[otlp/compose-relay]`
- **AND** no `metrics`, `logs/backend`, or `logs/frontend` pipeline is declared

#### Scenario: health_check extension is enabled and registered with the service block
- **WHEN** a reader inspects the collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

### Requirement: The collector Deployment declares health-check probes against the bundled extension

The collector container SHALL declare a `livenessProbe` and a `readinessProbe`, both HTTP GETs against the named `healthcheck` container port (the contrib collector's bundled `health_check` extension on port `13133`). The probes SHALL NOT target the OTLP receiver ports (a bare GET against `:4318/` returns 404, which kubelet treats as unhealthy).

#### Scenario: Both probes target the healthcheck port
- **WHEN** a reader inspects the collector container spec in `infra/k8s/base/collector/deployment.yaml`
- **THEN** `livenessProbe.httpGet.port` is the named port `healthcheck` (or its numeric equivalent `13133`)
- **AND** `readinessProbe.httpGet.port` is the same port
- **AND** the path is `/`
- **AND** the container declares a `containerPorts:` entry `name: healthcheck, containerPort: 13133`

#### Scenario: Probes are NOT directed at the OTLP receivers
- **WHEN** a reader greps `infra/k8s/base/collector/deployment.yaml` for the OTLP port numbers `4317` or `4318` inside `livenessProbe` or `readinessProbe` blocks
- **THEN** no match is found

### Requirement: The collector container declares conservative resource requests and limits

The collector container SHALL declare CPU and memory `requests` and `limits` sized for the local single-node cluster's headroom (~7 GiB free after postgres + backend + frontend). The values SHALL be conservative enough that the collector remains a polite cluster citizen but generous enough that the typical local-dev span volume does not throttle or OOM.

#### Scenario: Container declares both requests and limits for CPU and memory
- **WHEN** a reader inspects the collector container's `resources:` block
- **THEN** `requests.cpu` and `requests.memory` are declared
- **AND** `limits.cpu` and `limits.memory` are declared
- **AND** `limits.memory` parses to at least `256Mi`

### Requirement: The Hetzner overlay declares a commented stub for the collector

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the collector: production resource caps, the cross-cluster exporter endpoint (the production-side obs-cluster Service or DNS), TLS / mTLS material reference, tighter probe timings, and anti-affinity considerations if multi-node. The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the collector additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, cross-cluster exporter endpoint, TLS material, and probe-timing changes the Hetzner slice will add for the collector
- **AND** none of those declarations are uncommented in this slice

### Requirement: A `just` recipe surface drives the collector lifecycle

The repo-root `justfile` SHALL declare two recipes covering the in-cluster collector's daily verbs: log tailing and rolling restart (the documented Kubernetes pattern for picking up ConfigMap edits, since the kubelet does not auto-restart pods when a mounted ConfigMap changes). Recipe names SHALL follow the `collector-<verb>` convention.

#### Scenario: `just --list` enumerates the collector verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least `collector-logs` and `collector-rollout`

#### Scenario: `collector-rollout` waits for rollout completion
- **WHEN** an operator runs `just collector-rollout`
- **THEN** the recipe issues `kubectl rollout restart deploy/collector -n social`
- **AND** waits for the rollout to complete via `kubectl rollout status` before returning

## MODIFIED Requirements

### Requirement: The backend pod sends OTLP to the in-cluster collector

The backend Deployment SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318` so the in-cluster backend's OTel agent reaches the in-cluster OpenTelemetry Collector pod (NOT the compose collector via the VM-host alias). The in-cluster collector relays traces to the compose collector for the duration of the transition; the eventual `bridge-collectors-to-obs-cluster` slice replaces the collector's exporter target without touching the backend.

#### Scenario: Deployment sets the OTLP endpoint to the in-cluster Service FQDN
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318`
- **AND** the value's host is the in-cluster Service FQDN (NOT `host.docker.internal`, NOT `host.lima.internal`, NOT `localhost`, NOT a hardcoded IP)
- **AND** the value's port is `4318`

#### Scenario: Backend does not reference the VM-host alias for OTLP
- **WHEN** a reader greps `infra/k8s/base/backend/deployment.yaml` for `host.lima.internal:4318` or `host.docker.internal:4318`
- **THEN** no occurrence is found
