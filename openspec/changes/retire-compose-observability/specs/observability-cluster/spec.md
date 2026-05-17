## REMOVED Requirements

### Requirement: CI asserts the parity-window rule copies stay byte-identical with compose-side originals

**Reason**: The compose-side rule files at `infra/observability/prometheus/rules/*.yml` are deleted in this slice. With no compose-side copies to diff against, the slice-22a `diff -q` guard has no counterparty and is removed from `.github/workflows/ci.yml` in the same commit that deletes the compose-side files.

**Migration**: CI rule validation continues via the `prometheus-rules` job's `promtool check rules` step, repointed from `infra/observability/prometheus/rules/*.yml` to `infra/k8s-obs/base/prometheus/rules/*.yml`. The `promtool test rules` step continues against the four `*-tests.yml` fixtures, relocated from `infra/observability/prometheus/rules/` to `infra/k8s-obs/base/prometheus/tests/` in this slice.

## MODIFIED Requirements

### Requirement: The obs Lima VM publishes the obs collector's OTLP ports on the macOS host with a +10000 offset

The obs VM's `infra/lima/obs.yaml` `portForwards:` block SHALL declare seven entries before the catch-all `ignore: true` rule. Each entry SHALL declare `guestIP: 0.0.0.0` so the host-side bind succeeds for Services backed by k3s's klipper-lb (svclb) ingress (project lesson: Lima 2.x portForwards remapping a LoadBalancer Service port require the explicit `guestIP: 0.0.0.0` setting):

- guestPort `4317` → hostPort `14317` (obs collector OTLP gRPC, +10000 offset, retained from slice 17)
- guestPort `4318` → hostPort `14318` (obs collector OTLP HTTP, +10000 offset, retained from slice 17)
- guestPort `9090` → hostPort `9090` (obs prometheus HTTP API, new in slice 22b — replaces the compose prometheus on the same host port)
- guestPort `3200` → hostPort `3200` (obs tempo HTTP API, new in slice 22b — replaces the compose tempo on the same host port)
- guestPort `3100` → hostPort `3100` (obs loki HTTP API, new in slice 22b — replaces the compose loki on the same host port)
- guestPort `9093` → hostPort `9093` (obs alertmanager HTTP API, new in slice 22b — replaces the compose alertmanager on the same host port)
- guestPort `8080` → hostPort `8081` (obs webhook-sink HTTP API; the obs Service binds `:8080` per slice 22a's chart-default discipline, but the e2e alerting spec's URL constant points at `:8081` — the Lima portForward absorbs the asymmetry so the spec stays unchanged, per design.md Decision 2)

The five new mappings (`:9090`, `:3200`, `:3100`, `:9093`, `:8081`) become operational the moment the compose `observability` profile stops binding those host ports — which is the same commit that deletes the compose services. No port-collision window exists.

The host-side ports for the OTLP receivers are deliberately offset by `+10000` from the in-VM Service ports, symmetric with the apiserver disambiguation (app `:16443`, obs `:16444`); this guarantees no collision with the app collector's host-side OTLP receivers and gives operators one consistent rule for "obs-cluster analogue of compose port X."

#### Scenario: obs.yaml publishes all seven portForwards before the catch-all

- **WHEN** a reader inspects the `portForwards:` block in `infra/lima/obs.yaml`
- **THEN** entries map `guestPort: 4317` → `hostPort: 14317` and `guestPort: 4318` → `hostPort: 14318`
- **AND** entries map `guestPort: 9090` → `hostPort: 9090`, `guestPort: 3200` → `hostPort: 3200`, `guestPort: 3100` → `hostPort: 3100`, `guestPort: 9093` → `hostPort: 9093`
- **AND** an entry maps `guestPort: 8080` → `hostPort: 8081` (the webhook-sink remap)
- **AND** every entry above declares `guestIP: 0.0.0.0`
- **AND** all seven entries appear BEFORE the catch-all `guestPortRange: [1, 65535], ignore: true` entry

#### Scenario: Host-side ports do NOT collide with anything post-22b

- **GIVEN** the slice has been applied (compose observability profile deleted) and the obs VM is up after Lima has applied this slice's portForwards
- **WHEN** an operator inspects host port bindings via `lsof -iTCP -sTCP:LISTEN -P -n | grep -E ':(4317|4318|9090|3200|3100|9093|8081|14317|14318)\b'`
- **THEN** `:14317`, `:14318`, `:9090`, `:3200`, `:3100`, `:9093`, and `:8081` are bound by the Lima port-forwarder
- **AND** no compose container is bound to any of those ports (the compose `observability` profile no longer exists)

#### Scenario: The five new portForwards reach the obs cluster Services end-to-end

- **GIVEN** the slice has been applied and the obs cluster's LGTM stack pods are Running
- **WHEN** an operator issues `curl -sS http://localhost:9090/-/healthy`, `curl -sS http://localhost:3200/ready`, `curl -sS http://localhost:3100/ready`, `curl -sS http://localhost:9093/-/healthy`, and `curl -sS http://localhost:8081/healthz`
- **THEN** every response is 2xx
- **AND** the response bodies (where applicable) identify the in-VM workload (`prometheus`, `tempo`, `loki`, `alertmanager`, `webhook-sink`)

### Requirement: A `webhook-sink` Deployment + Service runs in the `observability` namespace

A new Deployment workload SHALL run a single `webhook-sink` pod in the `observability` namespace of the obs cluster. The image SHALL be built from `infra/k8s-obs/base/webhook-sink/src/` (the Dockerfile + Node sources relocated from `infra/observability/webhook-sink/` in slice 22b) and pushed to the local OCI registry as `registry.local:5000/webhook-sink:dev` (same image flow as slice-15 backend/frontend). The Deployment manifests SHALL live at `infra/k8s-obs/base/webhook-sink/` with `kustomization.yaml`, `deployment.yaml`, and `service.yaml`. The base kustomization at `infra/k8s-obs/base/kustomization.yaml` SHALL list `./webhook-sink` in its `resources:` array. The `Service/webhook-sink` SHALL be of type `ClusterIP` exposing port `8080`; it SHALL be reachable from the alertmanager pod at `http://webhook-sink.observability.svc.cluster.local:8080`.

The obs Lima VM publishes the webhook-sink Service on the macOS host at `localhost:8081` via the portForward declared by the slice's portForwards requirement (host `:8081` → guest `:8080`); the asymmetry between the host port and the in-cluster port is intentional and described in design.md Decision 2.

#### Scenario: Kustomization includes the webhook-sink

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a Deployment named `webhook-sink` in the `observability` namespace
- **AND** the pod-spec image is `registry.local:5000/webhook-sink:dev`
- **AND** a `Service/webhook-sink` of type `ClusterIP` on port `8080` is present

#### Scenario: Image is built from the consumer-local source path

- **WHEN** a reader inspects the `just` recipe that builds the webhook-sink image
- **THEN** the recipe's `docker build` context is `infra/k8s-obs/base/webhook-sink/src/`
- **AND** no committed Dockerfile or Node source file remains under `infra/observability/webhook-sink/`

#### Scenario: Service selector matches the Deployment's pod labels

- **WHEN** a reader inspects the Service's `selector:` and the Deployment's pod-template labels
- **THEN** every key/value in the Service selector also appears in the Deployment's pod-template labels

#### Scenario: Alertmanager can reach the webhook-sink in-cluster

- **GIVEN** the slice has been applied and both pods are Running
- **WHEN** an operator runs `kubectl --context obs -n observability exec deploy/alertmanager -- wget -qO- http://webhook-sink.observability.svc.cluster.local:8080/healthz` (or the equivalent endpoint the image exposes)
- **THEN** the response is a 2xx HTTP status

#### Scenario: Host operator can reach the webhook-sink via the Lima portForward

- **GIVEN** the slice has been applied, the webhook-sink pod is Running, and the obs Lima VM is up with this slice's portForwards in effect
- **WHEN** an operator runs `curl -sS http://localhost:8081/healthz` from the macOS host
- **THEN** the response is a 2xx HTTP status (proving the host `:8081` → guest `:8080` remap reaches the in-cluster Service end-to-end)

### Requirement: The obs prometheus chart mounts the migrated rule files via a kustomize-generated ConfigMap

The kustomization at `infra/k8s-obs/base/prometheus/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `prometheus-extra-rules` sourcing every `.yml` file in the `infra/k8s-obs/base/prometheus/rules/` directory. The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL declare a `server.extraConfigmapMounts:` entry that mounts the generated ConfigMap at `/etc/prometheus-extra-rules/` inside the prometheus pod. The chart values SHALL override `serverFiles.prometheus.yml.rule_files:` to PRESERVE the chart-default entries (`/etc/config/recording_rules.yml`, `/etc/config/alerting_rules.yml`) AND APPEND `/etc/prometheus-extra-rules/*.yml` so the migrated rules are loaded at prometheus startup.

The `infra/k8s-obs/base/prometheus/rules/` directory SHALL contain `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, and `database-alerts.yml` as the canonical source of truth — they are no longer parity-window copies of a compose-side original (the compose-side originals are deleted in slice 22b). `container-alerts.yml` SHALL NOT be present — it is keyed on cadvisor-shaped series that do not exist in the slice-21 OTel families and is deferred to a follow-up slice (`add-k8s-container-saturation-alerts`).

The four promtool test fixtures (`slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`) SHALL live at `infra/k8s-obs/base/prometheus/tests/` (relocated from `infra/observability/prometheus/rules/` in slice 22b). The CI `prometheus-rules` job's `promtool test rules` step reads from this directory. `container-tests.yml` is retained as a historical record of the deferred container-saturation alerting; it is not currently active against any rule file in `infra/k8s-obs/base/prometheus/rules/`.

#### Scenario: ConfigMap generator picks up every migrated rule file

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a ConfigMap whose name begins with `prometheus-extra-rules-`
- **AND** the ConfigMap's `data:` map contains exactly five keys: `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`

#### Scenario: Prometheus pod mounts the ConfigMap at the expected path

- **WHEN** a reader inspects the prometheus chart's rendered Deployment / StatefulSet
- **THEN** the pod-spec `volumes:` references the `prometheus-extra-rules` ConfigMap
- **AND** the prometheus container's `volumeMounts:` mounts that volume at `/etc/prometheus-extra-rules/` read-only

#### Scenario: Rule files are loaded at prometheus startup

- **GIVEN** the obs cluster has applied this slice and the prometheus pod has restarted
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field begins with `/etc/prometheus-extra-rules/`
- **AND** the groups together declare every alert from the five migrated files (`ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `BackendDown`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`, `PostgresConnectionSaturation`, `PostgresDeadlocks`)

#### Scenario: Promtool test fixtures live in a dedicated `tests/` directory, not in `rules/`

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** no file in the directory ends in `-tests.yml`
- **AND** the directory `infra/k8s-obs/base/prometheus/tests/` contains exactly four files: `slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`
- **AND** no equivalent file exists under `infra/observability/prometheus/`

#### Scenario: Container-alerts stays deferred

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** the directory does NOT contain `container-alerts.yml`
- **AND** the deferred container-saturation alerting work is named in the Hetzner overlay stub or the design narrative as a follow-up slice
