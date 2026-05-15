## ADDED Requirements

### Requirement: An in-cluster backend pod sends OTLP to the host-side collector via the VM-host alias

When the backend runs inside the local k3s cluster (the side-channel path introduced by `add-local-k3s-backend`), its OpenTelemetry Java agent SHALL send OTLP traffic to the still-in-compose OTel collector via the VM-host alias hostname on port `4318`. The Deployment manifest SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` accordingly. The host-run backend's OTLP transport (`localhost:4318` via `OTEL_EXPORTER_OTLP_ENDPOINT` defaults wired in earlier slices) SHALL be unaffected by this requirement — both paths target the same collector and are simultaneously valid.

This requirement is explicitly transitional. The slice that migrates the collector into the cluster SHALL replace the target with an in-cluster Service DNS name; this requirement SHALL be revised or removed at that time.

#### Scenario: In-cluster backend Deployment sets the OTLP endpoint to the host alias
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT`
- **AND** the value's host is the VM-host alias (`host.docker.internal` or `host.lima.internal`, per the slice's design decision)
- **AND** the value's port is `4318`

#### Scenario: Host-run backend OTLP transport is unchanged
- **WHEN** a reader inspects `backend/src/main/resources/application.yaml` and `backend/build.gradle.kts` for OTel-related defaults
- **THEN** the host-run agent's `OTEL_EXPORTER_OTLP_ENDPOINT` resolution is unchanged from the prior slice
- **AND** running `./gradlew bootRun` produces an agent process that sends OTLP to `http://localhost:4318` as before

#### Scenario: Both paths route to the same compose-hosted collector
- **WHEN** an operator runs both the host backend (`./gradlew bootRun`) and the in-cluster backend (`just backend-apply`) simultaneously with the `observability` compose profile up
- **AND** the operator generates traffic against both
- **THEN** the OTel collector's `otelcol_receiver_accepted_spans` (or equivalent) metric increments for both sources
- **AND** Tempo shows traces originating from both `service.instance.id` values

### Requirement: The in-cluster backend image bakes the OTel agent so the attach mechanic matches the host loop

The OCI image produced by `./gradlew bootBuildImage` SHALL include the `opentelemetry-javaagent.jar` at a known in-image path AND SHALL set the container's process environment so the agent attaches at JVM startup without the operator needing to set any per-deploy flag. Concretely, the image SHALL set `JAVA_TOOL_OPTIONS=-javaagent:<in-image-path-to-the-agent-jar>` so a vanilla `java -jar <app.jar>` invocation inside the container attaches the agent identically to how the host loop attaches it.

#### Scenario: Image carries the agent jar at a known path
- **WHEN** an operator inspects the layers of the image produced by `./gradlew bootBuildImage`
- **THEN** the image contains a file named `opentelemetry-javaagent.jar` at a stable, documented path (e.g. `/workspace/agent/opentelemetry-javaagent.jar`)

#### Scenario: Image sets JAVA_TOOL_OPTIONS to attach the agent
- **WHEN** an operator runs `docker inspect <image>` and inspects `Config.Env`
- **THEN** the env list contains an entry of the form `JAVA_TOOL_OPTIONS=-javaagent:<path>` whose `<path>` matches the agent jar's in-image path

#### Scenario: Agent attaches at pod start without per-Deployment flag
- **WHEN** the backend pod is Running and the operator runs `kubectl logs -n social deploy/backend` against the first few seconds of startup
- **THEN** the logs include the OpenTelemetry Java agent's standard "[otel.javaagent ...] OpenTelemetry Javaagent" banner
- **AND** the Deployment manifest does NOT declare a `-javaagent:` arg under `command:` or `args:` (the env-driven attach is the slice's mechanism)
