## MODIFIED Requirements

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block — slice 18c moved browser OTLP to same-origin via the frontend nginx, so the collector's OTLP/HTTP receiver no longer needs CORS for any client), the slice-22a `prometheus/postgres-exporter` receiver scraping `postgres-exporter.social.svc.cluster.local:9187/metrics`, `batch` and `transform/redact-path-ids` processors, a `filter/exclude_observability_self` processor (used only in the logs pipeline as defence-in-depth against feedback loops if the log-agent's namespace scope is ever widened to include the observability cluster's own pods), a `health_check` extension exposing `:13133/` for kubelet probes, and the following exporters:

- `otlp/obs-cluster` (traces, OTLP/gRPC) targeting `host.lima.internal:14317` with a `tls:` block declaring `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`. The endpoint stays scheme-less (gRPC clients select transport via the `tls:` block, not the URL scheme).
- `otlphttp/obs-cluster-logs` (logs, OTLP/HTTP) targeting `https://host.lima.internal:14318` with a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`. URL scheme is `https://` because OTLP/HTTP exporters select transport via the URL scheme.
- `otlphttp/obs-cluster-metrics` (metrics, OTLP/HTTP) targeting `https://host.lima.internal:14318` with the same `tls:` block as the logs exporter.

The three `*compose-relay*` exporters (`otlp/compose-relay`, `otlphttp/compose-relay-logs`, `otlphttp/compose-relay-metrics`) that the slice-18a–c arc declared for the dual-write to the compose collector SHALL NOT be present. The slice that collapsed the dual-write back to obs-only (slice 22b) deleted them along with the compose observability stack.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/obs-cluster]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/exclude_observability_self]`, `exporters: [otlphttp/obs-cluster-logs]`.
- `metrics`, with `receivers: [otlp, prometheus/postgres-exporter]`, `processors: [batch]`, `exporters: [otlphttp/obs-cluster-metrics]`.

The cert files referenced by the three `*obs-cluster*` exporters SHALL resolve to a Secret-mounted volume at `/etc/otelcol-contrib/certs/` (declared by the Deployment / Kustomize per the cert-mount requirement).

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/` (so the in-pod file path is `/etc/otelcol-contrib/config.yaml`)
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP without CORS

- **WHEN** a reader inspects the `receivers:` block in the collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`

#### Scenario: Processors mirror the compose collector's redaction policy and include the modern `url.path` attribute

- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` target the attribute key `url.path` for every redaction pattern (UUID, opaque-hex, numeric)
- **AND** the OTTL statements also target `span.name`, `attributes["http.url"]`, `attributes["http.target"]`, `attributes["url.full"]` (kept as defence-in-depth for legacy instrumentation)
- **AND** no `filter/drop_high_cardinality`, `transform/pii_scrub`, or `attributes/loki_labels` processor is declared

#### Scenario: `filter/exclude_observability_self` processor is declared and used only in the logs pipeline

- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `filter/exclude_observability_self` processor is declared that drops log records whose `resource.attributes["k8s.namespace.name"] == "observability"`
- **AND** the processor appears in the `service.pipelines.logs.processors` list
- **AND** the processor does NOT appear in `service.pipelines.traces.processors` or `service.pipelines.metrics.processors`
- **AND** no processor named `filter/frontend_only` remains in the config

#### Scenario: No compose-relay exporters remain

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** no exporter named `otlp/compose-relay`, `otlphttp/compose-relay-logs`, or `otlphttp/compose-relay-metrics` is declared
- **AND** no exporter targets `host.lima.internal:4317`, `host.lima.internal:4318`, `http://host.lima.internal:4317`, or `http://host.lima.internal:4318` in plaintext

#### Scenario: Obs-cluster exporters present a client cert and verify against the shared CA

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/obs-cluster` exporter is declared with `endpoint: host.lima.internal:14317` (scheme-less)
- **AND** the exporter's `tls:` block declares `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-logs` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-metrics` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same cert files and `insecure: false`
- **AND** no `*obs-cluster*` exporter declares `tls.insecure: true`

#### Scenario: Three pipelines fan out to obs-cluster only

- **WHEN** a reader inspects the `service.pipelines:` block in the collector config
- **THEN** exactly three pipelines are declared: `traces`, `logs`, and `metrics`
- **AND** each pipeline's `receivers` list contains `otlp`
- **AND** the `metrics` pipeline's `receivers` list additionally contains `prometheus/postgres-exporter`
- **AND** the `traces` pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the `traces` pipeline's `exporters` list is exactly `[otlp/obs-cluster]`
- **AND** the `logs` pipeline's `processors` list is `[batch, transform/redact-path-ids, filter/exclude_observability_self]` in that order
- **AND** the `logs` pipeline's `exporters` list is exactly `[otlphttp/obs-cluster-logs]`
- **AND** the `metrics` pipeline's `processors` list is `[batch]`
- **AND** the `metrics` pipeline's `exporters` list is exactly `[otlphttp/obs-cluster-metrics]`

#### Scenario: health_check extension is enabled and registered with the service block

- **WHEN** a reader inspects the collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

#### Scenario: Cross-cluster handshake succeeds end-to-end on the local mirror

- **WHEN** the operator brings up both clusters via `just obs-up` (which auto-runs `just obs-certs` if certs are missing) and `just up` and applies both overlays
- **AND** generates backend traffic through the app cluster
- **THEN** the app collector logs show NO `tls: handshake error` lines against any `*obs-cluster*` exporter
- **AND** the obs collector receiver accepts the connection without "remote error: tls: bad certificate" entries
- **AND** the trace flows through to obs grafana on `:3001` end-to-end

#### Scenario: Browser FE error logs flow through the obs-only logs pipeline

- **WHEN** a browser FE error is captured by the frontend SDK and pushed via OTLP/HTTP through the frontend nginx proxy to the gateway collector
- **AND** the record reaches the `filter/exclude_observability_self` processor
- **THEN** the record passes the filter (its `resource.attributes["k8s.namespace.name"]` is absent or null, not `observability`)
- **AND** the record continues through to the `otlphttp/obs-cluster-logs` exporter (single destination, no dual-write)
- **AND** the record appears in obs grafana → Explore → Loki for `service.name=frontend`

### Requirement: The postgres-exporter loads the `pg_stat_statements` custom-queries projection via a kustomize-generated ConfigMap

The kustomization at `infra/k8s/base/postgres-exporter/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `postgres-exporter-queries` sourcing the local file `infra/k8s/base/postgres-exporter/queries.yaml` (the canonical projection of `pg_stat_statements` columns into Prometheus metrics — slice 12). The pod SHALL mount the generated ConfigMap at `/etc/postgres-exporter/` and SHALL declare `PG_EXPORTER_EXTEND_QUERY_PATH: /etc/postgres-exporter/queries.yaml`.

The `queries.yaml` file SHALL live under `infra/k8s/base/postgres-exporter/`; the cross-tree path `../../../observability/postgres-exporter/queries.yaml` that slice 22a used as a parity-window reference SHALL NOT be present (slice 22b relocated the file to its consumer-local home and deleted the compose-side copy).

#### Scenario: Kustomization generates the queries ConfigMap from a local-tree source

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a ConfigMap named with the `postgres-exporter-queries-` prefix (kustomize's hash suffix is permitted)
- **AND** the ConfigMap's `data:` map contains a key `queries.yaml` whose value is the content of `infra/k8s/base/postgres-exporter/queries.yaml`

#### Scenario: Kustomization sources the file from its consumer-local home, not the cross-tree compose path

- **WHEN** a reader inspects `infra/k8s/base/postgres-exporter/kustomization.yaml`
- **THEN** the `configMapGenerator:` entry's `files:` reference resolves to `queries.yaml` (a sibling of the kustomization file)
- **AND** the `files:` reference does NOT contain the substring `../../../observability/`
- **AND** no `infra/observability/postgres-exporter/queries.yaml` exists in the repository

#### Scenario: Pod mounts the queries ConfigMap and reads the extend-query path

- **WHEN** a reader inspects the pod-spec
- **THEN** a `volumes:` entry references the `postgres-exporter-queries` ConfigMap
- **AND** a `volumeMounts:` entry mounts that volume at `/etc/postgres-exporter/`
- **AND** the env list declares `PG_EXPORTER_EXTEND_QUERY_PATH` with value `/etc/postgres-exporter/queries.yaml`
