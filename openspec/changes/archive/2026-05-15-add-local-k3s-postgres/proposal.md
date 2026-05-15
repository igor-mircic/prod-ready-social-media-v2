## Why

The project's dev loop has been "Spring Boot on host + `docker-compose up postgres` + opt-in observability profile" since slice 1. That pattern stops scaling for two reasons. First, the eventual deploy target is a single Hetzner CAX21 box running k3s — the production-grade architecture choice over docker-compose-in-prod or a PaaS — and there is no honest way to learn k8s primitives by writing them only for the production environment. Second, the existing observability work (slices 1-13) has built a complete telemetry loop around the *current* dev stack; if the production stack is k3s, every dashboard, scrape config, and alert needs to translate to a k3s world, and the translation is best worked out incrementally with a real cluster sitting on the laptop, not theoretically. This slice introduces a single-node k3s cluster running inside a Lima VM that is shape-identical to the future Hetzner box (4 vCPU, 8 GiB RAM, arm64, Ubuntu 24.04), wires it into the dev loop by migrating the dev postgres into it, and proves the loop end-to-end: backend on host → `localhost:5432` → Lima port-forward → k3s Service → postgres pod. Once this lands, every subsequent slice — backend image build, observability migration, Hetzner deploy — has a real cluster to land on instead of a paper plan.

## What Changes

- **New `infra/lima/lima.yaml`** — declarative Lima VM definition. Ubuntu 24.04 LTS, arm64 (matches Hetzner CAX21), 4 vCPU / 8 GiB / 64 GiB disk. Declares `portForwards` for `5432` (postgres), and `kubeconfig` `copyToHost` so `kubectl` from macOS works without a manual sync step. Runs the shared provision script via Lima's `provision:` block on first boot.
- **New `infra/provisioning/install-k3s.sh`** — shared bootstrap script invoked by Lima on first boot AND (eventually) by the Hetzner deploy slice as a cloud-init userdata script. Installs k3s via the official one-liner with `INSTALL_K3S_EXEC=` empty (keeping the bundled Traefik ingress, klipper ServiceLB, local-path storage, and metrics-server — the documented default). Pins a specific k3s channel/version (no `latest`). Optionally installs Helm and `kustomize` binaries on the node for in-VM usage; the host-driven workflow does not require them, but having them on the node makes `lima shell` debugging easier.
- **New `infra/k8s/` tree** following the Kustomize base/overlay layout:
  ```
  infra/k8s/
  ├── base/
  │   ├── kustomization.yaml          (namespace: social, lists ./postgres)
  │   └── postgres/
  │       ├── kustomization.yaml      (helmCharts: bitnami/postgresql)
  │       ├── values.yaml             (chart values: image tag, persistence, pg_stat_statements, metrics)
  │       ├── service-lb.yaml         (LoadBalancer Service so klipper-lb hands out an external IP)
  │       └── secret.yaml             (plain Secret with the local-dev password — same value as today's docker-compose)
  └── overlays/
      ├── local/
      │   └── kustomization.yaml      (local-overlay-specific patches: PVC size, resource caps)
      └── hetzner/                    (placeholder for the next slice; empty kustomization with TODO)
          └── kustomization.yaml
  ```
- **Bitnami `postgresql` Helm chart pinned in the base postgres `kustomization.yaml`** under the `helmCharts:` directive. Chart version pinned (not `latest`). Values configure:
  - postgres image tag matching the docker-compose `postgres:16-alpine` pin (Bitnami's `bitnami/postgresql` image is the chart default — image tag pinned to a `16.x` release).
  - `auth.username: social`, `auth.database: social`, `auth.existingSecret: postgres-credentials` (the plain Secret committed under `base/postgres/secret.yaml`).
  - `primary.extendedConfiguration: |\n  shared_preload_libraries = 'pg_stat_statements'` so `pg_stat_statements` is loaded at startup (matches the current docker-compose `command:` override).
  - `primary.initdb.scripts.01-pg-stat-statements.sql:` containing the `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` statement currently in `infra/observability/postgres/init/01-pg-stat-statements.sql`. Same SQL, new transport.
  - `primary.persistence.size: 5Gi`, `primary.persistence.storageClass: local-path` (k3s default).
  - `primary.resources.requests` / `limits` sized at the docker-compose ceiling (`memory: 1Gi`, `cpu: 2`) so the postgres pod has the same resource envelope it had under compose.
  - `metrics.enabled: false` — the existing `postgres-exporter` container under the `observability` compose profile keeps doing its job; it just retargets at `host.docker.internal:5432` to reach the now-port-forwarded k3s postgres. Bitnami's bundled exporter is a clean future move (separate slice) and is deliberately deferred.
- **`infra/k8s/base/postgres/service-lb.yaml`** — a second Service (alongside the chart's ClusterIP) of type `LoadBalancer` exposing port `5432`. k3s's klipper ServiceLB assigns it the VM's primary IP, and the Lima `portForwards` line in `lima.yaml` forwards macOS `localhost:5432` to that VM IP. Net effect: any host process (backend, `psql`, IntelliJ) hitting `localhost:5432` reaches the in-cluster postgres unchanged.
- **New `justfile` at repo root** exposing the daily-dev verbs:
  - `just vm-up` / `just vm-down` / `just vm-shell` — Lima lifecycle.
  - `just k8s-apply` — `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -`.
  - `just k8s-diff` — same with `kubectl diff -f -` so changes can be previewed.
  - `just k8s-delete` — tear down everything in the `social` namespace.
  - `just psql` — `psql postgres://social:social@localhost:5432/social` shortcut.
  - `just db-forward-hetzner` — placeholder for later (prints a TODO).
- **`docker-compose.yml` migration** — remove the `postgres` service definition (it is now redundant) but **keep** the named volume `postgres-data` declaration with a comment noting it is no longer used (so a `git revert` to a slice that used compose-postgres restores cleanly). Update `postgres-exporter`'s `DATA_SOURCE_URI` from `postgres:5432/...` to `host.docker.internal:5432/...` so the existing observability scrape continues to work against the new in-k3s postgres. The init-script bind mount on `postgres-data` is removed; init scripts now live in `infra/k8s/base/postgres/values.yaml` via the Bitnami chart's `primary.initdb.scripts`.
- **README updates** under a new "Local k3s cluster" section explaining: what Lima is and where to install it (`brew install lima`); how the `lima.yaml` and provision script relate; the `justfile` verb surface; how the dev postgres workflow now flows through the cluster and what to do if Lima is down (`just vm-up`); the explicit non-goal that the backend, frontend, and observability stack are NOT yet in k3s (separate future slices); and the spike notes captured in design.md so a future reader knows the planned learning side-quests.
- **Top-level `~/dotfiles/install.sh` (per the global CLAUDE.md guard)** gets `lima` and `just` added as idempotent `command -v` checks. Out-of-tree per project conventions, but flagged here because the global CLAUDE.md requires it when a project starts depending on a new brew package.

Explicit non-goals:

- **Backend, frontend, and observability are not moved to k3s in this slice.** That is the next several slices; the current docker-compose stack continues to drive everything except postgres. The slice is deliberately bounded to "postgres in k3s, host loop unchanged."
- **No CloudNativePG, no postgres-operator, no DIY StatefulSet hand-writing.** Bitnami chart is the chosen entry point. Two follow-up slices are captured as open questions: (1) a small spike that rewrites this same postgres as DIY Kustomize manifests for learning the StatefulSet primitives; (2) eventually migrating to CloudNativePG operator for production-grade backup / failover / PITR. Neither is in scope here.
- **No ingress-nginx swap.** k3s defaults (Traefik + klipper + local-path + metrics-server) are kept. A future slice may swap Traefik for ingress-nginx; called out as a deliberate spike, not an open question.
- **No Hetzner provisioning.** The `overlays/hetzner/` folder exists with a placeholder kustomization so the layout is in place, but no Hetzner-specific resources are declared in this slice.
- **No secrets encryption (SOPS, Sealed Secrets, External Secrets).** The committed Secret is a *local-dev* credential equivalent to the value already in `docker-compose.yml` since slice 0. The Hetzner overlay (next slice) is where the real secrets decision lands.
- **No multi-node k3s.** The cluster is a single-node `k3s server` matching the future Hetzner single-box deploy. A future learning side-quest may stand up a separate multi-VM Lima cluster as a playground; out of scope here.
- **No GitOps tool (ArgoCD, Flux).** Manifests are applied imperatively via `just k8s-apply`. GitOps is a sensible future slice once both local and Hetzner clusters are stable.

## Capabilities

### New Capabilities

- `kubernetes` — local-first Kubernetes cluster (k3s in a Lima VM today; Hetzner k3s in a follow-up slice) used to host stateful and stateless workloads that currently run in `docker-compose`. Initial scope: a single-node k3s server, the Bitnami postgresql Helm chart configured to match the docker-compose postgres semantics, and the `infra/lima/` + `infra/provisioning/` + `infra/k8s/` source-of-truth tree.

### Modified Capabilities

- `observability` — modified at the edges only. The `postgres-exporter` container retargets from `postgres:5432` to `host.docker.internal:5432` so it can continue scraping the now-in-k3s postgres without changing anything else about Prometheus, Grafana, alerts, or the SLO recording rules.
- `monorepo-layout` — the new top-level layout adds `infra/lima/`, `infra/provisioning/`, `infra/k8s/` siblings to the existing `infra/observability/`, plus a `justfile` at repo root.

## Impact

- **Affected files / directories:**
  - `infra/lima/lima.yaml` (new)
  - `infra/provisioning/install-k3s.sh` (new)
  - `infra/k8s/base/kustomization.yaml` (new)
  - `infra/k8s/base/postgres/kustomization.yaml`, `values.yaml`, `service-lb.yaml`, `secret.yaml` (new)
  - `infra/k8s/overlays/local/kustomization.yaml` (new)
  - `infra/k8s/overlays/hetzner/kustomization.yaml` (new placeholder)
  - `justfile` (new, at repo root)
  - `docker-compose.yml` — `postgres` service removed; `postgres-exporter` env var retargeted; comments updated.
  - `infra/observability/postgres/init/01-pg-stat-statements.sql` — kept in place for now (referenced from the Bitnami chart values via `primary.initdb.scripts`), but the bind mount in `docker-compose.yml` is removed. A future "delete the SQL file once nothing references it" cleanup may follow if the chart values inline the SQL directly.
  - `README.md` — new "Local k3s cluster" section; existing "Local observability" section updated to describe the postgres-exporter retarget.
- **New tool dependencies:**
  - `lima` (Apache-2.0; `brew install lima`) — single VM tool for macOS-hosted Linux.
  - `just` (CC0-1.0; `brew install just`) — task runner.
  - `kustomize` (Apache-2.0; bundled with kubectl 1.14+, so usually no separate install).
  - `kubectl` (Apache-2.0; assumed already present via Docker Desktop or `brew install kubectl`).
  - `helm` (Apache-2.0; required for the Kustomize `--enable-helm` path).
  Documented in README and added to `~/dotfiles/install.sh` per global CLAUDE.md.
- **Dependencies on external services:**
  - Bitnami chart repository (`registry-1.docker.io/bitnamicharts/postgresql`) — pinned chart version, pinned image tag inside.
  - k3s release channel — pinned via `INSTALL_K3S_VERSION` in the provision script.
- **CI:** no new CI jobs in this slice. The k3s/Lima workflow is dev-only; CI continues to use the existing `docker-compose --profile observability` pattern. A future slice will add a CI job that brings up Lima + k3s and runs a smoke test, once the test surface is large enough to justify the cost.
- **Compatibility:** breaking change to the dev loop — anyone who pulls this branch and runs `docker compose up postgres` will find no `postgres` service. README and CHANGELOG-equivalent commit message call this out. Mitigation: `git revert` cleanly restores the prior compose definition; the named volume is preserved.
- **macOS vs Linux:** Lima runs on both. arm64 VMs run natively on Apple Silicon; on Intel Macs Lima falls back to QEMU emulation (slower but functional). On a Linux dev box, the Lima VM is similarly an arm64-on-x86 emulation unless the host is itself arm64. The provision script is host-agnostic.
- **Rollback:** `git revert` the merge. docker-compose's `postgres` service definition is restored; named volume `postgres-data` is still present, so existing local data is intact. The `infra/lima/`, `infra/provisioning/`, `infra/k8s/` trees disappear with the revert, as does the `justfile`. The reverter would then `docker compose up -d postgres` to restore the prior dev loop. No persistent host state is created outside the Lima VM itself (which can be deleted with `limactl delete <name>`).
