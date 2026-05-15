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
