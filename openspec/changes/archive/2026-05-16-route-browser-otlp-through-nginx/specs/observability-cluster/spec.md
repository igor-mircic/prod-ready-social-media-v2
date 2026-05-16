## MODIFIED Requirements

### Requirement: The obs collector ConfigMap declares the OTLP-receiver → batch → redact → otlp/tempo pipeline

The obs collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `observability` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block), `batch` and `transform/redact-path-ids` processors (OTTL statements identical to the app cluster collector's, including `url.path` alongside the deprecated `http.url`/`http.target`/`url.full` attributes), a `health_check` extension on `:13133/`, and three exporters: `otlp/tempo` pointing at `tempo.observability.svc.cluster.local:4317` with `tls.insecure: true` (traces), `otlphttp/loki` pointing at `http://loki.observability.svc.cluster.local:3100/otlp` with `tls.insecure: true` (logs, using Loki 3.x's native OTLP ingest path), and `prometheusremotewrite/in-cluster` pointing at `http://prometheus-server.observability.svc.cluster.local/api/v1/write` with `tls.insecure: true` (metrics).

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/tempo]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlphttp/loki]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [prometheusremotewrite/in-cluster]`.

The redact-path-ids processor is defence-in-depth at this hop: every collector in the path applies the same redaction so a future regression at the app collector does not leak high-cardinality path segments into the obs cluster's storage.

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s-obs/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP without CORS

- **WHEN** a reader inspects the `receivers:` block in the obs collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`

#### Scenario: Redaction policy mirrors the app cluster collector and includes `url.path`

- **WHEN** a reader inspects the `processors:` block in the obs collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` target the attribute key `url.path` for every redaction pattern (UUID, opaque-hex, numeric)
- **AND** the OTTL statements also target `span.name`, `attributes["http.url"]`, `attributes["http.target"]`, `attributes["url.full"]` (kept as defence-in-depth for legacy instrumentation)
- **AND** the OTTL statements are byte-equivalent to those in `infra/k8s/base/collector/configmap.yaml` for the same set of patterns and attributes

#### Scenario: Traces exporter targets in-cluster tempo

- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** an exporter named `otlp/tempo` is declared
- **AND** its `endpoint` is `tempo.observability.svc.cluster.local:4317`
- **AND** its `tls.insecure` is `true`

#### Scenario: Logs exporter targets Loki's native OTLP endpoint

- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** an exporter named `otlphttp/loki` is declared
- **AND** its `endpoint` is `http://loki.observability.svc.cluster.local:3100/otlp` (Loki 3.x native OTLP ingest)
- **AND** its `tls.insecure` is `true`

#### Scenario: Metrics exporter targets prometheus remote-write

- **WHEN** a reader inspects the `exporters:` block in the obs collector config
- **THEN** an exporter named `prometheusremotewrite/in-cluster` (or chart-equivalent name) is declared
- **AND** its `endpoint` is `http://prometheus-server.observability.svc.cluster.local/api/v1/write`
- **AND** its `tls.insecure` is `true`

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

## ADDED Requirements

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
