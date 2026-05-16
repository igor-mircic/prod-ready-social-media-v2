## MODIFIED Requirements

### Requirement: The frontend pod reverse-proxies `/api/*` and `/actuator/*` to the in-cluster backend Service

The frontend pod's nginx config SHALL forward HTTP requests matching path prefixes `/api/` and `/actuator/` to the in-cluster backend ClusterIP Service via the FQDN `backend.social.svc.cluster.local:8080`. The frontend pod's nginx config SHALL ALSO forward HTTP requests matching the path prefix `/v1/` to the in-cluster collector ClusterIP Service via the FQDN `collector.social.svc.cluster.local:4318` (this is the OTLP/HTTP receiver port for the slice-18a app collector, used by browser OTLP for traces, logs, and metrics under `/v1/traces`, `/v1/logs`, `/v1/metrics`). All other paths SHALL be served from the static bundle under `/usr/share/nginx/html`, with a single-page-application fallback: any unmatched path under `/` SHALL be served as `/index.html` (HTTP 200) so client-side routes deep-link correctly.

#### Scenario: nginx config forwards `/api/` to the backend Service

- **WHEN** a reader inspects the nginx config baked into the frontend image (e.g. `frontend/docker/nginx.conf`)
- **THEN** a `location /api/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`
- **AND** the block sets at least `proxy_set_header Host $host;`

#### Scenario: nginx config forwards `/actuator/` to the backend Service

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /actuator/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`

#### Scenario: nginx config forwards `/v1/` to the collector Service

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /v1/` block declares `proxy_pass http://collector.social.svc.cluster.local:4318;`
- **AND** the block sets at least `proxy_set_header Host $host;`
- **AND** the block does NOT include a CORS-related `add_header` (the same-origin shape means no preflight is involved).

#### Scenario: nginx config serves the SPA fallback

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /` block declares `try_files $uri $uri/ /index.html;`

#### Scenario: Pod-to-pod traffic actually reaches the backend

- **WHEN** the frontend and backend Deployments are both applied and Ready
- **AND** an operator port-forwards the frontend Service and issues `curl -sf http://localhost:<port>/actuator/health`
- **THEN** the response is HTTP 200 with body `{"status":"UP"}` (the backend's actuator response), demonstrating the proxy hop succeeded

#### Scenario: Pod-to-pod traffic actually reaches the collector via `/v1/`

- **WHEN** the frontend Deployment and the collector Deployment are both applied and Ready
- **AND** an operator port-forwards the frontend Service and issues a minimal valid OTLP/HTTP traces POST to `http://localhost:<port>/v1/traces`
- **THEN** the response is HTTP 2xx (the collector accepted the payload), demonstrating the proxy hop succeeded
- **AND** the request appears in `just collector-logs` for the app k3s collector pod.

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block — slice 18c moved browser OTLP to same-origin via the frontend nginx, so the collector's OTLP/HTTP receiver no longer needs CORS for any client), `batch` and `transform/redact-path-ids` processors, a `filter/frontend_only` processor (used only in the logs pipeline as defence in depth), a `health_check` extension exposing `:13133/` for kubelet probes, and the following exporters: `otlp/compose-relay` and `otlp/obs-cluster` (traces, both with `tls.insecure: true`, targeting `host.lima.internal:4317` and `host.lima.internal:14317` respectively), `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs` (logs, targeting the same hosts on their OTLP/HTTP ports `host.lima.internal:4318` and `host.lima.internal:14318`), and `otlphttp/compose-relay-metrics` and `otlphttp/obs-cluster-metrics` (metrics, same OTLP/HTTP host:port targets as the logs exporters).

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay, otlp/obs-cluster]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/frontend_only]`, `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.

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
- **AND** no `filter/drop_high_cardinality`, `transform/pii_scrub`, or `attributes/loki_labels` processor is declared in this slice

#### Scenario: `filter/frontend_only` processor is declared and used only in the logs pipeline

- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `filter/frontend_only` processor is declared that drops log records whose `resource.attributes["service.name"] != "frontend"`
- **AND** the processor appears in the `service.pipelines.logs.processors` list
- **AND** the processor does NOT appear in `service.pipelines.traces.processors` or `service.pipelines.metrics.processors`

#### Scenario: Exporters declare dual-write for all three signals

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/compose-relay` exporter is declared with `endpoint: host.lima.internal:4317` and `tls.insecure: true` (traces, OTLP/gRPC)
- **AND** an `otlp/obs-cluster` exporter is declared with `endpoint: host.lima.internal:14317` and `tls.insecure: true` (traces, OTLP/gRPC)
- **AND** an `otlphttp/compose-relay-logs` exporter is declared with `endpoint: http://host.lima.internal:4318` (logs, OTLP/HTTP)
- **AND** an `otlphttp/obs-cluster-logs` exporter is declared with `endpoint: http://host.lima.internal:14318` (logs, OTLP/HTTP)
- **AND** an `otlphttp/compose-relay-metrics` exporter is declared with `endpoint: http://host.lima.internal:4318` (metrics, OTLP/HTTP)
- **AND** an `otlphttp/obs-cluster-metrics` exporter is declared with `endpoint: http://host.lima.internal:14318` (metrics, OTLP/HTTP)

#### Scenario: Three pipelines fan out to both compose and obs destinations

- **WHEN** a reader inspects the `service.pipelines:` block in the collector config
- **THEN** exactly three pipelines are declared: `traces`, `logs`, and `metrics`
- **AND** each pipeline's `receivers` list contains `otlp`
- **AND** the `traces` pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the `traces` pipeline's `exporters` list contains both `otlp/compose-relay` and `otlp/obs-cluster`
- **AND** the `logs` pipeline's `processors` list is `[batch, transform/redact-path-ids, filter/frontend_only]` in that order
- **AND** the `logs` pipeline's `exporters` list contains both `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs`
- **AND** the `metrics` pipeline's `processors` list is `[batch]`
- **AND** the `metrics` pipeline's `exporters` list contains both `otlphttp/compose-relay-metrics` and `otlphttp/obs-cluster-metrics`

#### Scenario: health_check extension is enabled and registered with the service block

- **WHEN** a reader inspects the collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`
