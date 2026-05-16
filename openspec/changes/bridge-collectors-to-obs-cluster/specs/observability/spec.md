## MODIFIED Requirements

### Requirement: The in-cluster app collector dual-writes traces to the compose collector AND the obs cluster's collector

The in-cluster OpenTelemetry Collector running in the app cluster SHALL declare exactly two trace exporters: `otlp/compose-relay` pointing at the compose collector's published OTLP/gRPC port (`host.lima.internal:4317`, `tls.insecure: true`), and `otlp/obs-cluster` pointing at the obs cluster's collector OTLP/gRPC ingress (`host.lima.internal:14317`, `tls.insecure: true`). The single declared `traces` pipeline SHALL list BOTH exporters in its `exporters:` block. Failure or wedging of either exporter SHALL NOT block delivery via the other.

This dual-write is the migration window's mechanism for "build the new house before tearing down the old one" (the slice-17 design's sequencing): compose grafana continues to render the same traces it renders today, the obs grafana grows the same view alongside it, and slice 22 (`retire-compose-observability`) is the slice that collapses dual-write back to obs-only. Until then, an operator opening compose grafana and obs grafana side-by-side SHALL see identical backend trace data.

The obs-cluster path's address (`host.lima.internal:14317`) is the local mirror of the Hetzner reality (the obs box's private-network IP). The host-side port `:14317` is offset by `+10000` from the compose collector's `:4317` to avoid collision and to mirror the apiserver disambiguation from slice 17 (app `:16443`, obs `:16444`).

#### Scenario: Collector ConfigMap declares both OTLP exporters
- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the `exporters:` block declares exactly two OTLP exporters named `otlp/compose-relay` and `otlp/obs-cluster`
- **AND** `otlp/compose-relay.endpoint` is `host.lima.internal:4317` with `tls.insecure: true`
- **AND** `otlp/obs-cluster.endpoint` is `host.lima.internal:14317` with `tls.insecure: true`
- **AND** no other exporter is declared

#### Scenario: Traces pipeline fans out to both exporters
- **WHEN** a reader inspects the `service.pipelines.traces.exporters:` list in the collector config
- **THEN** the list contains exactly `[otlp/compose-relay, otlp/obs-cluster]` (order is not significant)
- **AND** no `loadbalancing` exporter is used (fan-out is to distinct destinations, not trace-aware sharding)

#### Scenario: Exporter failures are independent
- **WHEN** the obs VM is stopped (`limactl stop social-obs`) while the app cluster is running and serving traffic
- **AND** an operator inspects `kubectl -n social logs deploy/collector --context lima-social --tail=200`
- **THEN** the collector logs report repeated export errors for `otlp/obs-cluster`
- **AND** the collector continues to deliver spans via `otlp/compose-relay`
- **AND** the compose collector's `otelcol_receiver_accepted_spans` metric continues to increment
- **AND** compose grafana continues to render traces from the in-cluster backend

#### Scenario: Operator verifies identical trace data in both grafanas
- **WHEN** both clusters are running and the app collector has the dual-write configuration applied
- **AND** the operator generates a unique request against the in-cluster backend (e.g. by posting a new note via the frontend)
- **AND** the operator opens compose grafana → Explore → Tempo, queries `service.name=backend` in the last 5 minutes
- **AND** the operator opens obs grafana (`just obs-grafana`) → Explore → Tempo, queries the same time window
- **THEN** both grafanas show the trace corresponding to the unique request
- **AND** the trace IDs match across the two grafanas

#### Scenario: Redaction policy is preserved through both exporters
- **WHEN** the in-cluster backend serves a request whose path includes a UUID, opaque-hex segment, or numeric id (e.g. `/api/v1/users/c0ffee00-1234-5678-9abc-deadbeef0000/profile`)
- **AND** the resulting span lands in both compose tempo and obs tempo
- **THEN** the span's `name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full` fields show the high-cardinality segment replaced with the literal token `{id}` in BOTH backends
