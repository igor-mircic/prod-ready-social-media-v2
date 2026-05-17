## MODIFIED Requirements

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block — slice 18c moved browser OTLP to same-origin via the frontend nginx, so the collector's OTLP/HTTP receiver no longer needs CORS for any client), `batch` and `transform/redact-path-ids` processors, a `filter/exclude_observability_self` processor (used only in the logs pipeline as defence-in-depth against feedback loops if the log-agent's namespace scope is ever widened to include the observability cluster's own pods), a `health_check` extension exposing `:13133/` for kubelet probes, and the following exporters:

- `otlp/compose-relay` (traces, OTLP/gRPC) targeting `host.lima.internal:4317` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-logs` (logs, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-metrics` (metrics, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlp/obs-cluster` (traces, OTLP/gRPC) targeting `host.lima.internal:14317` with a `tls:` block declaring `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`. The endpoint stays scheme-less (gRPC clients select transport via the `tls:` block, not the URL scheme).
- `otlphttp/obs-cluster-logs` (logs, OTLP/HTTP) targeting `https://host.lima.internal:14318` with a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`. URL scheme is `https://` because OTLP/HTTP exporters select transport via the URL scheme.
- `otlphttp/obs-cluster-metrics` (metrics, OTLP/HTTP) targeting `https://host.lima.internal:14318` with the same `tls:` block as the logs exporter.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay, otlp/obs-cluster]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/exclude_observability_self]`, `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.

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
- **AND** the `logs` pipeline's `processors` list is `[batch, transform/redact-path-ids, filter/exclude_observability_self]` in that order
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

#### Scenario: Browser FE error logs still flow through the renamed filter

- **WHEN** a browser FE error is captured by the frontend SDK and pushed via OTLP/HTTP through the frontend nginx proxy to the gateway collector
- **AND** the record reaches the `filter/exclude_observability_self` processor
- **THEN** the record passes the filter (its `resource.attributes["k8s.namespace.name"]` is absent or null, not `observability`)
- **AND** the record continues through the dual-write to both `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs`
- **AND** the record appears in obs grafana → Explore → Loki for `service.name=frontend`

## ADDED Requirements

### Requirement: The log-agent DaemonSet lives at `infra/k8s/base/log-agent/`

The repository SHALL contain a Kustomize directory at `infra/k8s/base/log-agent/` declaring an OpenTelemetry Collector DaemonSet that runs one pod per node in the app cluster and ships node-local pod logs to the gateway collector. The directory SHALL contain at minimum: `kustomization.yaml`, `daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, and `rbac.yaml`. The image SHALL be `otel/opentelemetry-collector-contrib:0.111.0` — the same pin used by the gateway collector, the compose collector, and the obs cluster collector.

#### Scenario: log-agent directory follows the established layout

- **WHEN** a reader lists `infra/k8s/base/log-agent/`
- **THEN** the directory contains `kustomization.yaml`, `daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, and `rbac.yaml`
- **AND** each file is referenced from the directory's `kustomization.yaml` `resources:` block

#### Scenario: DaemonSet image is pinned to the project-wide contrib collector tag

- **WHEN** a reader inspects `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** the container's `image` is `otel/opentelemetry-collector-contrib:0.111.0`
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`
- **AND** the ConfigMap is mounted read-only at `/etc/otelcol-contrib/`

#### Scenario: DaemonSet is listed in the base kustomization index

- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the `resources:` block includes `./log-agent` alongside `./postgres`, `./backend`, `./frontend`, and `./collector`

#### Scenario: Common labels mark the workload

- **WHEN** a reader inspects `infra/k8s/base/log-agent/kustomization.yaml`
- **THEN** the file declares a `commonLabels:` or `labels:` block setting `app.kubernetes.io/name: log-agent`

### Requirement: The log-agent DaemonSet tolerates all taints and mounts the host pod-log directory

The DaemonSet pod-spec SHALL declare a `tolerations:` entry that tolerates every taint (so the pod schedules on every node including the control-plane node in a single-node k3s cluster), SHALL mount the host's `/var/log/pods` directory read-only at the same in-pod path, and SHALL declare conservative CPU and memory `requests` and `limits` sized for the local Lima VM's 8 GiB envelope.

#### Scenario: Tolerations cover the control-plane taint

- **WHEN** a reader inspects the DaemonSet pod-spec in `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** the `tolerations:` list contains an entry `operator: Exists` with no `key:` or `value:`
- **AND** the pod schedules on the only node of a single-node k3s cluster

#### Scenario: hostPath mount of /var/log/pods is read-only

- **WHEN** a reader inspects the pod-spec
- **THEN** the pod's `volumes:` list contains a `hostPath` volume named `varlogpods` whose `path:` is `/var/log/pods`
- **AND** the container's `volumeMounts:` declares an entry mounting that volume at `/var/log/pods` with `readOnly: true`

#### Scenario: Container resources are declared

- **WHEN** a reader inspects the container's `resources:` block
- **THEN** `requests.cpu` and `requests.memory` are declared
- **AND** `limits.cpu` and `limits.memory` are declared
- **AND** `limits.memory` parses to at most `256Mi`

#### Scenario: DaemonSet pod-spec sets the service account

- **WHEN** a reader inspects the pod-spec
- **THEN** `spec.template.spec.serviceAccountName` is set to the ServiceAccount declared in `infra/k8s/base/log-agent/serviceaccount.yaml`

### Requirement: The log-agent ServiceAccount has cluster-scoped read on pods, namespaces, and replicasets

The repository SHALL declare a `ServiceAccount` in `infra/k8s/base/log-agent/serviceaccount.yaml` (in the `social` namespace) and a `ClusterRole` + `ClusterRoleBinding` in `infra/k8s/base/log-agent/rbac.yaml` granting the ServiceAccount read-only access (verbs: `get`, `list`, `watch`) to `pods`, `namespaces`, and `replicasets` across all namespaces. No write or admin verb SHALL be granted. The grant SHALL be cluster-scoped because the `k8sattributes` processor resolves pod metadata across namespace boundaries.

#### Scenario: ServiceAccount is declared in the social namespace

- **WHEN** a reader inspects `infra/k8s/base/log-agent/serviceaccount.yaml`
- **THEN** the file declares a `ServiceAccount` resource
- **AND** no `Secret` or token resource is created alongside (the projected-token mechanism mounts automatically)

#### Scenario: ClusterRole verbs are read-only on the documented resource kinds

- **WHEN** a reader inspects `infra/k8s/base/log-agent/rbac.yaml`
- **THEN** the file declares a `ClusterRole` whose `rules:` grants verbs `get`, `list`, `watch` on resource kinds `pods`, `namespaces`, `replicasets`
- **AND** no rule grants `create`, `update`, `patch`, `delete`, or any wildcard verb
- **AND** no rule grants access to resource kinds outside `pods`, `namespaces`, `replicasets`

#### Scenario: ClusterRoleBinding binds the ClusterRole to the ServiceAccount

- **WHEN** a reader inspects `infra/k8s/base/log-agent/rbac.yaml`
- **THEN** the file declares a `ClusterRoleBinding` whose `roleRef:` points at the ClusterRole declared in the same file
- **AND** whose `subjects:` references the ServiceAccount declared in `serviceaccount.yaml` (by name and namespace `social`)

### Requirement: The log-agent ConfigMap declares the filelog → k8sattributes → batch → otlp pipeline

The log-agent's runtime configuration SHALL live in a `ConfigMap` named `log-agent-config` in the `social` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare:

- A `filelog` receiver whose `include:` glob is exactly `/var/log/pods/social_*/*/*.log` (the social namespace's pods plus, by inclusion, the log-agent's own pods which run in `social`). The receiver SHALL declare a `start_at: beginning` (so a fresh pod re-reads existing files) and an `operators:` chain that (a) strips the CRI envelope (`container` parser or equivalent), (b) routes on whether the body starts with `{` after optional whitespace, (c) JSON-parses the routed branch with `on_error: send_quiet`, promoting `timestamp`, `level`, `message`, `trace_id`, and `span_id` to log-record fields, (d) maps `level` to `severity_text` and `severity_number`.
- A `k8sattributes` processor with `auth_type: serviceAccount` and an `extract:` block that pulls `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`, and the workload-level label `app.kubernetes.io/name`.
- A `batch` processor.
- An `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true` (in-cluster plaintext gRPC).
- A `health_check` extension on `:13133/` and a `service.extensions:` entry registering it.

The declared pipelines SHALL be exactly one:

- `logs`, with `receivers: [filelog]`, `processors: [k8sattributes, batch]`, `exporters: [otlp]`.

No `traces` or `metrics` pipeline SHALL be declared in the log-agent ConfigMap.

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s/base/log-agent/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the daemonset mounts this ConfigMap at `/etc/otelcol-contrib/`
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`

#### Scenario: filelog receiver is scoped to social namespace pods

- **WHEN** a reader inspects the `receivers:` block in the log-agent config
- **THEN** a `filelog` receiver is declared with an `include:` glob exactly matching `/var/log/pods/social_*/*/*.log`
- **AND** no other namespace prefix (e.g. `kube-system_*`, `default_*`, `observability_*`) appears in the include list
- **AND** `start_at: beginning` is declared

#### Scenario: filelog operators chain handles CRI envelope and JSON parsing

- **WHEN** a reader inspects the filelog receiver's `operators:` block
- **THEN** an operator strips the CRI envelope before the body is examined
- **AND** a `router` operator branches on whether the body matches a JSON-shaped predicate (start-of-line `{` after optional whitespace)
- **AND** a `json_parser` operator on the JSON branch declares `on_error: send_quiet` (so a malformed line falls back to raw text rather than dropping)
- **AND** the JSON branch promotes inner fields `timestamp`, `level`, `message`, `trace_id`, `span_id` to log-record fields (timestamp → record timestamp, level → severity, message → body)

#### Scenario: trace correlation fields are normalized to underscored form

- **WHEN** the JSON branch parses a backend log line whose body contains MDC keys `trace.id` and `span.id` (the OTel dotted convention used by the backend's logback config)
- **THEN** the resulting log record carries `trace_id` and `span_id` as the underscored top-level fields Grafana's trace-to-logs correlation expects
- **AND** no dotted `trace.id` / `span.id` field survives on the record

#### Scenario: k8sattributes processor extracts the documented attribute set

- **WHEN** a reader inspects the `processors:` block in the log-agent config
- **THEN** a `k8sattributes` processor is declared with `auth_type: serviceAccount`
- **AND** the processor's `extract.metadata:` (or chart-equivalent) lists `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`
- **AND** the processor's `extract.labels:` (or chart-equivalent) lists `app.kubernetes.io/name`

#### Scenario: Exporter targets the in-cluster gateway and stays plaintext

- **WHEN** a reader inspects the `exporters:` block in the log-agent config
- **THEN** an `otlp` exporter is declared with `endpoint: collector.social.svc.cluster.local:4317` and `tls.insecure: true`
- **AND** no `otlphttp/*` exporter is declared
- **AND** no cross-cluster endpoint (`host.lima.internal:14317`, `host.lima.internal:14318`) is referenced

#### Scenario: One logs pipeline and no other pipelines

- **WHEN** a reader inspects the `service.pipelines:` block in the log-agent config
- **THEN** exactly one pipeline is declared: `logs`
- **AND** the pipeline's `receivers` list is `[filelog]`
- **AND** the pipeline's `processors` list is `[k8sattributes, batch]` in that order
- **AND** the pipeline's `exporters` list is `[otlp]`
- **AND** no `traces` or `metrics` pipeline is declared

#### Scenario: health_check extension is registered

- **WHEN** a reader inspects the log-agent config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

### Requirement: The log-agent container declares liveness and readiness probes against the health_check extension

The log-agent container SHALL declare a `livenessProbe` and a `readinessProbe`, both HTTP GETs against the named `healthcheck` container port (the contrib collector's bundled `health_check` extension on port `13133`). The probes SHALL NOT target an OTLP port (the agent does not expose OTLP; it is a client).

#### Scenario: Both probes target the healthcheck port

- **WHEN** a reader inspects the log-agent container spec in `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** `livenessProbe.httpGet.port` is the named port `healthcheck` (or its numeric equivalent `13133`)
- **AND** `readinessProbe.httpGet.port` is the same port
- **AND** the path is `/`
- **AND** the container declares a `containerPorts:` entry `name: healthcheck, containerPort: 13133`

### Requirement: Backend pod logs land in obs grafana's Loki end-to-end with k8s attributes as label dimensions

When the app cluster's log-agent DaemonSet is applied, the gateway collector's renamed filter is applied, the obs cluster is up, and the backend pod has emitted at least one structured JSON log line, that log line SHALL appear in obs grafana → Explore → Loki when queried by k8s attributes. The log record SHALL carry `k8s.namespace.name=social`, `k8s.pod.name=backend-*`, `k8s.container.name=backend`, and `k8s.node.name=<the only node>` as label dimensions, and SHALL carry `trace_id` / `span_id` fields matching the same request's span in obs grafana's Tempo datasource.

#### Scenario: Operator queries backend pod logs in obs grafana

- **WHEN** the operator runs `just k8s-apply` against a cluster where the obs cluster is also up
- **AND** the operator runs `just backend-forward` and issues a request that the backend logs at INFO
- **AND** the operator opens obs grafana → Explore → Loki
- **AND** queries `{k8s_namespace_name="social", k8s_container_name="backend"}` (or the chart-driven label-name equivalent)
- **THEN** at least one log entry is returned within 30 seconds
- **AND** the entry's body matches the backend logback line for the same request

#### Scenario: Backend pod log line is byte-equivalent to kubectl logs

- **WHEN** the operator runs `kubectl logs deploy/backend -n social --tail=1` immediately after the backend logs a line
- **AND** queries the same line in obs grafana → Explore → Loki within 30 seconds
- **THEN** the body content of the Loki entry equals the body content of the `kubectl logs` line
- **AND** any structured JSON fields present in `kubectl logs` (timestamp, level, message, trace_id) are also present as attributes on the Loki entry

#### Scenario: Trace correlation works from a Loki entry to its Tempo span

- **WHEN** the operator opens a Loki entry that has a `trace_id` field
- **AND** clicks the "View trace" / trace-link action in grafana
- **THEN** grafana navigates to obs Tempo and renders the trace whose ID matches the log entry's `trace_id`

### Requirement: A `just` recipe surface drives the log-agent lifecycle

The repo-root `justfile` SHALL declare two recipes covering the log-agent's daily verbs: log tailing and rolling restart. Recipe names SHALL follow the `log-agent-<verb>` convention, mirroring the `collector-<verb>` and `obs-collector-<verb>` conventions from earlier slices.

#### Scenario: `just --list` enumerates the log-agent verbs

- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least `log-agent-logs` and `log-agent-rollout`

#### Scenario: `log-agent-logs` targets the DaemonSet

- **WHEN** a reader inspects the `log-agent-logs` recipe in `justfile`
- **THEN** the recipe runs `kubectl logs -n social daemonset/log-agent` (or `-l app.kubernetes.io/name=log-agent` equivalent) with a tail / follow flag

#### Scenario: `log-agent-rollout` issues rollout-restart against the DaemonSet and waits

- **WHEN** an operator runs `just log-agent-rollout`
- **THEN** the recipe issues `kubectl rollout restart daemonset/log-agent -n social`
- **AND** waits for the rollout to complete via `kubectl rollout status` before returning

### Requirement: The Hetzner overlay declares a commented stub for the log-agent

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the log-agent: production resource caps tuned to the multi-node Hetzner box's node count, optional namespace scope widening (with the corresponding Loki retention review), and structured-log volume implications for the obs cluster's Loki PVC sizing. The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the log-agent additions a future slice will plug in

- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, potential namespace-scope widening, and Loki retention implications the Hetzner slice will weigh for the log-agent
- **AND** none of those declarations are uncommented in this slice

### Requirement: README documents the k3s pod log shipping path

The top-level `README.md` SHALL gain a "k3s pod log shipping" subsection (under the existing "Local observability" / "Log shipping" section) documenting: the agent's namespace scope (`social` only), the apply-once-and-go behavior (the base kustomization already lists `./log-agent`), the expected end-to-end loop (apply → trigger backend traffic → see logs in obs grafana → Explore → Loki), the trace-to-logs correlation in grafana, and the documented non-goals (no `kube-system`, no audit logs, no log-based alerting).

#### Scenario: README has the new subsection

- **WHEN** a reader inspects `README.md`
- **THEN** a subsection titled (or equivalent to) "k3s pod log shipping" exists under the "Local observability" / "Log shipping" tree
- **AND** the subsection names the `social`-only scope
- **AND** the subsection describes the end-to-end loop with copy-pasteable commands (`just k8s-apply`, `just backend-forward`, `just obs-grafana`)

#### Scenario: README documents the non-goals

- **WHEN** a reader inspects the new subsection
- **THEN** an explicit non-goals paragraph names what slice 20 deliberately did not ship (no `kube-system` / `default` namespace scope, no audit logs, no log-based alerting, no retention tuning)
