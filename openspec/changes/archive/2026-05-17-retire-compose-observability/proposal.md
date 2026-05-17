## Why

Slice 22a (`migrate-obs-content`, merged 2026-05-17) opened the side-by-side parity window between the compose-on-host observability stack and the obs-cluster k3s stack: both prometheuses scrape the same series via the app collector's fan-out, both alertmanagers receive the same SLO firings, both grafanas render byte-identical dashboards. Parity was verified during 22a verification. Carrying both stacks forever is dead weight — two prometheuses on the same metric stream, two grafanas on identical dashboards, three `compose-relay*` exporters on every outbound app-collector batch, a CI diff-guard catching drift between two rule trees, and ~3 GiB of compose observability containers committed on the developer's host whenever the `observability` profile is up.

The README's slice 22 was always intended as a single `retire-compose-observability` step; slice 22a's design (Decision 1) split it into 22a (migrate) and 22b (this slice — retire) to preserve the parity window. 22b is also the prerequisite for slice 23 `add-hetzner-deploy`, which targets a single obs cluster as the production observability tier — not a compose-plus-k3s hybrid.

## What Changes

- **Delete the compose observability profile.** Remove the 7 services in `docker-compose.yml` with `profiles: ["observability"]` (prometheus, alertmanager, grafana, loki, tempo, webhook-sink, postgres-exporter, otel-collector). The `postgres` service stays — compose remains the developer-loop database, just not the developer-loop observability stack. **BREAKING** for any developer using `docker compose --profile observability up`; a migration paragraph in README names the change.
- **Delete the compose-specific subtrees under `infra/observability/`**: `alertmanager/`, `collector/`, `grafana/`, `loki/`, `tempo/`, `prometheus/prometheus.yml`, and the six compose-side rule files under `prometheus/rules/` (`slo-recording.yml`, `slo-alerting.yml`, `fe-slo-recording.yml`, `fe-slo-alerting.yml`, `database-alerts.yml`, `container-alerts.yml`). The obs-side rule copies under `infra/k8s-obs/base/prometheus/rules/` are unaffected.
- **Delete `infra/observability/logs/`**. Backend defaults to stdout; `LOG_FILE_PATH` is opt-in and accepts any host path. The committed `logs/` directory was a compose mount-point convenience.
- **Relocate the surviving cross-consumer files to live next to their consumer** (see design.md Decision 1):
  - `infra/observability/certs/{ca.crt,ca.key,openssl.cnf}` → `infra/certs/` (slice-19 cross-cluster mTLS material).
  - `infra/observability/runbooks/*.md` (17 files) → `infra/runbooks/` (linked from `runbook_url` annotations on the obs-side rule files; both move in the same commit).
  - `infra/observability/webhook-sink/` (Dockerfile + Node sources) → `infra/k8s-obs/base/webhook-sink/src/` (image still built for the obs-cluster Deployment from slice 22a).
  - `infra/observability/postgres-exporter/queries.yaml` → `infra/k8s/base/postgres-exporter/queries.yaml` (the slice-22a kustomization already flagged this relocation in its own header comment).
  - `infra/observability/postgres/init/01-pg-stat-statements.sql` → `infra/k8s/base/postgres/init/01-pg-stat-statements.sql` (referenced from `infra/k8s/base/postgres/values.yaml`).
  - `infra/observability/prometheus/rules/{container,database,fe-slo,slo}-tests.yml` (4 promtool test fixtures) → `infra/k8s-obs/base/prometheus/tests/`.
- **App collector ConfigMap collapses to obs-only.** `infra/k8s/base/collector/configmap.yaml` drops the three `otlp/compose-relay`, `otlphttp/compose-relay-logs`, `otlphttp/compose-relay-metrics` exporters and their entries from the three pipeline `exporters:` lists, leaving only the `obs-cluster*` legs. Header comment block is rewritten to describe the obs-only topology.
- **Five new Lima portForwards on the obs VM** (`infra/lima/obs.yaml`) expose the obs-cluster observability surfaces on the host, replacing the compose ports the e2e specs target today. All carry `guestIP: 0.0.0.0` per the slice-18c/22a discipline (project memory: Lima 2.x portForwards remapping a k3s LoadBalancer Service port require this). The mapping (design.md Decision 2 explains the `:8081` remap):
  - host `:9090` → obs prometheus
  - host `:3200` → obs tempo
  - host `:3100` → obs loki
  - host `:9093` → obs alertmanager
  - host `:8081` → obs webhook-sink guest `:8080` (host port REMAP; preserves the existing e2e URL constant)
- **Retarget the five observability e2e specs** to the obs cluster.
  - `observability.alerting.spec.ts`, `observability.frontend-traces.spec.ts`, `observability.metric-exemplars.spec.ts`: no URL constant changes (Lima remap preserves the host ports the specs already use); header-comment updates only.
  - `observability.frontend-rum-metrics.spec.ts` and `observability.frontend-errors.spec.ts`: REMOVE `COLLECTOR_PROM_URL = 'http://localhost:8889/metrics'` and the assertions reading from it. The obs collector does not expose a host-reachable prom-text `/metrics` endpoint, and adding one would be a regression in defense-in-depth. Switch assertions to query obs prometheus on `:9090` for the same series; grow the wait budget by one prom scrape interval (~15s). Design.md Decision 3 details the rationale.
- **CI `prometheus-rules` job repointed.** `.github/workflows/ci.yml`: drop the slice-22a diff-guard step (no compose-side files left to diff). Repoint `promtool check rules` to `infra/k8s-obs/base/prometheus/rules/*.yml`. Repoint `promtool test rules` to the relocated `infra/k8s-obs/base/prometheus/tests/`; the test fixtures' internal `rule_files:` references may need a relative-path edit caught in the same commit.
- **Container-alerts (`container-alerts.yml`) stays deleted, not rewritten.** Slice 22a Decision 6 deferred re-authoring the three cadvisor-keyed alerts (`ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`) against OTel-shaped families to a follow-up slice `add-k8s-container-saturation-alerts`. 22b makes the gap real on the obs side but accepts it — the corresponding runbook stubs move to `infra/runbooks/` with the others, ready for the follow-up slice's rules to link them. Design.md Decision 4.
- **Justfile updates.** `OBS_CERTS_CA_DIR := "infra/observability/certs"` → `"infra/certs"`; webhook-sink image build path (line 547) repointed to `infra/k8s-obs/base/webhook-sink/src/`; any `compose-observability-*` / `webhook-received` (compose) recipes deleted. The slice-22a `obs-webhook-sink-received` recipe stays.
- **README rewrite.** "Local observability stack" / "Opt-in observability stack" section rewritten to describe the obs-cluster-only topology. "Forward arc" entry for slice 22b flipped to past tense; next-slice pointer now slice 23 only. All `infra/observability/...` path references updated to their new locations. `LOG_FILE_PATH` example switches from `./infra/observability/logs/backend.json` to `/tmp/backend.json`. Cost-of-two-VM-shape paragraph drops the compose-overlap caveat. "Runbooks" subsection path updates. A short migration paragraph names the directory moves and the compose-profile deletion so an operator on a stale checkout knows what to expect.
- **Hetzner overlay stubs updated.** `infra/k8s/overlays/hetzner/kustomization.yaml` (and any obs counterpart) gain a slice-22b commented block flagging follow-ups: cert-manager replacing the self-signed CA in `infra/certs/`, real DNS for the obs-cluster endpoints replacing the Lima portForwards, and the container-alerts rewrite as a prerequisite for prod alerting parity.

## Capabilities

### New Capabilities

None. This slice modifies existing capabilities only.

### Modified Capabilities

- `observability`: large delta. Drop all requirements pinning compose-side artifacts (compose prom/alertmanager/grafana/loki/tempo/webhook-sink configs and ports; `LOG_FILE_PATH` writing into `infra/observability/logs/`; the compose `observability` profile gating; the `infra/observability/prometheus/rules/` path). Add requirements pinning the relocated paths (`infra/certs/`, `infra/runbooks/`, `infra/k8s/base/postgres-exporter/queries.yaml`, `infra/k8s/base/postgres/init/01-pg-stat-statements.sql`, `infra/k8s-obs/base/webhook-sink/src/`, `infra/k8s-obs/base/prometheus/tests/`). Update e2e spec requirements for the two specs whose assertion shape changes.
- `kubernetes`: small delta. App collector ConfigMap requirement no longer enumerates the three `compose-relay*` exporters. Postgres-exporter configMapGenerator requirement updated to source `queries.yaml` locally. Postgres init SQL requirement updated to source from `infra/k8s/base/postgres/init/`. Lima obs VM portForwards requirement extended with the five new mappings.
- `observability-cluster`: minimal delta. Path-only updates if the spec references file paths (webhook-sink Dockerfile path, runbook URL annotation paths).
- `ci`: small delta. Prometheus-rules job requirement loses the diff-guard step and updates the promtool path.

## Impact

- **Code / manifests**: large delete (compose observability tree under `infra/observability/`); small additive (`infra/certs/`, `infra/runbooks/`, `infra/k8s-obs/base/prometheus/tests/`, `infra/k8s-obs/base/webhook-sink/src/`); five file moves into existing k8s base directories. Modified `docker-compose.yml`, `infra/k8s/base/collector/configmap.yaml`, `infra/k8s/base/postgres-exporter/kustomization.yaml`, `infra/k8s/base/postgres/values.yaml`, `infra/lima/obs.yaml`, `.github/workflows/ci.yml`, `justfile`, `README.md`, `infra/k8s/overlays/hetzner/kustomization.yaml`, five e2e specs.
- **No app-side code change**: `backend/` and `frontend/` are untouched.
- **No new images**: webhook-sink image flow unchanged, just the source path moves.
- **No new cert material**: `infra/observability/certs/` relocates wholesale to `infra/certs/`; `ca.crt` content byte-identical, `ca.key` (local-only per README discipline) stays out-of-band.
- **CI impact**: net-zero step count (drop diff-guard, repoint promtool paths). Same 4 promtool test fixtures run from a new location.
- **Backwards-compatibility**: breaking for `docker compose --profile observability up`. Acceptable — slices 20/21 already established k3s-obs as the operational observability path; the compose stack was a parity reference, not a steady state. README migration paragraph names the change explicitly.
- **Resource impact on developer host**: frees ~3 GiB of compose containers when the `observability` profile is no longer brought up. Two-VM shape unchanged at ~16 GiB committed.
- **Obs prom storage**: unchanged. The compose-side scrapes ride the same gateway fan-out path; removing them does not change what the obs prom receives.
- **Backout**: single revert restores compose observability. A developer on a stale checkout post-revert may need to re-establish `infra/observability/` from the revert; for slice-23 work this is unlikely to matter because the trajectory is obs-only.
