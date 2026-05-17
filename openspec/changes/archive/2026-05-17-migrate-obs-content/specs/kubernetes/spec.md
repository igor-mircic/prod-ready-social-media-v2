## ADDED Requirements

### Requirement: The postgres-exporter Deployment lives at `infra/k8s/base/postgres-exporter/`

A new Deployment workload SHALL run a single `quay.io/prometheuscommunity/postgres-exporter:v0.17.1` pod in the `social` namespace of the app cluster. The directory SHALL contain a `kustomization.yaml`, a `deployment.yaml`, a `service.yaml`, and a `serviceaccount.yaml`. The image tag pin SHALL match the compose-side service in `docker-compose.yml` so the two exporters emit byte-identical metric families and labels during the parity window. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./postgres-exporter` in its `resources:` array.

#### Scenario: Base kustomization includes the postgres-exporter

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a Deployment named `postgres-exporter` in the `social` namespace
- **AND** the pod-spec image is `quay.io/prometheuscommunity/postgres-exporter:v0.17.1`
- **AND** the Deployment's `replicas:` is `1`

#### Scenario: Image tag matches the compose-side exporter

- **WHEN** a reader compares the Deployment's image tag with the compose service's image tag at `docker-compose.yml`
- **THEN** the tag string after the colon is identical

### Requirement: The postgres-exporter pod reaches postgres via the in-cluster Service DNS

The pod SHALL load Postgres credentials from the existing `postgres-credentials` Secret in the `social` namespace (the same Secret the backend uses, established in slice 14). The pod SHALL declare `DATA_SOURCE_USER`, `DATA_SOURCE_PASS`, and `DATA_SOURCE_URI` env vars; `DATA_SOURCE_URI` SHALL target `postgres.social.svc.cluster.local:5432/social?sslmode=disable`. The pod SHALL NOT declare any `host.docker.internal` reference (compose-only host-loopback alias).

#### Scenario: Credentials load from the postgres-credentials Secret

- **WHEN** a reader inspects `infra/k8s/base/postgres-exporter/deployment.yaml`
- **THEN** the pod-spec env list declares `DATA_SOURCE_USER` and `DATA_SOURCE_PASS` with `valueFrom.secretKeyRef.name: postgres-credentials`
- **AND** the key names match those the backend Deployment already uses (slice 14)

#### Scenario: DATA_SOURCE_URI targets the in-cluster postgres Service

- **WHEN** a reader inspects the pod-spec env list
- **THEN** the `DATA_SOURCE_URI` value contains `postgres.social.svc.cluster.local:5432`
- **AND** no env or arg references `host.docker.internal`

### Requirement: The postgres-exporter loads the `pg_stat_statements` custom-queries projection via a kustomize-generated ConfigMap

The kustomization at `infra/k8s/base/postgres-exporter/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `postgres-exporter-queries` sourcing the file `infra/observability/postgres-exporter/queries.yaml` (the compose-side source of truth, which projects `pg_stat_statements` columns into Prometheus metrics — slice 12). The pod SHALL mount the generated ConfigMap at `/etc/postgres-exporter/` and SHALL declare `PG_EXPORTER_EXTEND_QUERY_PATH: /etc/postgres-exporter/queries.yaml`.

#### Scenario: Kustomization generates the queries ConfigMap

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a ConfigMap named with the `postgres-exporter-queries-` prefix (kustomize's hash suffix is permitted)
- **AND** the ConfigMap's `data:` map contains a key `queries.yaml` whose value is the content of `infra/observability/postgres-exporter/queries.yaml`

#### Scenario: Pod mounts the queries ConfigMap and reads the extend-query path

- **WHEN** a reader inspects the pod-spec
- **THEN** a `volumes:` entry references the `postgres-exporter-queries` ConfigMap
- **AND** a `volumeMounts:` entry mounts that volume at `/etc/postgres-exporter/`
- **AND** the env list declares `PG_EXPORTER_EXTEND_QUERY_PATH` with value `/etc/postgres-exporter/queries.yaml`

### Requirement: The postgres-exporter Service exposes ClusterIP on port 9187

A `Service/postgres-exporter` SHALL be defined in `infra/k8s/base/postgres-exporter/service.yaml` of type `ClusterIP` exposing port `9187` and selecting the Deployment's pod label. The Service's DNS name `postgres-exporter.social.svc.cluster.local` SHALL be the only address other workloads dial to scrape the exporter; no NodePort or LoadBalancer is required for this slice.

#### Scenario: Service is ClusterIP on 9187

- **WHEN** a reader inspects `infra/k8s/base/postgres-exporter/service.yaml`
- **THEN** the Service's `type:` is `ClusterIP`
- **AND** the `ports:` list contains exactly one entry with `port: 9187`, `targetPort: metrics` (or `9187`), and `protocol: TCP`

#### Scenario: Service selector matches the Deployment's pod label

- **WHEN** a reader inspects the Service's `selector:` block and the Deployment's `spec.template.metadata.labels:` block
- **THEN** every key/value in the Service selector also appears in the Deployment's pod-template labels

### Requirement: The app collector ConfigMap declares a `prometheus` receiver scraping postgres-exporter

The collector ConfigMap at `infra/k8s/base/collector/configmap.yaml` SHALL declare a `prometheus` receiver named `prometheus/postgres-exporter` under `receivers:` configured to scrape `postgres-exporter.social.svc.cluster.local:9187/metrics` every 15s under `job_name: postgres-exporter`. The `metrics:` pipeline SHALL list `prometheus/postgres-exporter` alongside its existing receivers; no other pipeline (`traces:`, `logs:`) SHALL reference the new receiver. The pipeline's exporter list and processor list SHALL be unchanged.

#### Scenario: Receiver block declares the scrape target

- **WHEN** a reader inspects the collector ConfigMap
- **THEN** the `receivers:` block contains an entry named `prometheus/postgres-exporter`
- **AND** the entry declares `config.scrape_configs:` with a single job `postgres-exporter`
- **AND** that job's `static_configs:` lists `postgres-exporter.social.svc.cluster.local:9187` as the only target
- **AND** the job's `scrape_interval` is `15s` and `metrics_path` is `/metrics`

#### Scenario: Receiver joins the metrics pipeline only

- **WHEN** a reader inspects the `service.pipelines.metrics:` block
- **THEN** the `receivers:` list contains `prometheus/postgres-exporter`
- **AND** the `traces:` pipeline's `receivers:` list does NOT contain `prometheus/postgres-exporter`
- **AND** the `logs:` pipeline's `receivers:` list does NOT contain `prometheus/postgres-exporter`

#### Scenario: `pg_*` series arrive at both prometheus instances after the apply

- **GIVEN** the slice has been applied to a running cluster
- **AND** both compose (`:9090`) and obs (`:3001`) prometheus instances are up
- **WHEN** a reader queries `pg_stat_database_numbackends{datname="social"}` against each
- **THEN** both return at least one series with the same value (the fan-out at the gateway delivers the same scrape result to both)
