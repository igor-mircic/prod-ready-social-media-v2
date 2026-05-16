# Local k3s cluster verbs. Documentation for the dev loop these
# recipes drive lives in README.md under "Local k3s cluster" —
# read that first if you're new to the slice.
#
# Dependencies (brew install on macOS):
#   lima    — Linux VM for hosting k3s (https://lima-vm.io/)
#   just    — this task runner
#   kubectl — apiserver client (talks to k3s via the Lima-forwarded :16443)
#   helm    — `kustomize build --enable-helm` shells out to `helm template`
#   libpq   — provides the host-side `psql` client used by `just psql`
#
# All recipes operate on the Lima instance named `lima-social`; do
# not rename without updating every recipe AND the kubeconfig
# rewrite block in infra/lima/lima.yaml.

VM_NAME := "lima-social"
LIMA_YAML := "infra/lima/lima.yaml"
LOCAL_OVERLAY := "infra/k8s/overlays/local"
PG_LABEL := "app.kubernetes.io/name=postgresql"
PG_NAMESPACE := "social"
PG_URL := "postgres://social:social@localhost:5432/social"

# Slice 17 (add-local-k3s-obs-cluster) — observability cluster
# variables. The obs cluster lives in a SECOND Lima VM (`social-
# obs`) with its own kubeconfig context (`social-obs`) and its
# own kustomize tree (`infra/k8s-obs/`). See README "Local
# observability cluster" for the dev loop these recipes drive.
OBS_VM_NAME := "social-obs"
OBS_LIMA_YAML := "infra/lima/obs.yaml"
OBS_LOCAL_OVERLAY := "infra/k8s-obs/overlays/local"
OBS_CONTEXT := "social-obs"
OBS_NAMESPACE := "observability"

# Default recipe: print the verb surface with its inline descriptions.
default:
    @just --list

# Boot the Lima VM (idempotent — first boot runs the provision
# script, subsequent runs are a stop/start). Blocks until the VM
# reaches Ready.
vm-up:
    limactl start --name={{VM_NAME}} {{LIMA_YAML}}

# Stop the Lima VM. The on-disk image is preserved; `just vm-up`
# resumes from the same state. Do NOT auto-delete the VM here.
vm-down:
    limactl stop {{VM_NAME}}

# Open an interactive shell inside the Lima VM (useful for poking
# at k3s with the in-VM kubectl, journalctl, etc.).
vm-shell:
    limactl shell {{VM_NAME}}

# Render the local overlay with `--enable-helm` and apply. Wait
# briefly for the StatefulSet to spawn its pod, then up to 180 s
# for it to reach Ready. The sleep avoids the "apply returned but
# the StatefulSet has not created its pod yet" race that makes
# `kubectl wait` exit immediately with "no matching resources
# found". After Ready, force-run the pg_stat_statements
# CREATE EXTENSION via `kubectl exec` — Bitnami chart 15.5.38's
# auto-execution of `/docker-entrypoint-initdb.d/*.sql` mounted
# from `primary.initdb.scripts` is unreliable in this release, so
# we belt-and-braces it. The SQL is idempotent.
k8s-apply:
    kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl apply -f -
    @sleep 5
    kubectl wait --for=condition=Ready pod -l {{PG_LABEL}} -n {{PG_NAMESPACE}} --timeout=180s
    kubectl exec -n {{PG_NAMESPACE}} postgres-postgresql-0 -- bash -c 'PGPASSWORD="$POSTGRES_POSTGRES_PASSWORD" psql -U postgres -d social -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"'
    # Grant `pg_read_all_stats` to the `social` role so the in-compose
    # `postgres-exporter` (running as `social`) can read every
    # `pg_stat_statements` row's `queryid`. Without it, rows the
    # non-superuser can't see collapse to `queryid=""` and the
    # exporter emits duplicate label sets → /metrics returns errors.
    # The old `postgres:16-alpine` compose image created `social` as
    # superuser by default; Bitnami's chart creates it as a plain
    # user, so the grant is the bridge. Idempotent.
    kubectl exec -n {{PG_NAMESPACE}} postgres-postgresql-0 -- bash -c 'PGPASSWORD="$POSTGRES_POSTGRES_PASSWORD" psql -U postgres -d social -c "GRANT pg_read_all_stats TO social"'

# Show the cluster-vs-manifest delta. `kubectl diff` exits non-zero
# when changes are present (by design); the leading `-` tells just
# to treat that as a successful recipe result.
k8s-diff:
    -kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl diff -f -

# Tear down every resource the local overlay renders. Leaves the
# Lima VM running; pair with `just vm-down` for a full stop.
k8s-delete:
    kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl delete -f -

# Open an interactive psql session against the in-cluster postgres
# via the Lima-forwarded :5432. Requires the host-side `psql`
# binary — `brew install libpq` and follow brew's PATH hint, or
# `brew install postgresql` for the full client.
psql:
    psql {{PG_URL}}

# Placeholder. The add-hetzner-deploy slice will replace this with
# a `kubectl --context hetzner-social -n social port-forward
# svc/postgres 15432:5432` invocation so the developer can reach
# the production postgres over the apiserver tunnel.
db-forward-hetzner:
    @echo "TODO: implemented by the add-hetzner-deploy slice."
    @echo "      Will run: kubectl --context hetzner-social -n social port-forward svc/postgres 15432:5432"

# === Slice 15 (add-local-k3s-backend) — backend-in-cluster verbs. ===
#
# Side-channel: these recipes drive the OPT-IN k3s backend loop.
# `./gradlew :backend:bootRun` and the e2e harness still target the
# host JVM; nothing in CI uses these. See README "Run the backend
# in cluster (optional)" for the full flow and the registry
# hostname asymmetry the implementation rests on.

# Boot the local registry compose profile if it is not already up,
# then build the backend image with Spring Boot's buildpacks and
# push it to the registry. The Gradle chain (declared in
# `backend/build.gradle.kts`) does:
#   bootBuildImage → bakeBackendImage (adds the OTel agent layer)
#                 → pushBackendImage (when -Ppublish=true)
# The push tag is `127.0.0.1:5000/backend:dev` (host-resolvable);
# the cluster pulls `registry.local:5000/backend:dev` and the k3s
# `registries.yaml` mirror rewrites it to `host.lima.internal:5000`.
#
# Build the backend image and push it to the local OCI registry.
backend-image:
    docker compose --profile registry up -d registry
    cd backend && ./gradlew bootBuildImage -Ppublish=true
    @echo "Image pushed: 127.0.0.1:5000/backend:dev (cluster reference: registry.local:5000/backend:dev)"

# Apply the local overlay and block on rollout-status (180s
# absorbs JVM cold start + Flyway on a busy laptop).
backend-apply:
    kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl apply -f -
    kubectl rollout status deploy/backend -n {{PG_NAMESPACE}} --timeout=180s

# Tail backend pod logs (follow).
backend-logs:
    kubectl logs -n {{PG_NAMESPACE}} deploy/backend -f

# Port-forward the in-cluster backend Service to host :18080. The
# 18080 choice is deliberate so this recipe does NOT collide with
# the host `./gradlew :backend:bootRun` loop on :8080; both can run
# side-by-side for A/B comparison. `kubectl port-forward` is a
# long-running foreground process — open a separate terminal.
#
# Port-forward the in-cluster backend to host :18080.
backend-forward:
    kubectl port-forward -n {{PG_NAMESPACE}} svc/backend 18080:8080

# Tear down backend Deployment + Service (label-scoped).
backend-delete:
    kubectl delete deploy,svc,cm -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=backend --ignore-not-found

# Rebuild the image + apply in one shot (the 95% path).
backend-rebuild: backend-image backend-apply

# === Slice 16 (add-local-k3s-frontend) — frontend-in-cluster verbs. ===
#
# Side-channel: these recipes drive the OPT-IN k3s frontend loop.
# `pnpm dev` (host Vite on :5173) and the e2e `vite preview` harness
# (on :4173) still own the canonical dev flow; nothing in CI uses
# these. See README "Run the frontend in cluster (optional)" for the
# full flow.
#
# The in-k3s frontend strictly pairs with the in-k3s backend — nginx
# in the pod reverse-proxies `/api/*` and `/actuator/*` to
# `backend.social.svc.cluster.local:8080`. Running this without
# `just backend-apply` first yields HTTP 502 on API calls (by design;
# see design.md Decision 5).
#
# Build context is the REPO ROOT (`.`) so the Dockerfile can reach
# `openapi/openapi.json` — orval's input — without symlink trickery.
# Push tag is `127.0.0.1:5000/frontend:dev` (host-resolvable); the
# cluster references `registry.local:5000/frontend:dev` and the k3s
# `registries.yaml` mirror rewrites it to `host.lima.internal:5000`.
#
# Build the frontend image and push it to the local OCI registry.
frontend-image:
    docker compose --profile registry up -d registry
    docker build -f frontend/Dockerfile -t 127.0.0.1:5000/frontend:dev .
    docker push 127.0.0.1:5000/frontend:dev
    @echo "Image pushed: 127.0.0.1:5000/frontend:dev (cluster reference: registry.local:5000/frontend:dev)"

# Apply the local overlay and block on rollout-status (120s is
# generous — nginx-on-arm64 starts in well under a second).
#
# Apply the local overlay and block until frontend is Ready.
frontend-apply:
    kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl apply -f -
    kubectl rollout status deploy/frontend -n {{PG_NAMESPACE}} --timeout=120s

# Tail frontend pod logs (follow).
frontend-logs:
    kubectl logs -n {{PG_NAMESPACE}} deploy/frontend -f

# The 13000 choice is deliberate so this recipe does NOT collide with
# Vite dev (`:5173`), Vite preview (`:4173`), or the slice-15 backend
# port-forward (`:18080`). `kubectl port-forward` is a long-running
# foreground process — open a separate terminal.
#
# Port-forward the in-cluster frontend to host :13000.
frontend-forward:
    kubectl port-forward -n {{PG_NAMESPACE}} svc/frontend 13000:80

# Tear down frontend Deployment + Service (label-scoped).
frontend-delete:
    kubectl delete deploy,svc -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=frontend --ignore-not-found

# Rebuild the image + apply in one shot (the 95% path).
frontend-rebuild: frontend-image frontend-apply

# === Slice 18a (add-k3s-app-collector) — in-cluster OTel
# collector verbs. ===
#
# The collector pod lives in the `social` namespace alongside the
# backend and frontend. The backend's OTLP target points at this
# collector's ClusterIP Service
# (`collector.social.svc.cluster.local:4318`); the collector
# relays traces to the compose collector at
# `host.lima.internal:4317` for the duration of the transition
# (slices 18a..21). See README "Collector relay (in-cluster)"
# for the full picture.
#
# Two daily verbs only — the collector ships with the base
# overlay so `just backend-apply` and `just k8s-apply` already
# stand it up. There is no `collector-image` (the contrib image
# is a public Docker Hub pin) and no `collector-forward` (only
# in-cluster pods talk to it; OTLP is not interesting to point a
# browser at).

# Tail collector pod logs (follow).
collector-logs:
    kubectl logs -n {{PG_NAMESPACE}} deploy/collector -f

# The kubelet does NOT auto-restart pods when a mounted ConfigMap's
# data changes; `rollout restart` is the documented pattern. Blocks
# on rollout-status (60s — the contrib collector starts in well
# under a second; the timeout is a safety net, not an expected wait).
#
# Roll the collector Deployment to pick up ConfigMap edits.
collector-rollout:
    kubectl rollout restart deploy/collector -n {{PG_NAMESPACE}}
    kubectl rollout status deploy/collector -n {{PG_NAMESPACE}} --timeout=60s

# === Slice 17 (add-local-k3s-obs-cluster) — observability cluster
# verbs. ===
#
# These recipes drive the SECOND Lima VM (`social-obs`) that hosts
# the in-cluster LGTM stack (Prometheus, Loki, Tempo, Grafana,
# Alertmanager). The app cluster (`lima-social`) and its workloads
# are unaffected; the host docker-compose observability stack
# continues to receive app telemetry on port 4318 — see README
# "Local observability cluster" for the full rationale (two-cluster
# fate-separation pattern, mirrors the future Hetzner two-box
# deploy) and the dev loop these recipes drive.
#
# Common-vs-app-cluster differences to remember:
#   - VM name:    `social-obs`     (app cluster: `lima-social`)
#   - Context:    `social-obs`     (app cluster: `lima-social`)
#   - apiserver:  localhost:6444   (app cluster: localhost:16443)
#   - Namespace:  `observability`  (app cluster: `social`)
#   - Tree:       infra/k8s-obs/   (app cluster: infra/k8s/)
#
# The obs cluster has NO data flowing in yet — that lands in slice
# 18 (add-k3s-app-collector). Grafana stands up with an empty data
# sources list; this is the expected end state for slice 17.

# Boot the obs Lima VM (idempotent — first boot runs the shared
# install-k3s.sh script, subsequent runs are a stop/start). Blocks
# until the VM reaches Ready. Mirrors the app cluster's `vm-up`.
obs-up:
    limactl start --name={{OBS_VM_NAME}} {{OBS_LIMA_YAML}}

# Stop the obs Lima VM. The on-disk image is preserved (PVC
# contents survive); `just obs-up` resumes from the same state. Do
# NOT auto-delete the VM. Pair with `just vm-down` to fully stop
# both clusters when not actively working.
obs-down:
    limactl stop {{OBS_VM_NAME}}

# One-shot summary an operator can run to confirm obs cluster
# health: the VM's lima state, the cluster node's readiness, and
# the per-resource shape of the `observability` namespace.
obs-status:
    @echo "=== Lima VM ==="
    limactl list {{OBS_VM_NAME}}
    @echo "=== Cluster node ==="
    kubectl --context {{OBS_CONTEXT}} get nodes
    @echo "=== observability namespace ==="
    kubectl --context {{OBS_CONTEXT}} -n {{OBS_NAMESPACE}} get pods,pvc,svc

# Port-forward the in-cluster grafana to host :3001. The 3001
# choice is deliberate so this recipe does NOT collide with the
# compose grafana on :3000 (both stacks run side-by-side until
# slice 22 retires the compose stack). `kubectl port-forward` is
# a long-running foreground process — open a separate terminal.
#
# Default grafana admin credentials (local-dev only):
#   user:     admin
#   password: obs-local-dev
# The Secret is committed under
# infra/k8s-obs/base/grafana/secret.yaml. See README
# "Local observability cluster" for the full credential note.
obs-grafana:
    kubectl --context {{OBS_CONTEXT}} -n {{OBS_NAMESPACE}} port-forward svc/grafana 3001:80

# Render the obs local overlay with `--enable-helm` and apply.
# Wait up to 180 s for every pod in the `observability` namespace
# to reach Ready — the LGTM stack's image pulls dominate first-
# apply latency.
obs-apply:
    kustomize build --enable-helm {{OBS_LOCAL_OVERLAY}} | kubectl --context {{OBS_CONTEXT}} apply -f -
    kubectl --context {{OBS_CONTEXT}} wait --for=condition=Ready pod --all -n {{OBS_NAMESPACE}} --timeout=180s

# Show the cluster-vs-manifest delta for the obs overlay. `kubectl
# diff` exits non-zero when changes are present (by design); the
# leading `-` tells just to treat that as a successful recipe.
obs-diff:
    -kustomize build --enable-helm {{OBS_LOCAL_OVERLAY}} | kubectl --context {{OBS_CONTEXT}} diff -f -

# Tear down every resource the obs local overlay renders. Leaves
# the Lima VM running; pair with `just obs-down` for a full stop.
obs-delete:
    kustomize build --enable-helm {{OBS_LOCAL_OVERLAY}} | kubectl --context {{OBS_CONTEXT}} delete -f -
