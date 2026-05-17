## 1. postgres-exporter Deployment in app cluster

- [x] 1.1 Create directory `infra/k8s/base/postgres-exporter/` with files `kustomization.yaml`, `deployment.yaml`, `service.yaml`, `serviceaccount.yaml`
- [x] 1.2 Write `serviceaccount.yaml` declaring `ServiceAccount/postgres-exporter` in `social` namespace
- [x] 1.3 Write `deployment.yaml` declaring `Deployment/postgres-exporter` (replicas: 1) running `quay.io/prometheuscommunity/postgres-exporter:v0.17.1` (matches compose pin), with: env `DATA_SOURCE_USER` / `DATA_SOURCE_PASS` from the existing `postgres-credentials` Secret (same keys the backend uses), env `DATA_SOURCE_URI: postgres.social.svc.cluster.local:5432/social?sslmode=disable`, env `PG_EXPORTER_EXTEND_QUERY_PATH: /etc/postgres-exporter/queries.yaml`, mount `ConfigMap/postgres-exporter-queries` at `/etc/postgres-exporter/`, named container port `metrics:9187`, liveness probe `httpGet :metrics/`, readiness probe `httpGet :metrics/`, resources `requests cpu=25m mem=64Mi / limits cpu=200m mem=128Mi`
- [x] 1.4 Write `service.yaml` declaring `Service/postgres-exporter` ClusterIP on `:9187` selecting the Deployment's pod label
- [x] 1.5 Write `kustomization.yaml` referencing the three manifests above and a `configMapGenerator` for `postgres-exporter-queries` sourcing `../../../observability/postgres-exporter/queries.yaml` (the compose source of truth; safe to reference cross-tree because compose-side queries.yaml is the canonical projection that retires only in slice 22b)
- [x] 1.6 Append `./postgres-exporter` to the `resources:` list in `infra/k8s/base/kustomization.yaml`

## 2. App collector `prometheus` receiver scraping postgres-exporter

- [x] 2.1 Edit `infra/k8s/base/collector/configmap.yaml` to add a `prometheus` receiver named `prometheus/postgres-exporter` under `receivers:` with: a single static-config target `postgres-exporter.social.svc.cluster.local:9187`, scrape_interval `15s`, metrics_path `/metrics`, job_name `postgres-exporter`
- [x] 2.2 Append `prometheus/postgres-exporter` to the `metrics:` pipeline's `receivers:` list (joins the existing OTLP receiver feeding the same pipeline); pipeline shape is otherwise unchanged
- [x] 2.3 Add an inline comment naming the receiver as the slice-22a addition that retires when compose's own `postgres-exporter` retires in 22b

## 3. Obs prometheus rules — ConfigMap + chart wiring

- [x] 3.1 Create directory `infra/k8s-obs/base/prometheus/rules/` and copy these files from `infra/observability/prometheus/rules/` (byte-identical copies — the parity-window source-of-truth pair): `slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`. The companion `slo-tests.yml`, `fe-slo-tests.yml`, `database-tests.yml`, `container-tests.yml`, `container-alerts.yml` are NOT copied — promtool fixtures stay compose-side; container-alerts is deferred (design.md Decision 6).
- [x] 3.2 Edit `infra/k8s-obs/base/prometheus/kustomization.yaml` to add a `configMapGenerator:` entry named `prometheus-extra-rules` sourcing every `.yml` in the new rules directory
- [x] 3.3 Edit `infra/k8s-obs/base/prometheus/values.yaml` to add `server.extraConfigmapMounts:` entry that mounts the `prometheus-extra-rules` ConfigMap at `/etc/prometheus-extra-rules/`
- [x] 3.4 In the same `values.yaml`, override `serverFiles.prometheus.yml.rule_files:` to APPEND `/etc/prometheus-extra-rules/*.yml` to the chart-default list (chart-default already loads `/etc/config/recording_rules.yml` and `/etc/config/alerting_rules.yml` — preserve those; the extra glob picks up the migrated files)
- [x] 3.5 In the same `values.yaml`, set `server.alertmanagers:` to a single-entry list with `static_configs:` target `alertmanager.observability.svc.cluster.local:9093`

## 4. Obs alertmanager — replace null receiver with real routing tree

- [x] 4.1 Edit `infra/k8s-obs/base/alertmanager/values.yaml` to replace the slice-17 `config.route.receiver: 'null'` + single null receiver with: a top-level `route:` block declaring `receiver: 'default'`, `group_by: ['alertname', 'slo']`, `group_wait: 10s`, `group_interval: 5m`, `repeat_interval: 4h`, and two child routes matching `severity="page"` → `page-webhook` and `severity="ticket"` → `ticket-webhook` (both with `continue: false`)
- [x] 4.2 In the same `values.yaml`, replace the receivers list with three receivers: `default` (no webhook_configs), `page-webhook` (webhook_configs targeting `http://webhook-sink.observability.svc.cluster.local:8080/page` with `send_resolved: true`), and `ticket-webhook` (webhook_configs targeting `http://webhook-sink.observability.svc.cluster.local:8080/ticket` with `send_resolved: true`)
- [x] 4.3 In the same `values.yaml`, add an `inhibit_rules:` list with a single rule: `source_matchers: ['alertname="BackendDown"']`, `target_matchers: ['slo=~".+"']`, `equal: []` (mirrors compose's slice-11 inhibit rule)
- [x] 4.4 Update the surrounding comment block: drop the "slice 22 replaces this" text; replace with "slice 22a migrated the receiver tree from compose; slice 22b retires the compose copy"

## 5. webhook-sink Deployment + Service in obs cluster

- [x] 5.1 Create directory `infra/k8s-obs/base/webhook-sink/` with files `kustomization.yaml`, `deployment.yaml`, `service.yaml`
- [x] 5.2 Write `deployment.yaml` declaring `Deployment/webhook-sink` (replicas: 1) in `observability` namespace running `registry.local:5000/webhook-sink:dev` (built from `infra/observability/webhook-sink/` — task 5.5 covers the build), named container port `http:8080`, liveness+readiness probe `httpGet :http/healthz` if the existing image supports it (else drop the probes — record the omission in the spec scenario), resources `requests cpu=25m mem=32Mi / limits cpu=100m mem=64Mi`
- [x] 5.3 Write `service.yaml` declaring `Service/webhook-sink` ClusterIP on `:8080` selecting the Deployment's pod label
- [x] 5.4 Write `kustomization.yaml` referencing the two manifests above
- [x] 5.5 Verify the existing `infra/observability/webhook-sink/Dockerfile` builds; add a `just obs-webhook-sink-image` recipe to the justfile that runs `docker build -t registry.local:5000/webhook-sink:dev infra/observability/webhook-sink/ && docker push 127.0.0.1:5000/webhook-sink:dev` (mirroring the slice-15 backend/frontend image flow); call it from `just obs-apply` if appropriate or document the manual order in README
- [x] 5.6 Append `./webhook-sink` to the `resources:` list in `infra/k8s-obs/base/kustomization.yaml`

## 6. Migrate 3 grafana dashboards into obs

- [x] 6.1 Copy `infra/observability/grafana/dashboards/backend-overview.json` → `infra/k8s-obs/base/grafana/dashboards/backend-overview.json`. Edit every panel's `instance="host.docker.internal:8080"` selector (and any `instance="backend:8080"` variant) to `instance=~".*"`; leave all other selectors intact. Datasource UIDs are already `prometheus` in both grafanas (slice 18b), so no UID edits needed.
- [x] 6.2 Copy `frontend-overview.json` similarly; sweep for compose-only `instance` selectors and relax to `instance=~".*"`
- [x] 6.3 Copy `database-overview.json` similarly; the `pg_*` series flow through both prometheus instances after task 2 lands, so the dashboard renders identically. `infrastructure-overview.json` is NOT copied — slice 21 already produced `cluster-overview.json` with k8s-shaped families covering the same operator role.
- [x] 6.4 Edit `infra/k8s-obs/base/grafana/values.yaml` to add three entries under the `dashboards:` block (mirroring the slice-21 `cluster-overview.json` provisioning shape): `backend-overview`, `frontend-overview`, `database-overview`, each pointing at the new JSON file. *Note: slice 21 actually wired `cluster-overview` via the sibling kustomization.yaml's `configMapGenerator.files:` list (values.yaml's `dashboards:` block is `{}` because chart-side `.Files` does not resolve under `kustomize build --enable-helm`). Slice 22a follows the same mechanism — appended three files to `configMapGenerator.files:` and updated the explanatory comment in values.yaml.*
- [ ] 6.5 Verify the chart provisions all four dashboards on a fresh apply: `cluster-overview` (slice 21), `backend-overview`, `frontend-overview`, `database-overview` (this slice). Each renders under Dashboards → Browse without manual import.

## 7. CI diff guard for parity-window rule files

- [x] 7.1 Edit `.github/workflows/ci.yml` to add a new step inside the existing `prometheus-rules` job named "Assert obs-side rule copies stay byte-identical with compose-side originals"
- [x] 7.2 The step SHALL iterate the five migrated files (`slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`) and run `diff -q infra/observability/prometheus/rules/<file> infra/k8s-obs/base/prometheus/rules/<file>` for each, failing the job on the first byte difference
- [x] 7.3 Add an inline comment naming the step as a slice-22a parity guard that retires when slice 22b drops the compose-side files

## 8. End-to-end verification (the parity check)

- [ ] 8.1 Apply both clusters: `just k8s-apply && just obs-apply`
- [ ] 8.2 Wait for `kubectl -n social get deploy postgres-exporter` to show 1/1 Ready; `kubectl -n observability get deploy webhook-sink` to show 1/1 Ready
- [ ] 8.3 In compose grafana (`:3000`) Explore → Prometheus, run `pg_stat_database_numbackends{datname="social"}` — note the value
- [ ] 8.4 In obs grafana (`:3001`) Explore → Prometheus, run the same query — confirm the same series with the same value (one scrape interval may be needed for both to converge)
- [ ] 8.5 In compose grafana → Alerting, list the active rule groups; in obs grafana → Alerting, list the active rule groups; confirm the five migrated groups are loaded on both sides (`slo-recording`, `slo-alerting`, `fe-slo-recording`, `fe-slo-alerting`, `database-alerts`)
- [ ] 8.6 Trigger a synthetic firing on the obs side: temporarily add a recording-rule that evaluates `vector(1)` and an alerting rule that fires when that recording is `>0` with `severity=ticket`; apply; wait one evaluation_interval; remove the change. Confirm `kubectl -n observability exec -it deploy/webhook-sink -- wget -qO- localhost:8080/received` shows the test firing.
- [ ] 8.7 Open obs grafana → Dashboards → Browse, verify `backend-overview`, `frontend-overview`, `database-overview`, `cluster-overview` all appear and render without "No data" on a healthy cluster
- [ ] 8.8 In compose grafana, render `backend-overview.json` side-by-side with obs grafana's copy; visually confirm panel-by-panel parity (same value ranges, same time series count)
- [ ] 8.9 Run the new `just obs-webhook-sink-received` recipe (if added in task 5.5) and confirm it returns valid JSON

## 9. README + Hetzner overlay stub

- [x] 9.1 Append a "Migrated content" paragraph to the README's "Local observability cluster" section (after the slice-21 "Cluster metrics" subsection) naming what's now in obs prom / obs grafana / obs alertmanager, the parity window with compose, and the diff guard
- [x] 9.2 Append a slice-22a commented block to `infra/k8s/overlays/hetzner/kustomization.yaml` alongside the existing slice-15..21 stubs, naming: postgres-exporter per-cluster placement in prod, `pg_monitor`-granted DB role for the exporter (no shared application credentials), resource-cap re-sizing for busier clusters
- [x] 9.3 Append a slice-22a commented block to `infra/k8s-obs/overlays/hetzner/kustomization.yaml` (if present) naming: webhook-sink not needed in prod if real alerting receivers replace it, retention bump on obs prom alongside the migrated rule load
- [x] 9.4 Add a one-line bullet to README §"Forward arc" naming slice 22a as `(this slice)` and slice 22b (`retire-compose-observability`) as the next entry; mark slice 22 in the existing arc list as split into 22a/22b

## 10. OpenSpec strict validation

- [x] 10.1 Run `openspec validate migrate-obs-content --strict` and confirm clean exit
- [x] 10.2 Fix any validation findings, re-run, repeat until clean

## 11. Commit the implementation

- [x] 11.1 Stage all new and modified files
- [x] 11.2 Create a commit titled `Implement migrate-obs-content (slice 22a)` following the repo's existing slice-implementation commit shape
- [ ] 11.3 Push and open the PR with the standard repo PR template
- [ ] 11.4 After CI passes, archive the change with `openspec archive migrate-obs-content` (per the `feedback_openspec_apply_autonomous_to_merge` memory: drive commit → push → PR → watch CI → archive → re-watch CI without prompting; ask only at merge time)
