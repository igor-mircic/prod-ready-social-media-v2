## 1. Obs Lima VM definition

- [x] 1.1 Create `infra/lima/obs.yaml` declaring the VM shape (`arch: aarch64`, `cpus: 4`, `memory: "8GiB"`, `disk: "64GiB"`, Ubuntu 24.04 LTS image). Pin the image identifier explicitly (no `release: latest`). Match the version pin used in `infra/lima/lima.yaml`.
- [x] 1.2 Add a `portForwards:` block. The in-VM kube-apiserver port (`guestPort: 6443`) MUST map to a host port that does NOT collide with the app VM's apiserver forward (e.g. `hostPort: 6444`). Add a comment naming the chosen host port and the reason.
- [x] 1.3 Add a `copyToHost:` block (or equivalent `provision:` step) that surfaces the k3s kubeconfig on the macOS host under a NEW context name that does not collide with the app VM's existing context (proposed: `social-obs`). Confirm the rewrite of `https://127.0.0.1:6443` lands at the host-side port chosen in 1.2.
- [x] 1.4 Wire a `provision:` block that invokes `infra/provisioning/install-k3s.sh` on first boot. Use the EXACT SAME invocation pattern that `infra/lima/lima.yaml` uses. Do NOT duplicate any k3s install logic inline.
- [x] 1.5 Verify the shared install script invariant: grep `infra/provisioning/` for any new `install-k3s-*.sh` files and confirm only `install-k3s.sh` exists. Confirm the script body is unchanged from the slice-14 baseline.
- [x] 1.6 Verify locally: with the app VM up, run `limactl start infra/lima/obs.yaml` (via `just obs-up` after task 6 lands the recipe). Both VMs run concurrently; `limactl list` shows both `Running`. `kubectl --context social-obs get nodes` reports one `Ready` node from the macOS host.

## 2. Obs kustomize tree layout

- [x] 2.1 Create `infra/k8s-obs/base/kustomization.yaml` declaring `namespace: observability` and listing the LGTM component subdirs under `resources:` (`./prometheus`, `./loki`, `./tempo`, `./grafana`, `./alertmanager`). Add a header comment naming the convention (one namespace, components nested under `base/`).
- [x] 2.2 Create `infra/k8s-obs/base/namespace.yaml` declaring the `observability` Namespace (so `kustomize build` does not assume the namespace already exists at apply time).
- [x] 2.3 Create `infra/k8s-obs/overlays/local/kustomization.yaml` declaring `../../base` as the resource. No patches yet — base sizes are already learning-project scaled. Add a header comment matching the style of `infra/k8s/overlays/local/kustomization.yaml`.
- [x] 2.4 Create `infra/k8s-obs/overlays/hetzner/kustomization.yaml` placeholder declaring `../../base` and containing a clearly marked TODO comment listing what the `add-hetzner-deploy` slice will add: Secret strategy (SOPS / Sealed Secrets), Ingress + TLS (cert-manager + Let's Encrypt) for grafana, storage sizing for the production obs box, anti-affinity / topology if/when multi-node, retention tuning. The placeholder MUST NOT reuse any local-only Secret as-is.
- [x] 2.5 Verify `kustomize build --enable-helm infra/k8s-obs/overlays/local` renders cleanly to stdout with no errors after tasks 3–5 land the chart bits.

## 3. Prometheus chart

- [x] 3.1 Create `infra/k8s-obs/base/prometheus/kustomization.yaml` declaring a `helmCharts:` entry: `name: prometheus`, `repo: https://prometheus-community.github.io/helm-charts`, `version: <pinned>` (resolve to latest stable at implementation time), `releaseName: prometheus`, `namespace: observability`, `valuesFile: values.yaml`.
- [x] 3.2 Create `infra/k8s-obs/base/prometheus/values.yaml` setting:
  - `server.persistentVolume.enabled: true`, `server.persistentVolume.size: 5Gi`, `server.persistentVolume.storageClass: local-path`.
  - `server.retention: "7d"` (matches the 5Gi PVC envelope).
  - `server.resources.requests.memory: 256Mi`, `requests.cpu: 100m`, `limits.memory: 1Gi`, `limits.cpu: 1000m`.
  - `alertmanager.enabled: false` (alertmanager is its own chart in task 7; the prometheus chart's bundled alertmanager subchart is explicitly disabled to avoid two alertmanagers).
  - `pushgateway.enabled: false` (not in scope this slice).
  - `kube-state-metrics.enabled: false` (no scrape targets to enumerate yet; lands in slice 21).
  - `prometheus-node-exporter.enabled: false` (same — slice 21).
  - `serverFiles."prometheus.yml".scrape_configs:` set to an empty list (`[]`) with a comment noting that scrape configs land in slice 21.
- [x] 3.3 Record the resolved chart version pin in the values file's header comment.

## 4. Loki chart

- [x] 4.1 Create `infra/k8s-obs/base/loki/kustomization.yaml` declaring a `helmCharts:` entry: `name: loki`, `repo: https://grafana.github.io/helm-charts`, `version: <pinned>`, `releaseName: loki`, `namespace: observability`, `valuesFile: values.yaml`.
- [x] 4.2 Create `infra/k8s-obs/base/loki/values.yaml` setting:
  - `deploymentMode: SingleBinary` (NOT `SimpleScalable` or `Distributed`; single-binary monolithic for single-node single-PVC).
  - `loki.commonConfig.replication_factor: 1`.
  - `loki.storage.type: filesystem` (NOT s3/gcs/azure).
  - `loki.schemaConfig.configs:` declares a single TSDB schema starting at a recent date with `object_store: filesystem`, `store: tsdb`.
  - `singleBinary.replicas: 1`.
  - `singleBinary.persistence.enabled: true`, `singleBinary.persistence.size: 5Gi`, `singleBinary.persistence.storageClass: local-path`.
  - `singleBinary.resources.requests.memory: 256Mi`, `requests.cpu: 100m`, `limits.memory: 512Mi`, `limits.cpu: 1000m`.
  - `chunksCache.enabled: false`, `resultsCache.enabled: false` (memcached not needed for single-node monolithic).
  - `gateway.enabled: false` (no ingress in this slice; the future OTLP push lands directly on the loki Service).
  - `monitoring.dashboards.enabled: false`, `monitoring.rules.enabled: false`, `monitoring.serviceMonitor.enabled: false`, `monitoring.selfMonitoring.enabled: false` (these all assume the Prometheus Operator CRDs we are NOT installing).
  - `test.enabled: false`.
- [x] 4.3 Record the resolved chart version pin in the values file's header comment.

## 5. Tempo chart

- [x] 5.1 Create `infra/k8s-obs/base/tempo/kustomization.yaml` declaring a `helmCharts:` entry: `name: tempo`, `repo: https://grafana.github.io/helm-charts`, `version: <pinned>`, `releaseName: tempo`, `namespace: observability`, `valuesFile: values.yaml`.
- [x] 5.2 Create `infra/k8s-obs/base/tempo/values.yaml` setting:
  - Use the monolithic `tempo` chart (NOT `tempo-distributed`).
  - `persistence.enabled: true`, `persistence.size: 5Gi`, `persistence.storageClass: local-path`.
  - `tempo.storage.trace.backend: local` (NOT s3/gcs).
  - `tempo.retention: 72h` (3 days, matching the heavier per-trace footprint vs metrics/logs).
  - `tempo.receivers.otlp.protocols.grpc: {}`, `tempo.receivers.otlp.protocols.http: {}` (enable OTLP receivers for the next slice's exporter, even though no data will arrive in this slice).
  - `tempo.resources.requests.memory: 256Mi`, `requests.cpu: 100m`, `limits.memory: 1Gi`, `limits.cpu: 1000m`.
  - `serviceMonitor.enabled: false` (no Prometheus Operator).
- [x] 5.3 Record the resolved chart version pin in the values file's header comment.

## 6. Grafana chart

- [x] 6.1 Create `infra/k8s-obs/base/grafana/kustomization.yaml` declaring a `helmCharts:` entry: `name: grafana`, `repo: https://grafana.github.io/helm-charts`, `version: <pinned>`, `releaseName: grafana`, `namespace: observability`, `valuesFile: values.yaml`.
- [x] 6.2 Create `infra/k8s-obs/base/grafana/values.yaml` setting:
  - `persistence.enabled: true`, `persistence.size: 1Gi`, `persistence.storageClassName: local-path`.
  - `adminUser: admin`, `admin.existingSecret: grafana-admin-credentials` (Secret committed in task 6.3).
  - `datasources:` set to an empty map / commented out. NO datasource is provisioned in this slice; the spec's "empty datasources list" scenario depends on this.
  - `dashboardProviders:` empty / commented out.
  - `dashboards:` empty / commented out.
  - `sidecar.datasources.enabled: false`, `sidecar.dashboards.enabled: false` (no sidecar-driven provisioning until slice 18).
  - `service.type: ClusterIP` (port-forward only; LoadBalancer rejected per Decision 5).
  - `grafana.ini.auth.anonymous.enabled: false` (login required everywhere — both local AND hetzner overlays, per design open question 3).
  - `resources.requests.memory: 128Mi`, `requests.cpu: 50m`, `limits.memory: 512Mi`, `limits.cpu: 500m`.
- [x] 6.3 Create `infra/k8s-obs/base/grafana/secret.yaml` declaring a Kubernetes `Secret` named `grafana-admin-credentials` containing the local-dev admin password (base64-encoded; choose a memorable local-dev password and document it in the README's obs section). Add a label / annotation noting it is a local-dev credential and MUST NOT be reused on Hetzner.
- [x] 6.4 Record the resolved chart version pin in the values file's header comment.

## 7. Alertmanager chart

- [x] 7.1 Create `infra/k8s-obs/base/alertmanager/kustomization.yaml` declaring a `helmCharts:` entry: `name: alertmanager`, `repo: https://prometheus-community.github.io/helm-charts`, `version: <pinned>`, `releaseName: alertmanager`, `namespace: observability`, `valuesFile: values.yaml`.
- [x] 7.2 Create `infra/k8s-obs/base/alertmanager/values.yaml` setting:
  - `persistence.enabled: true`, `persistence.size: 1Gi`, `persistence.storageClass: local-path`.
  - `config:` set to a minimal "drop everything" receiver (`receivers: [{name: 'null'}]`, `route: {receiver: 'null'}`). No real alerting in this slice; the receivers wire up in slice 22 (when compose-side alertmanager rules migrate over).
  - `resources.requests.memory: 64Mi`, `requests.cpu: 25m`, `limits.memory: 256Mi`, `limits.cpu: 250m`.
  - `serviceMonitor.enabled: false`.
- [x] 7.3 Record the resolved chart version pin in the values file's header comment.

## 8. justfile recipes

- [x] 8.1 Add `obs-up` recipe to root `justfile`: `limactl start infra/lima/obs.yaml`. Block on the obs VM reaching Ready (mirror the app cluster's `vm-up` wait pattern).
- [x] 8.2 Add `obs-down` recipe: `limactl stop social-obs` (or the exact VM name the obs.yaml declares). Do NOT auto-delete the VM.
- [x] 8.3 Add `obs-status` recipe: prints (a) `limactl list` filtered to the obs VM, (b) `kubectl --context social-obs get nodes`, (c) `kubectl --context social-obs -n observability get pods,pvc,svc`. One-shot summary the operator can run to confirm cluster health.
- [x] 8.4 Add `obs-grafana` recipe: `kubectl --context social-obs -n observability port-forward svc/grafana 3001:80` (or whatever port the grafana chart exposes; pick a host port that does NOT collide with the compose grafana on 3000). Add a comment naming the chosen host port.
- [x] 8.5 Add `obs-apply` recipe: `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs apply -f -`. After applying, `kubectl --context social-obs wait --for=condition=Ready pod --all -n observability --timeout=180s`.
- [x] 8.6 Add `obs-diff` recipe: `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs diff -f -`.
- [x] 8.7 Add `obs-delete` recipe: `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs delete -f -`.
- [x] 8.8 Confirm every new recipe shows up in `just --list` with its description.

## 9. Apply, verify, and prove the empty-stack loop

- [x] 9.1 `just obs-up` boots the obs Lima VM and waits for the cluster to be Ready. Verify `kubectl --context social-obs get nodes` reports one Ready node.
- [x] 9.2 `just obs-apply` renders and applies the local overlay. Wait for ALL pods in the `observability` namespace to reach Ready (180s timeout).
- [x] 9.3 Verify every PVC binds: `kubectl --context social-obs -n observability get pvc` shows 5 PVCs (prometheus, loki, tempo, grafana, alertmanager) all in `Bound` state with `STORAGECLASS=local-path` and the declared sizes.
- [x] 9.4 Verify no Prometheus Operator CRDs were installed: `kubectl --context social-obs get crd | grep monitoring.coreos.com` returns nothing.
- [x] 9.5 Verify grafana loads: `just obs-grafana` in one shell, then `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:<grafana-port>/api/health` returns `200`. Open `http://localhost:<grafana-port>` in a browser, log in with the slice-default admin credentials, navigate to `Configuration → Data sources`, confirm the list is empty.
- [x] 9.6 Verify prometheus is ready: `curl -sS http://localhost:<prom-port>/-/ready` (after a temporary port-forward to the prometheus Service) returns `Prometheus Server is Ready.`. Tear the port-forward down after the check.
- [x] 9.7 Verify alertmanager is ready: `curl -sS http://localhost:<am-port>/-/healthy` (after a temporary port-forward) returns `OK`. Tear down.
- [x] 9.8 Verify both clusters can run concurrently: with both `just vm-up` and `just obs-up` having completed, `limactl list` shows both VMs Running. Both `kubectl --context <app>` and `kubectl --context social-obs` queries succeed.

## 10. docker-compose UNCHANGED — verification

- [x] 10.1 Diff `docker-compose.yml` against the pre-slice baseline. Confirm that the prometheus, grafana, tempo, loki, alertmanager, collector, and postgres-exporter service blocks are byte-identical. The only acceptable change is adding a comment somewhere documenting the new in-VM obs cluster's existence — no service block edits.
- [x] 10.2 Run the existing observability profile end-to-end: `docker compose --profile observability up -d` after this slice has landed. Confirm every observability service comes up Healthy. Confirm `http://localhost:3000` (compose-grafana) still renders existing dashboards with real data.
- [x] 10.3 Confirm the app cluster's backend continues to ship telemetry to compose: hit a backend endpoint that generates a span, open compose-grafana's Tempo explorer, find the span. (This validates that the host docker-compose stack was untouched by this slice.)

## 11. README + global dotfiles

- [x] 11.1 Add a "Local observability cluster" section to `README.md`. Cover (in order): one-paragraph rationale (two-cluster fate-separation pattern, mirrors future Hetzner two-box deploy), prerequisites (`brew install lima just kubectl helm kustomize` — already covered by slice 14 prereqs, this section just notes "same prereqs"), the `obs-*` `just` verb table with one-line descriptions, the obs-cluster dev loop (`just obs-up` → `just obs-apply` → `just obs-grafana` → log in → empty datasource list is expected → `just obs-down` when done), the slice's explicit non-goals (no data flowing yet — that's the next slice), a pointer to the forward arc (slices 18–23 named).
- [x] 11.2 Add a one-paragraph note in the "Local observability" section pointing the reader at the new "Local observability cluster" section and naming the parallel-stacks transitional state (compose still primary; obs cluster is dark until slice 18). One sentence about when each is the right thing to consult during dev (compose: today, real data; obs cluster: tomorrow, will be the only target post-slice-22).
- [x] 11.3 No new brew packages introduced by this slice (lima, just, kubectl, helm, kustomize are all from slice 14). Confirm `~/dotfiles/install.sh` is unchanged; no edit needed.

## 12. Validate and ship

- [x] 12.1 Run `openspec validate add-local-k3s-obs-cluster --strict` and resolve any findings.
- [x] 12.2 On a fresh checkout (or after a `limactl delete social-obs` + clean re-up): `just obs-up` → `just obs-apply` → all checks in section 9 pass. Tear down: `just obs-delete` → `just obs-down`. Confirm idempotent re-up: `just obs-up && just obs-apply` from a stopped-VM state finishes without errors.
- [x] 12.3 Confirm the app cluster is unaffected: `just vm-up && just k8s-apply` still works, backend still talks to postgres-in-k3s, backend still ships telemetry to host docker-compose collector, compose dashboards still render.
- [x] 12.4 Commit on a branch named `add-local-k3s-obs-cluster`, open the PR with the proposal/design/specs/tasks summary, and follow the autonomous-apply workflow through CI to archive (per feedback_openspec_apply_autonomous_to_merge — drive commit → push → PR → watch-CI → archive → re-watch CI; ask only at merge time).
