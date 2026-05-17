## ADDED Requirements

### Requirement: The app collector pod mounts the cross-cluster client-cert Secret

The collector container in `infra/k8s/base/collector/deployment.yaml` SHALL declare a second `volumeMount` named `certs` mounted read-only at `/etc/otelcol-contrib/certs/`, and the Deployment's `volumes:` block SHALL declare a corresponding `secret`-typed volume named `certs` referencing a Secret produced by a Kustomize `secretGenerator`. The secretGenerator entry in `infra/k8s/base/collector/kustomization.yaml` SHALL read the per-cluster certs directory `./certs/` (containing `client.crt`, `client.key`, and `ca.crt`) and SHALL NOT disable name suffixing (so a regenerated cert produces a new Secret name and the Deployment rolls automatically). The mounted directory SHALL be the same path the collector's exporter `tls:` blocks reference in `cert_file`, `key_file`, and `ca_file`.

#### Scenario: Deployment declares the certs volume and mount

- **WHEN** a reader inspects the collector container spec in `infra/k8s/base/collector/deployment.yaml`
- **THEN** the container's `volumeMounts:` list contains an entry `name: certs, mountPath: /etc/otelcol-contrib/certs, readOnly: true`
- **AND** the pod's `volumes:` list contains an entry `name: certs` of type `secret` whose `secretName` matches the Secret produced by the kustomization's secretGenerator
- **AND** the existing `config` volume mount at `/etc/otelcol-contrib/` is unchanged

#### Scenario: kustomization.yaml declares the secretGenerator for the app collector certs

- **WHEN** a reader inspects `infra/k8s/base/collector/kustomization.yaml`
- **THEN** the file declares a `secretGenerator:` block with an entry whose `name` is the Secret name referenced by the Deployment's `certs` volume
- **AND** the entry's `files:` list (or `envs:` if files: is not used) materializes `client.crt`, `client.key`, and `ca.crt` from `infra/k8s/base/collector/certs/`
- **AND** the generator does NOT set `disableNameSuffixHash: true` (so contents-hashed naming triggers automatic rollouts on cert regeneration)

#### Scenario: Per-directory `.gitignore` keeps private key out of git

- **WHEN** a reader inspects `infra/k8s/base/collector/certs/.gitignore` (or the repo-root `.gitignore` patterns)
- **THEN** the pattern excludes `client.key` (or `*.key`)
- **AND** `client.crt` and `ca.crt` are NOT excluded (they are public material and SHALL be committed)

## MODIFIED Requirements

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block — slice 18c moved browser OTLP to same-origin via the frontend nginx, so the collector's OTLP/HTTP receiver no longer needs CORS for any client), `batch` and `transform/redact-path-ids` processors, a `filter/frontend_only` processor (used only in the logs pipeline as defence in depth), a `health_check` extension exposing `:13133/` for kubelet probes, and the following exporters:

- `otlp/compose-relay` (traces, OTLP/gRPC) targeting `host.lima.internal:4317` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-logs` (logs, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-metrics` (metrics, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlp/obs-cluster` (traces, OTLP/gRPC) targeting `host.lima.internal:14317` with a `tls:` block declaring `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`. The endpoint stays scheme-less (gRPC clients select transport via the `tls:` block, not the URL scheme).
- `otlphttp/obs-cluster-logs` (logs, OTLP/HTTP) targeting `https://host.lima.internal:14318` with a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`. URL scheme is `https://` because OTLP/HTTP exporters select transport via the URL scheme.
- `otlphttp/obs-cluster-metrics` (metrics, OTLP/HTTP) targeting `https://host.lima.internal:14318` with the same `tls:` block as the logs exporter.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay, otlp/obs-cluster]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/frontend_only]`, `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.

The cert files referenced by the three `*obs-cluster*` exporters SHALL resolve to a Secret-mounted volume at `/etc/otelcol-contrib/certs/` (declared by the Deployment / Kustomize per the cert-mount requirement above).

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

#### Scenario: Compose-relay exporters remain plaintext

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/compose-relay` exporter is declared with `endpoint: host.lima.internal:4317` and `tls.insecure: true`
- **AND** an `otlphttp/compose-relay-logs` exporter is declared with `endpoint: http://host.lima.internal:4318` and `tls.insecure: true`
- **AND** an `otlphttp/compose-relay-metrics` exporter is declared with `endpoint: http://host.lima.internal:4318` and `tls.insecure: true`

#### Scenario: Obs-cluster exporters present a client cert and verify against the shared CA

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/obs-cluster` exporter is declared with `endpoint: host.lima.internal:14317` (scheme-less)
- **AND** the exporter's `tls:` block declares `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-logs` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-metrics` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same cert files and `insecure: false`
- **AND** no `*obs-cluster*` exporter declares `tls.insecure: true`

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

#### Scenario: Cross-cluster handshake succeeds end-to-end on the local mirror

- **WHEN** the operator brings up both clusters via `just obs-up` (which auto-runs `just obs-certs` if certs are missing) and `just up` and applies both overlays
- **AND** generates backend traffic through the app cluster
- **THEN** the app collector logs show NO `tls: handshake error` lines against any `*obs-cluster*` exporter
- **AND** the obs collector receiver accepts the connection without "remote error: tls: bad certificate" entries
- **AND** the trace flows through to obs grafana on `:3001` end-to-end
