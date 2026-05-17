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

# Slice 19 (add-cross-cluster-mtls) — cert directory variables.
# The CA cert + openssl.cnf live in the shared `infra/observability`
# tree (one trust anchor, two clusters consume it); the per-cluster
# leaf certs live alongside each collector's base kustomization so
# the Kustomize secretGenerator can read them directly.
OBS_CERTS_CA_DIR := "infra/observability/certs"
OBS_CERTS_APP_DIR := "infra/k8s/base/collector/certs"
OBS_CERTS_OBS_DIR := "infra/k8s-obs/base/collector/certs"

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

# === Slice 20 (add-k3s-pod-log-shipping) — node-local log-agent
# DaemonSet verbs. ===
#
# The log-agent DaemonSet lives in the `social` namespace, one
# pod per node (today: a single-node Lima k3s cluster), and
# tails JSON-shaped backend stdout from /var/log/pods then
# forwards OTLP/gRPC plaintext to the gateway collector
# Service (`collector.social.svc.cluster.local:4317`). The
# gateway then carries it through the slice-19 mTLS envelope
# to the obs cluster's Loki. See README "k3s pod log shipping".
#
# Two daily verbs only — the DaemonSet ships in the base
# overlay so `just k8s-apply` already stands it up.

# Label-scoped so this picks up every replica on multi-node
# clusters; follows.
#
# Tail log-agent pod logs (follow).
log-agent-logs:
    kubectl logs -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=log-agent --tail=200 -f

# kubelet does NOT auto-restart pods when a mounted ConfigMap's
# data changes. Blocks on rollout-status (120s — DaemonSet
# rollout is per-node and slower than a single-pod Deployment).
#
# Roll the log-agent DaemonSet to pick up ConfigMap edits.
log-agent-rollout:
    kubectl rollout restart daemonset/log-agent -n {{PG_NAMESPACE}}
    kubectl rollout status daemonset/log-agent -n {{PG_NAMESPACE}} --timeout=120s

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
#
# Slice 19 (add-cross-cluster-mtls) bootstrap guard: if the shared
# self-signed CA cert is missing, run `just obs-certs` first so the
# Kustomize secretGenerators on both clusters have cert material to
# fold into Secrets at apply time. The guard checks `ca.crt` only —
# a missing leaf cert is a "developer manually deleted a file"
# scenario which the loud-fail handshake error path (design.md
# Decision 6) handles correctly.
obs-up:
    @if [ ! -f {{OBS_CERTS_CA_DIR}}/ca.crt ]; then echo "slice-19 mTLS: {{OBS_CERTS_CA_DIR}}/ca.crt missing — running 'just obs-certs' first."; just obs-certs; fi
    limactl start --name={{OBS_VM_NAME}} {{OBS_LIMA_YAML}}

# Slice 19 (add-cross-cluster-mtls) — generate the cross-cluster
# trust material end-to-end. Idempotent: re-running regenerates
# every artifact (new random keys, new signed leaves). Kustomize
# `secretGenerator`s hash the contents, so a re-run automatically
# rolls the collector pods on the next `kubectl apply -k ...` —
# rotation is therefore a one-command operation.
#
# Layout this recipe produces:
#   infra/observability/certs/
#     ca.crt              public, committed (10-year self-signed CA)
#     ca.key              private, gitignored
#     openssl.cnf         committed (subject DNs + extension blocks)
#   infra/k8s-obs/base/collector/certs/
#     server.crt          public, committed (1-year obs receiver cert)
#     server.key          private, gitignored
#     ca.crt              copy of the CA cert (server side verifies clients)
#   infra/k8s/base/collector/certs/
#     client.crt          public, committed (1-year app exporter cert)
#     client.key          private, gitignored
#     ca.crt              copy of the CA cert (client side verifies server)
#
# Bails loudly with an install hint if `openssl` is not on $PATH.
# Uses the `set -euo pipefail` posture so any openssl step that
# fails aborts the recipe (no partially-regenerated cert set).
obs-certs:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v openssl >/dev/null 2>&1; then
        echo "ERROR: 'openssl' not on PATH. macOS: 'brew install openssl' (and follow brew's PATH hint). Debian/Ubuntu: 'sudo apt install openssl'." >&2
        exit 1
    fi
    CA_DIR="{{OBS_CERTS_CA_DIR}}"
    APP_DIR="{{OBS_CERTS_APP_DIR}}"
    OBS_DIR="{{OBS_CERTS_OBS_DIR}}"
    CONFIG="${CA_DIR}/openssl.cnf"
    mkdir -p "${CA_DIR}" "${APP_DIR}" "${OBS_DIR}"

    # 1. Self-signed CA (10 years).
    openssl req -x509 -new -nodes -newkey rsa:4096 -sha256 \
        -days 3650 \
        -keyout "${CA_DIR}/ca.key" \
        -out "${CA_DIR}/ca.crt" \
        -subj "/CN=prod-ready-social-media local CA/O=prod-ready-social-media/OU=slice-19-cross-cluster-mtls" \
        -config "${CONFIG}" \
        -extensions ca_ext

    # 2. Obs collector server cert (1 year). CSR -> CA-signed leaf.
    openssl req -new -nodes -newkey rsa:2048 -sha256 \
        -keyout "${OBS_DIR}/server.key" \
        -out "${OBS_DIR}/server.csr" \
        -subj "/CN=collector.observability.svc.cluster.local/O=prod-ready-social-media/OU=obs-collector"
    openssl x509 -req -in "${OBS_DIR}/server.csr" \
        -CA "${CA_DIR}/ca.crt" -CAkey "${CA_DIR}/ca.key" -CAcreateserial \
        -out "${OBS_DIR}/server.crt" \
        -days 365 -sha256 \
        -extfile "${CONFIG}" -extensions server_ext
    rm -f "${OBS_DIR}/server.csr"

    # 3. App collector client cert (1 year). CSR -> CA-signed leaf.
    openssl req -new -nodes -newkey rsa:2048 -sha256 \
        -keyout "${APP_DIR}/client.key" \
        -out "${APP_DIR}/client.csr" \
        -subj "/CN=app-collector/O=prod-ready-social-media/OU=app-collector"
    openssl x509 -req -in "${APP_DIR}/client.csr" \
        -CA "${CA_DIR}/ca.crt" -CAkey "${CA_DIR}/ca.key" -CAcreateserial \
        -out "${APP_DIR}/client.crt" \
        -days 365 -sha256 \
        -extfile "${CONFIG}" -extensions client_ext
    rm -f "${APP_DIR}/client.csr"

    # 4. Distribute the CA cert to both per-cluster dirs so each
    #    side can verify the other's leaf at TLS handshake time.
    cp "${CA_DIR}/ca.crt" "${OBS_DIR}/ca.crt"
    cp "${CA_DIR}/ca.crt" "${APP_DIR}/ca.crt"

    # 5. Clean the openssl serial file (each run uses -CAcreateserial
    #    so the file is single-use).
    rm -f "${CA_DIR}/ca.srl"

    echo "slice-19 mTLS material written:"
    echo "  CA:     ${CA_DIR}/ca.crt (+ ca.key, gitignored)"
    echo "  server: ${OBS_DIR}/server.crt (+ server.key, gitignored; ca.crt copy)"
    echo "  client: ${APP_DIR}/client.crt (+ client.key, gitignored; ca.crt copy)"

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

# === Slice 18b (bridge-collectors-to-obs-cluster) — obs-cluster
# collector verbs. ===
#
# The obs-cluster collector lives in the `observability`
# namespace alongside the LGTM stack and receives OTLP from the
# app cluster collector via Lima's portForward
# (`host.lima.internal:14317` -> obs VM :4317 -> klipper-lb ->
# this Service). Daily verbs only — `just obs-apply` already
# stands the collector up.

# Tail obs-cluster collector pod logs (follow).
obs-collector-logs:
    kubectl --context {{OBS_CONTEXT}} logs -n {{OBS_NAMESPACE}} deploy/collector -f

# Roll the obs-cluster collector Deployment to pick up ConfigMap
# edits (kubelet does NOT auto-restart pods when a mounted
# ConfigMap's data changes). Blocks on rollout-status (60 s — the
# contrib collector starts in well under a second).
#
# Roll the obs-cluster collector Deployment to pick up ConfigMap edits.
obs-collector-rollout:
    kubectl --context {{OBS_CONTEXT}} rollout restart deploy/collector -n {{OBS_NAMESPACE}}
    kubectl --context {{OBS_CONTEXT}} rollout status deploy/collector -n {{OBS_NAMESPACE}} --timeout=60s
