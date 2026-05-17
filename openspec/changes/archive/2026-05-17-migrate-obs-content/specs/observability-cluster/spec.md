## ADDED Requirements

### Requirement: The obs prometheus chart mounts the migrated rule files via a kustomize-generated ConfigMap

The kustomization at `infra/k8s-obs/base/prometheus/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `prometheus-extra-rules` sourcing every `.yml` file in the new `infra/k8s-obs/base/prometheus/rules/` directory. The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL declare a `server.extraConfigmapMounts:` entry that mounts the generated ConfigMap at `/etc/prometheus-extra-rules/` inside the prometheus pod. The chart values SHALL override `serverFiles.prometheus.yml.rule_files:` to PRESERVE the chart-default entries (`/etc/config/recording_rules.yml`, `/etc/config/alerting_rules.yml`) AND APPEND `/etc/prometheus-extra-rules/*.yml` so the migrated rules are loaded at prometheus startup.

The `infra/k8s-obs/base/prometheus/rules/` directory SHALL contain byte-identical copies of `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, and `database-alerts.yml` from `infra/observability/prometheus/rules/`. The companion `*-tests.yml` promtool fixtures SHALL NOT be copied — they remain compose-side only. `container-alerts.yml` SHALL NOT be copied — it is keyed on cadvisor-shaped series that do not exist in the slice-21 OTel families and is deferred to a follow-up slice.

#### Scenario: ConfigMap generator picks up every migrated rule file

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a ConfigMap whose name begins with `prometheus-extra-rules-`
- **AND** the ConfigMap's `data:` map contains exactly five keys: `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`
- **AND** each value is byte-identical to the corresponding file under `infra/observability/prometheus/rules/`

#### Scenario: Prometheus pod mounts the ConfigMap at the expected path

- **WHEN** a reader inspects the prometheus chart's rendered Deployment / StatefulSet
- **THEN** the pod-spec `volumes:` references the `prometheus-extra-rules` ConfigMap
- **AND** the prometheus container's `volumeMounts:` mounts that volume at `/etc/prometheus-extra-rules/` read-only

#### Scenario: Rule files are loaded at prometheus startup

- **GIVEN** the obs cluster has applied this slice and the prometheus pod has restarted
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/rules`
- **THEN** the response body contains rule groups whose `file` field begins with `/etc/prometheus-extra-rules/`
- **AND** the groups together declare every alert from the five migrated files (`ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `BackendDown`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, `InpSloSlowBurn`, `PostgresConnectionSaturation`, `PostgresDeadlocks`)

#### Scenario: Container-alerts and promtool test fixtures stay compose-side

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/rules/`
- **THEN** the directory does NOT contain `container-alerts.yml`
- **AND** the directory does NOT contain any file ending in `-tests.yml`

### Requirement: The obs prometheus chart wires the in-cluster alertmanager as its alerting target

The chart values at `infra/k8s-obs/base/prometheus/values.yaml` SHALL set `server.alertmanagers:` to a single-entry list whose entry declares a `static_configs:` target of `alertmanager.observability.svc.cluster.local:9093`. The chart-default value (`alertmanagers: []`) SHALL be replaced. No additional alertmanager target SHALL be declared in this slice.

#### Scenario: Values file declares exactly one alertmanager target

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/values.yaml`
- **THEN** `server.alertmanagers:` is a list of exactly one element
- **AND** that element's `static_configs:` targets contains exactly the string `alertmanager.observability.svc.cluster.local:9093`

#### Scenario: Prometheus reports the alertmanager as up after apply

- **GIVEN** the obs cluster has applied this slice
- **WHEN** an operator queries `http://prometheus-server.observability.svc.cluster.local/api/v1/alertmanagers`
- **THEN** the response's `activeAlertmanagers` list contains the URL of the in-cluster alertmanager Service
- **AND** no `droppedAlertmanagers` entry is present for the in-cluster target

### Requirement: The obs alertmanager values declare the severity-keyed routing tree migrated from compose

The chart values at `infra/k8s-obs/base/alertmanager/values.yaml` SHALL replace the slice-17 placeholder `config:` block with a routing tree mirroring the compose-side `infra/observability/alertmanager/alertmanager.yml`. The top-level `route:` SHALL declare `receiver: 'default'`, `group_by: ['alertname', 'slo']`, `group_wait: 10s`, `group_interval: 5m`, `repeat_interval: 4h`, and two child routes: one matching `severity="page"` targeting receiver `page-webhook`, one matching `severity="ticket"` targeting receiver `ticket-webhook`. Each child route SHALL declare `continue: false`. The receivers list SHALL declare `default` (no webhook_configs), `page-webhook`, and `ticket-webhook`. Each webhook receiver SHALL declare `send_resolved: true`.

#### Scenario: Top-level route declares severity-keyed children

- **WHEN** a reader inspects the `config:` block in `infra/k8s-obs/base/alertmanager/values.yaml`
- **THEN** the top-level `route:` block names a `default` receiver
- **AND** the `route.routes:` list contains exactly two entries
- **AND** the two entries match `severity="page"` and `severity="ticket"` respectively
- **AND** neither child route sets `continue: true`
- **AND** the `group_by`, `group_wait`, `group_interval`, and `repeat_interval` values match the compose configuration (`['alertname', 'slo']`, `10s`, `5m`, `4h`)

#### Scenario: Webhook URLs target the in-cluster webhook-sink Service

- **WHEN** a reader inspects the `receivers:` block
- **THEN** the `page-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink.observability.svc.cluster.local:8080/page` and `send_resolved: true`
- **AND** the `ticket-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink.observability.svc.cluster.local:8080/ticket` and `send_resolved: true`
- **AND** the `default` receiver declares no `webhook_configs`

#### Scenario: BackendDown inhibition rule is declared

- **WHEN** a reader inspects the `config.inhibit_rules:` list
- **THEN** the list contains exactly one rule
- **AND** that rule's `source_matchers:` contain `alertname="BackendDown"`
- **AND** that rule's `target_matchers:` contain `slo=~".+"`
- **AND** that rule's `equal:` is the empty list

#### Scenario: Null receiver from slice 17 is gone

- **WHEN** a reader greps the values file for `'null'`
- **THEN** the file does NOT contain a receiver named `null`

### Requirement: A `webhook-sink` Deployment + Service runs in the `observability` namespace

A new Deployment workload SHALL run a single `webhook-sink` pod in the `observability` namespace of the obs cluster. The image SHALL be built from `infra/observability/webhook-sink/` and pushed to the local OCI registry as `registry.local:5000/webhook-sink:dev` (same image flow as slice-15 backend/frontend). The Deployment manifests SHALL live at `infra/k8s-obs/base/webhook-sink/` with `kustomization.yaml`, `deployment.yaml`, and `service.yaml`. The base kustomization at `infra/k8s-obs/base/kustomization.yaml` SHALL list `./webhook-sink` in its `resources:` array. The `Service/webhook-sink` SHALL be of type `ClusterIP` exposing port `8080`; it SHALL be reachable from the alertmanager pod at `http://webhook-sink.observability.svc.cluster.local:8080`.

#### Scenario: Kustomization includes the webhook-sink

- **WHEN** `kustomize build infra/k8s-obs/base/` is run
- **THEN** the rendered output contains a Deployment named `webhook-sink` in the `observability` namespace
- **AND** the pod-spec image is `registry.local:5000/webhook-sink:dev`
- **AND** a `Service/webhook-sink` of type `ClusterIP` on port `8080` is present

#### Scenario: Service selector matches the Deployment's pod labels

- **WHEN** a reader inspects the Service's `selector:` and the Deployment's pod-template labels
- **THEN** every key/value in the Service selector also appears in the Deployment's pod-template labels

#### Scenario: Alertmanager can reach the webhook-sink in-cluster

- **GIVEN** the slice has been applied and both pods are Running
- **WHEN** an operator runs `kubectl --context obs -n observability exec deploy/alertmanager -- wget -qO- http://webhook-sink.observability.svc.cluster.local:8080/healthz` (or the equivalent endpoint the image exposes)
- **THEN** the response is a 2xx HTTP status

### Requirement: The obs grafana chart provisions the three migrated dashboards

The chart values at `infra/k8s-obs/base/grafana/values.yaml` SHALL declare provisioning entries for three additional dashboards alongside the slice-21 `cluster-overview` entry: `backend-overview`, `frontend-overview`, `database-overview`. Each dashboard SHALL be sourced from `infra/k8s-obs/base/grafana/dashboards/<name>.json`. The JSON files SHALL be byte-similar copies of the compose-side `infra/observability/grafana/dashboards/<name>.json` with the following allowed edits: (i) `instance="host.docker.internal:8080"` selectors (and equivalent compose-only instance pins) relaxed to `instance=~".*"`; (ii) no other systematic edit. The compose `infrastructure-overview.json` SHALL NOT be copied — the slice-21 `cluster-overview.json` covers the same operator role under k8s-shaped families.

#### Scenario: Three new dashboard JSON files exist

- **WHEN** a reader inspects `infra/k8s-obs/base/grafana/dashboards/`
- **THEN** the directory contains `backend-overview.json`, `frontend-overview.json`, `database-overview.json` alongside the slice-21 `cluster-overview.json`
- **AND** the directory does NOT contain `infrastructure-overview.json`

#### Scenario: Compose-only instance selectors are relaxed

- **WHEN** a reader greps each migrated dashboard JSON for `host.docker.internal`
- **THEN** no occurrences are present
- **AND** any panel query that filtered on a compose-only `instance` value now uses `instance=~".*"` or omits the selector

#### Scenario: All four dashboards appear in the obs grafana UI after provisioning

- **GIVEN** the slice has been applied and grafana has restarted
- **WHEN** an operator opens obs grafana → Dashboards → Browse
- **THEN** `Backend overview`, `Frontend overview`, `Database overview`, and `Cluster overview` each appear in the list without manual import
- **AND** each renders without "No data" on every panel under a workload-running cluster (the alerting/SLO panels may show recently-empty windows but no schema mismatch)

### Requirement: A `just` recipe surfaces the obs webhook-sink received payloads

The repository's `justfile` SHALL declare a recipe named `obs-webhook-sink-received` that returns the captured payloads from the in-cluster webhook-sink, mirroring the compose-side equivalent. The recipe SHALL run inside the webhook-sink pod (avoiding the need for a port-forward) and SHALL pipe through `jq` (if available locally) so the response is human-readable.

#### Scenario: Recipe is defined in the justfile

- **WHEN** a reader inspects `justfile`
- **THEN** a recipe named `obs-webhook-sink-received` exists
- **AND** the recipe body runs `kubectl --context obs -n observability exec ... deploy/webhook-sink -- ...` against the `/received` endpoint on `:8080`

#### Scenario: Recipe returns valid JSON when the webhook-sink is running

- **GIVEN** the slice has been applied and the webhook-sink pod is Running
- **WHEN** an operator runs `just obs-webhook-sink-received`
- **THEN** the recipe exits 0
- **AND** stdout is parseable as JSON (or an empty JSON array if no payloads have been received)

### Requirement: CI asserts the parity-window rule copies stay byte-identical with compose-side originals

The `.github/workflows/ci.yml` `prometheus-rules` job SHALL declare a step that runs `diff -q` between the compose-side rule files (`infra/observability/prometheus/rules/<file>.yml`) and the obs-side copies (`infra/k8s-obs/base/prometheus/rules/<file>.yml`) for the five migrated files (`slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`). The step SHALL fail the job on the first byte difference. The step SHALL be removed when slice 22b drops the compose-side rule files.

#### Scenario: CI step exists and iterates the five files

- **WHEN** a reader inspects `.github/workflows/ci.yml`
- **THEN** the `prometheus-rules` job contains a step whose `run:` body invokes `diff -q infra/observability/prometheus/rules/X infra/k8s-obs/base/prometheus/rules/X` for each of the five named files

#### Scenario: A drift between copies fails the CI job

- **GIVEN** a PR modifies `infra/observability/prometheus/rules/slo-alerting.yml` but leaves `infra/k8s-obs/base/prometheus/rules/slo-alerting.yml` untouched
- **WHEN** CI runs on the PR
- **THEN** the `prometheus-rules` job fails on the diff step
- **AND** the failing step's log identifies the differing file

#### Scenario: Identical copies pass the CI job

- **GIVEN** every pair of copies under the five named files is byte-identical
- **WHEN** CI runs the diff step
- **THEN** the step exits 0
