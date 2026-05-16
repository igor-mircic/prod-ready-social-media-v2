## REMOVED Requirements

### Requirement: An in-cluster backend pod sends OTLP to the host-side collector via the VM-host alias

**Reason:** This requirement was declared explicitly transitional by slice 15: its text foreshadowed "The slice that migrates the collector into the cluster SHALL replace the target with an in-cluster Service DNS name; this requirement SHALL be revised or removed at that time." This is that slice. The successor requirement below ("An in-cluster backend pod sends OTLP to the in-cluster collector Service") replaces it.

**Migration:** No data migration is required — the change is a one-line edit to `infra/k8s/base/backend/deployment.yaml` setting `OTEL_EXPORTER_OTLP_ENDPOINT` to the in-cluster Service FQDN. The compose collector continues to receive the relayed traces from the new in-cluster collector, so dashboards in compose grafana are unaffected by the migration.

## ADDED Requirements

### Requirement: An in-cluster backend pod sends OTLP to the in-cluster collector Service

When the backend runs inside the local k3s cluster (the side-channel path introduced by `add-local-k3s-backend`), its OpenTelemetry Java agent SHALL send OTLP traffic to the in-cluster OpenTelemetry Collector Service at `collector.social.svc.cluster.local:4318` (OTLP/HTTP). The Deployment manifest SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` to this exact value. The host-run backend's OTLP transport (`localhost:4318` via the build-wired defaults) SHALL be unaffected — the host loop continues to ship to the compose collector directly.

This requirement is transitional with respect to the collector's exporter target, not its receiver target: the in-cluster collector relays incoming spans to the compose collector via the VM-host alias for the duration of this slice. The `bridge-collectors-to-obs-cluster` slice replaces the relay target without touching this requirement.

#### Scenario: In-cluster backend Deployment sets the OTLP endpoint to the in-cluster Service
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318`

#### Scenario: Host-run backend OTLP transport is unchanged
- **WHEN** a reader inspects `backend/src/main/resources/application.yaml` and `backend/build.gradle.kts` for OTel-related defaults
- **THEN** the host-run agent's `OTEL_EXPORTER_OTLP_ENDPOINT` resolution is unchanged from the prior slice
- **AND** running `./gradlew bootRun` produces an agent process that sends OTLP to `http://localhost:4318` as before

#### Scenario: Both paths land in the compose collector during this slice
- **WHEN** an operator runs both the host backend (`./gradlew bootRun`) and the in-cluster backend (`just backend-apply`) simultaneously with the `observability` compose profile up
- **AND** the operator generates traffic against both
- **THEN** the compose collector's `otelcol_receiver_accepted_spans` (or equivalent) metric increments for both sources
- **AND** Tempo shows traces originating from both `service.instance.id` values
- **AND** the in-cluster backend's spans reach Tempo via the in-cluster collector relay (NOT directly from the backend pod)

### Requirement: The in-cluster collector relays traces to the compose collector via the VM-host alias

The in-cluster OpenTelemetry Collector introduced by this slice SHALL include exactly one trace exporter pointing at the compose collector's published OTLP/gRPC port (`host.lima.internal:4317`, `tls.insecure: true`). This relay is transitional: the `bridge-collectors-to-obs-cluster` slice replaces the exporter target with the obs cluster's OTLP receiver. The relay is the slice's mechanism for preserving end-to-end visibility through the transition — the compose collector continues to do every other thing it does today (browser FE traces / metrics / logs, host BE filelog), and now also receives in-cluster BE traces from the relay instead of directly.

#### Scenario: Collector ConfigMap declares a single OTLP exporter targeting the compose host alias
- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the `exporters:` block declares exactly one OTLP exporter
- **AND** the exporter's `endpoint` is `host.lima.internal:4317`
- **AND** the exporter's `tls.insecure` is `true`

#### Scenario: Spans flow end-to-end through the relay
- **WHEN** the in-cluster backend is running and traffic is generated against it
- **AND** the operator inspects `kubectl -n social logs deploy/collector --tail=200`
- **THEN** the collector logs report OTLP receive activity (non-zero accepted spans)
- **AND** the operator queries the compose collector container's logs OR the `social-collector` container's `otelcol_receiver_accepted_spans` metric
- **AND** the compose collector also reports increasing accepted-span counts from the in-cluster relay

#### Scenario: Redaction policy is preserved through the relay
- **WHEN** the in-cluster backend serves a request whose path includes a UUID, opaque-hex segment, or numeric id (e.g. `/api/v1/users/c0ffee00-1234-5678-9abc-deadbeef0000/profile`)
- **AND** the resulting span lands in Tempo via the relay
- **THEN** the span's `name`, `attributes.http.url`, `attributes.http.target`, and `attributes.url.full` fields show the high-cardinality segment replaced with the literal token `{id}`
