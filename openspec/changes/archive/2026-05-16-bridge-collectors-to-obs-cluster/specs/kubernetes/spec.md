## MODIFIED Requirements

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block), `batch` and `transform/redact-path-ids` processors, a `health_check` extension exposing `:13133/` for kubelet probes, and exactly two exporters: `otlp/compose-relay` pointing at `host.lima.internal:4317` with `tls.insecure: true`, and `otlp/obs-cluster` pointing at `host.lima.internal:14317` with `tls.insecure: true`. The single declared pipeline SHALL be `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay, otlp/obs-cluster]`. No metrics or logs pipeline SHALL be declared in this slice.

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

#### Scenario: Exporters declare both the compose relay and the obs-cluster cross-cluster path
- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** exactly two exporters are declared: `otlp/compose-relay` and `otlp/obs-cluster`
- **AND** `otlp/compose-relay.endpoint` is `host.lima.internal:4317` with `tls.insecure: true`
- **AND** `otlp/obs-cluster.endpoint` is `host.lima.internal:14317` with `tls.insecure: true`

#### Scenario: One traces pipeline that fans out to both exporters; no metrics or logs pipelines
- **WHEN** a reader inspects the `service.pipelines:` block in the collector config
- **THEN** exactly one pipeline named `traces` is declared
- **AND** the pipeline's `receivers` list contains `otlp`
- **AND** the pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the pipeline's `exporters` list contains both `otlp/compose-relay` and `otlp/obs-cluster`
- **AND** no `metrics`, `logs/backend`, or `logs/frontend` pipeline is declared

#### Scenario: health_check extension is enabled and registered with the service block
- **WHEN** a reader inspects the collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

### Requirement: The Hetzner overlay declares a commented stub for the collector

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the collector: production resource caps, the cross-cluster exporter endpoint (the production-side obs-cluster receiver address — the local mirror's `host.lima.internal:14317` becomes the obs box's private-network IP), TLS / mTLS material reference, tighter probe timings, anti-affinity considerations if multi-node, and a note that dual-write to the compose collector MUST NOT be carried into production (slice 22 collapses dual-write before any prod cutover). The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the collector additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, cross-cluster exporter endpoint, TLS material, and probe-timing changes the Hetzner slice will add for the collector
- **AND** the commented narrative explicitly warns that dual-write to the compose collector is local-only and MUST NOT be inherited by the Hetzner deploy
- **AND** none of those declarations are uncommented in this slice
