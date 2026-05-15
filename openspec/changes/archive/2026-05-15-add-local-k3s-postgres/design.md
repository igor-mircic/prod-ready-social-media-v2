## Context

Thirteen observability slices and a baseline backend / frontend / e2e harness have built the project to "enterprise-realistic on a developer's laptop" — but every component still runs either on the host (backend, frontend) or in `docker-compose` (postgres, observability stack). The eventual deploy target is a single Hetzner CAX21 instance (4 vCPU, 8 GiB, arm64, ~€4.50/mo) running k3s as a single-node cluster — a choice driven by the project's "production-grade architectures over MVP shortcuts" stance combined with a strict "no surprise bills" budget posture. Hetzner offers flat-rate compute, generous bundled egress, and a managed-postgres path if we want it later; the CAX21 (ARM) is the price-leader because Java / Postgres / the OTel collector / Grafana / Prometheus / Tempo / Loki all ship first-class arm64 images today.

The bridge from "compose on a laptop" to "k3s on a Hetzner box" is best built as a single-node k3s cluster running locally in a Lima VM whose shape — CPU count, RAM, architecture, distro — is identical to the eventual Hetzner instance. The same provision script that installs k3s in the Lima VM will install k3s on Hetzner; the same Kustomize overlays will deploy the same workloads. The cluster on the laptop is not a play-area; it becomes the dev cluster.

This first slice is deliberately scoped to standing up the cluster and migrating one workload — postgres — into it. The backend, frontend, and observability stack stay where they are. The single workload chosen (postgres) is the highest-value migration because (1) every existing dev-loop interaction touches it, (2) it forces the storage class, secret handling, port-forward, and Kustomize layout decisions all in one go, and (3) one workload is the smallest unit that proves the slice's value end-to-end.

The slice changes infrastructure only. Application code is untouched. The backend continues to connect to `localhost:5432`; what is *behind* `localhost:5432` is the only thing changing.

## Goals / Non-Goals

**Goals:**

- Stand up a single-node k3s cluster inside a Lima VM whose shape matches the future Hetzner CAX21.
- Make the cluster's lifecycle (`up`, `down`, `shell`, `apply`, `diff`, `delete`) drivable via a small `justfile` surface.
- Migrate the dev postgres into the cluster via the Bitnami `postgresql` Helm chart, retaining `pg_stat_statements`, the existing init SQL, and the existing credentials.
- Expose the in-cluster postgres on `localhost:5432` from the macOS host transparently, so neither the backend, IDEs, `psql`, nor the observability `postgres-exporter` need any code change beyond a single `DATA_SOURCE_URI` retarget.
- Establish the `infra/k8s/` directory shape (`base/<component>/`, `overlays/{local,hetzner}/`) that every subsequent k8s-bound workload will follow.
- Capture the agreed conventions (Lima YAML committed to git, provision script shared between local and Hetzner, Kustomize for own code + Helm for third-party, single `social` namespace, plain Secret for local-dev) explicitly enough that the next slice does not have to relitigate them.

**Non-Goals:**

- Migrating the backend, frontend, or observability stack into k3s. Those are at least three follow-up slices.
- Provisioning the Hetzner instance. The `overlays/hetzner/` placeholder establishes intent; the actual Hetzner deploy is a separate slice.
- Production-grade secrets handling (SOPS, Sealed Secrets, External Secrets Operator). The local-dev Secret is committed in plaintext-equivalent base64; the real-secrets decision happens in the Hetzner slice.
- Production-grade postgres (CloudNativePG operator, multi-replica streaming replication, point-in-time recovery, S3 backups). The Bitnami chart is the entry point. Two follow-up slices are scoped as future work: a DIY-StatefulSet learning spike, and an eventual CNPG migration.
- ingress-nginx, cert-manager, MetalLB, Linkerd / Istio. None are needed for postgres-only.
- GitOps reconciliation (ArgoCD, Flux). Manifests apply imperatively via `just k8s-apply`.
- A CI job that brings up the cluster. Dev-only for now.

## Decisions

### Decision 1 — Lima, not OrbStack / k3d / Rancher Desktop / Minikube

Lima is an open-source (Apache-2.0) Linux-VMs-on-macOS tool maintained by containerd-adjacent maintainers (Akihiro Suda et al.). It is the upstream that both Rancher Desktop and Colima wrap, and at the time of writing has ~21k GitHub stars, a stable v2 API, and active maintenance (commits within the last 24h).

Lima is preferred over:

- **OrbStack.** Faster boot and lower idle overhead, but closed-source / proprietary. The project's "weigh AI-workflow iteration speed, AND prefer open infrastructure" stance pushes toward Lima despite the ergonomic gap. Lima's boot time (~30s) and idle footprint (~250 MiB) are acceptable for a dev cluster that stays up for hours.
- **k3d** (k3s inside Docker containers). Convenient for quick CI clusters; misleading for stress testing because container-in-container resource limits behave differently from a real VM with capped CPU/RAM. Local fidelity to Hetzner (a real Linux VM running k3s on a kernel) is the slice's load-bearing property, and k3d does not preserve it.
- **Rancher Desktop.** Lima underneath, plus an opinionated GUI / k3s-bundled / Docker-engine-swap layer. Useful for newcomers; adds friction for committing the VM definition to git and for swapping k3s versions / channels on demand.
- **Minikube.** Multi-distro, multi-driver, much bigger surface than needed. The "many drivers, many distros" flexibility is not a feature for a project standardizing on one shape.

Rejected after consideration:

- **Multipass (Canonical).** Ubuntu-first VM tool; viable. Edged out by Lima's larger community, more declarative YAML, and arm64 default on Apple Silicon. Multipass works fine on macOS; the choice is preference, not capability.
- **UTM.** Full QEMU-based hypervisor with a GUI. Overkill; not declarative.

### Decision 2 — Single-node k3s, sized to match Hetzner CAX21

The Lima VM is `cpus: 4`, `memory: 8GiB`, `disk: 64GiB`, arch: arm64, distro: Ubuntu 24.04 LTS. These match the future Hetzner CAX21 1:1 (4 vCPU shared, 8 GiB RAM, 80 GiB disk on CAX21 — slightly larger; the laptop VM is sized at 64 GiB to leave headroom for the host OS). Running both as single-node k3s clusters means stress tests transfer: if a workload OOMs in the Lima VM, it will OOM on Hetzner.

Multi-node Lima cluster (1 server + 2 agents) was considered as a learning surface and rejected for this slice: (a) it diverges from the eventual single-box Hetzner deploy, (b) it triples the VM lifecycle complexity, (c) the multi-node primitives (taints, tolerations, drain, pod anti-affinity, cross-node networking) are out of scope until the project actually runs multi-node — which it might never, depending on how the Hetzner story evolves. A future learning side-quest may stand up a separate "playground" multi-node Lima cluster; that is not this slice.

The single-node nature is *explicit*: no HA, no failover, no replicated storage. local-path PVs live on the VM's disk; if the VM dies, the data dies. This is the same posture as the production single-box Hetzner plan, so the local cluster is honest about what it is.

### Decision 3 — `lima.yaml` committed to git, k3s installed by a shared provision script

Lima supports two paths for "VM with k3s on it":

- **Built-in `lima://k3s` template.** One command, k3s pre-bundled. Hides the install. Pinned to Lima's release cadence rather than k3s's; harder to swap versions; less transparent.
- **Custom `lima.yaml` with a `provision:` block running our own install script.** Slightly more upfront, but the same shell script that runs in the Lima `provision:` hook will run later as cloud-init userdata on Hetzner. The provision script is the source of truth for "what an installed k3s node looks like in this project."

We pick the second. The `provision:` block executes the script on first boot only; subsequent `limactl start` invocations skip it. The script is idempotent (every command guarded by `command -v` or "already-installed" checks).

Pinning: the k3s install is pinned via `INSTALL_K3S_VERSION=v1.31.x+k3s1` (exact patch resolved at implementation time). No `latest` channel. Re-pinning is a deliberate edit to the script.

### Decision 4 — Keep k3s defaults (Traefik + klipper + local-path + metrics-server)

k3s ships with Traefik (ingress), klipper-lb (ServiceLB for bare-metal LoadBalancer Services), local-path-provisioner (default StorageClass), and metrics-server (`kubectl top`, HPA). All four are useful, all four are reasonable defaults, all four work out of the box. We keep them.

Considered and deferred to a future spike:

- **Swap Traefik for ingress-nginx.** ingress-nginx is the more commonly seen ingress in real-world clusters (~70% market share). Traefik is fully capable and ships with k3s for free. The cost of the swap is one provision-script line (`--disable traefik`) plus a `helm install ingress-nginx`. We defer because postgres has no ingress need; the swap will be evaluated when the first ingress-bearing workload (the backend) lands in k3s.
- **Swap klipper for MetalLB.** klipper works perfectly for single-node; MetalLB is the standard for multi-node bare-metal. Defer until/unless we ever go multi-node.
- **Swap local-path for Longhorn / OpenEBS.** local-path is single-node and ties data to the VM's disk. Storage abstractions matter when we go multi-node; until then, local-path is honest and simple.

### Decision 5 — Manifests live in `infra/k8s/` with the canonical Kustomize base/overlay layout, Kustomize and Helm cooperate via the `helmCharts:` directive

`infra/k8s/` is structured as:

```
infra/k8s/
├── base/
│   ├── kustomization.yaml          (namespace: social; resources: ./postgres; common labels)
│   └── postgres/
│       ├── kustomization.yaml      (helmCharts: bitnami/postgresql with values.yaml)
│       ├── values.yaml             (chart values: image tag, persistence, pg_stat_statements, etc.)
│       ├── service-lb.yaml         (additional LoadBalancer Service for klipper-lb exposure)
│       └── secret.yaml             (plain Secret with local-dev credentials)
└── overlays/
    ├── local/
    │   └── kustomization.yaml      (resources: ../../base; local-specific patches)
    └── hetzner/
        └── kustomization.yaml      (resources: ../../base; placeholder — empty for now)
```

A single top-level `base/` is the canonical Kustomize layout used in the project documentation and most real-world clusters. The per-component nesting (`base/postgres/`) keeps each workload self-contained while still inheriting common metadata (namespace, labels) from the base `kustomization.yaml`.

Helm and Kustomize cooperate via Kustomize's `helmCharts:` directive (`--enable-helm` at apply time). This means **one verb** (`just k8s-apply` → `kustomize build --enable-helm overlays/local | kubectl apply -f -`) deploys both the Bitnami chart and the bespoke Service / Secret / etc. The `--enable-helm` flag is required and easy to forget; wrapping it in the `justfile` removes the footgun.

Rejected:

- **Per-component base+overlays** (`infra/k8s/postgres/{base,overlays}/`, `infra/k8s/backend/{base,overlays}/`, …). Cleaner per-component encapsulation; duplicated env config (namespace, image registry, common labels) across every component. The duplication-and-eventual-divergence cost outweighs the encapsulation benefit for a small set of services.
- **`helm template | kubectl apply`** (pre-rendering the chart, committing the rendered YAML, patching via Kustomize). Most auditable — every line of YAML is in git — but every chart upgrade requires a re-render and a big diff. The audit benefit does not justify the maintenance cost for a project where Helm charts will be used sparingly.
- **Helm and Kustomize run separately** (two CLIs, two state mechanisms). Simpler mental model, but losing the "one verb" property is a real ergonomic regression and complicates the eventual GitOps migration.

### Decision 6 — Bitnami `postgresql` Helm chart, not DIY manifests and not CloudNativePG

Three viable paths existed: hand-write the StatefulSet/Service/PVC/Secret manifests (DIY), use a packaged Helm chart (Bitnami), or install a postgres operator (CloudNativePG). We chose Bitnami for this slice with a deliberate plan to revisit.

- **DIY** maximizes learning of k8s primitives (StatefulSet, headless Service, `volumeClaimTemplate`, ordered pod lifecycle) and is the most "production-realistic" hand-built path. It is also the most boilerplate (~5 files, ~150 lines). The decision to defer is intentional: it is captured as a follow-up learning spike, "rewrite postgres as DIY Kustomize manifests" — the spike is meant to *replace* the Bitnami install once it exists, not to live alongside it. The reason to defer is that this slice's goal is "stand the cluster up and migrate one workload"; the DIY spike's goal is "internalize the StatefulSet pattern." Bundling them makes the slice fatter without making the cluster work better.
- **CloudNativePG (CNPG)** is the production-grade choice (operator-managed cluster as a CRD, built-in backup to S3-compatible storage, point-in-time recovery, rolling minor-version upgrades, failover with `Cluster` CRD `instances: 3`). It is the eventual destination for serious postgres. It is too much for slice 1 — installing the CNPG operator alone is a larger config surface than postgres itself today. It is captured as a follow-up: "migrate postgres to CNPG" once the rest of the k3s stack is stable.
- **Bitnami** is the right middle path for the slice: battle-tested, widely deployed, configured by `values.yaml`, gives a working postgres without inventing operational primitives. Bitnami's chart conventions (extensive parameterization, layered configs) feel heavy in places, but the heaviness is hidden behind the Helm install — `values.yaml` is the only file the project owns.

Chart pinning: pin chart version (`version: <explicit>` under `helmCharts:`), not channel. Pin image tag inside the chart values explicitly, not `latest`. Both pins live in `infra/k8s/base/postgres/kustomization.yaml` and `values.yaml`. Resolve exact versions at implementation time against the current Bitnami release.

`pg_stat_statements`: the slice-12 observability work depends on `shared_preload_libraries = pg_stat_statements` being loaded at postgres startup and on the `CREATE EXTENSION` SQL having been run once. Both are configurable via the Bitnami chart:

- `primary.extendedConfiguration` for the postgres.conf override.
- `primary.initdb.scripts` for the one-shot `CREATE EXTENSION` SQL.

The existing init SQL at `infra/observability/postgres/init/01-pg-stat-statements.sql` is preserved (file stays in place; chart values inline-reference its contents via `primary.initdb.scripts.01-pg-stat-statements.sql:`). A future cleanup may delete the standalone file once it is fully owned by the chart values.

### Decision 7 — Host `localhost:5432` reaches the cluster via a LoadBalancer Service + Lima `portForwards`

Three viable paths existed: `kubectl port-forward` from the host, expose the Service as `NodePort`, expose the Service as `LoadBalancer` (klipper-lb). The chosen path is LoadBalancer + Lima `portForwards`.

- **`kubectl port-forward svc/postgres 5432:5432`** is the most immediate (no Service shape needed beyond ClusterIP) but it is a foreground process that dies on terminal close, sleep / wake, VPN flap. Babysitting a port-forward is the worst kind of dev friction. Reserved for *Hetzner* port-forwarding (`just db-forward-hetzner`) where the path through kube-apiserver is the only path.
- **`NodePort`** requires picking a port in the `30000-32767` range, mapping it through Lima's `portForwards` to host `:5432`. Works fine, but exposes the "this is actually port 31234 inside the VM" abstraction to anyone reading the manifests, and is awkward when the next workload wants `:80` / `:443`.
- **`LoadBalancer` with klipper-lb** delivers what looks like a real LB IP on the VM's primary interface. Lima's `portForwards` block then maps the VM-side ports to host-side ports cleanly. Everything looks like real cluster networking, even on a laptop. The cost is one more Service object (the Bitnami chart's ClusterIP stays; we add a sibling LoadBalancer Service named `postgres-lb`) and one Lima config line per port.

The slice's Service shape:

- **Chart ClusterIP** (`postgresql.svc.cluster.local`, port 5432) — used by future in-cluster clients (backend pods once they land in k3s).
- **Hand-written `postgres-lb`** (LoadBalancer, port 5432) — used by host clients during the transition.

Lima `portForwards`: `{ guestPort: 5432, hostPort: 5432 }`. Once Lima is up and k3s is up, `localhost:5432` on macOS reaches the in-cluster postgres without any active process.

### Decision 8 — `social` namespace, plain Secret in `local/`, Hetzner secrets deferred

A single `social` namespace is declared at the base `kustomization.yaml` level (`namespace: social`). All slice-owned resources land in it. `kube-system`, `kube-public`, etc. are untouched. Future workloads (backend, frontend) can inherit by adding themselves to `base/<component>/`.

Namespace per tier (`social-data`, `social-app`, `social-obs`) was considered. The split is a real-world pattern when separate teams own separate tiers, when distinct RBAC / quota / NetworkPolicy boundaries are wanted, or when ingress / egress controls differ. None of those conditions hold here. One namespace today; split later if any of those conditions emerge.

For secrets, the postgres credential is committed as a plain Kubernetes `Secret` (base64-encoded `social/social`) in `base/postgres/secret.yaml`. The same credential lives in plaintext in `docker-compose.yml` today (since slice 0), so the slice does not increase the exposure surface. The Hetzner overlay (next slice) is where the *real* secrets decision lands. Three candidates are already framed:

- **Imperative secrets** — secrets never enter git; `kubectl create secret` reads from a password manager at deploy time. Strongest answer for "LLMs read my repo." Less GitOps-friendly. Lean.
- **SOPS + age** — encrypted-at-rest in git, decrypted at apply time. One tool, one pattern, works locally and on Hetzner. Acceptable.
- **Sealed Secrets** — controller in-cluster decrypts. Real-world pattern. Doubles secret files (per-cluster keys).

The slice does not choose between them. It only commits to "the Hetzner overlay will not reuse the local plain Secret."

### Decision 9 — `docker-compose`'s postgres is removed; `postgres-exporter` retargets at `host.docker.internal:5432`

The slice removes the `postgres` service definition from `docker-compose.yml`. The named volume `postgres-data` is preserved (the volume itself, not the bind mount), so the file's structural shape is unchanged and a future revert can put postgres back at-place.

The companion `postgres-exporter` service stays in compose. Its `DATA_SOURCE_URI` is retargeted from `postgres:5432/social?sslmode=disable` to `host.docker.internal:5432/social?sslmode=disable`. The Bitnami chart's bundled `metrics:` subchart (which would deploy a postgres-exporter sidecar in-cluster) is deliberately *not* enabled, because doing so would also require migrating Prometheus's scrape target out of docker-compose — and Prometheus's migration is a separate, larger slice. By keeping `postgres-exporter` in compose and pointing it at the new postgres location via the same `localhost:5432` route the backend uses, the observability loop continues to work with one config-line change.

Rejected:

- **Migrate `postgres-exporter` into k3s in this slice.** Right end-state; wrong slice. Requires also rethinking how Prometheus (still in compose) reaches an in-k3s exporter — kicking that decision to the dedicated observability-migration slice keeps boundaries clean.
- **Keep `postgres-exporter` AND keep a docker-compose `postgres`.** Two postgresqls fighting over `:5432`; ick.

### Decision 10 — `justfile` at repo root as the verb surface

The dev loop accumulates many "do the thing" commands quickly: `limactl start`, `limactl shell`, `kustomize build --enable-helm | kubectl apply`, `kubectl port-forward`, `kubectl logs`, `kubectl delete -k`, plus eventually variants for the Hetzner overlay. A `justfile` provides:

- A single `just --list` discovery point.
- Self-documenting recipe descriptions (the `# comment` above each recipe shows up in `--list`).
- Standard bash quoting (no Makefile tab-tyranny or recipe-prefix gotchas).
- A trivial wrapper for the `kustomize build --enable-helm` footgun.

The initial recipe set is small (~10 recipes) and grows as the project does. `just` itself is a single Rust binary, CC0 licensed, ~33k GitHub stars, and a sibling project of `ord` / Rust-toolchain norms — it is well past the maturity bar.

Rejected:

- **Plain shell scripts in `infra/scripts/`.** No single discovery surface; verbose call-sites.
- **`Makefile`.** Tab-vs-space syntax, recipe-prefix `@` quirks, overloaded "build system" connotations. Works, but worse DX than `just`.
- **`Taskfile`.** YAML-based, equally mature, slightly heavier syntax. Defensible alternative; the choice between `just` and `Taskfile` is taste, and `just` edges it for the slimmer mental model.

## Risks / Trade-offs

- **Single-node k3s has no HA.** The cluster is one VM, one node, one pod per workload. If the Lima VM crashes, postgres is unavailable until the VM restarts and the pod re-attaches its PVC. → Accepted as part of the production posture (Hetzner CAX21 is also single-node). The `add-cnpg` follow-up may add replica replication; HA is not goal-zero.
- **local-path storage means data lives on the VM disk only.** Volume snapshots are out of scope; backups happen by `pg_dump` if/when the developer wants them. → Same posture as the existing docker-compose `postgres-data` named volume. No regression. Backup story is captured in the Hetzner-deploy slice's design.
- **Lima's `arm64` VM on Apple Silicon is native; on Intel Macs it is QEMU-emulated and slow.** → Documented in the README. Intel Mac users may want to opt into an `amd64` lima.yaml variant (kept as an open question; only addressed if an Intel-Mac contributor needs it).
- **`docker-compose up postgres` no longer works.** Anyone pulling this branch onto an in-flight workspace must transition. → Documented in README and commit body; the named volume is preserved so the data is not lost; `git revert` restores the prior loop cleanly.
- **Bitnami chart pulls a fairly heavy image.** Bitnami's postgres image carries more tooling than `postgres:16-alpine`. → Image size matters for cold-cluster boot, not for steady state. Acceptable. DIY-spike or CNPG-migration follow-ups will swap.
- **`host.docker.internal:5432` is macOS Docker Desktop's host-loopback alias and works on Docker Desktop today.** Other engines (Colima, Podman Desktop) may resolve it differently. → Project standardizes on Docker Desktop for now; the retarget is one config knob and easy to revisit if a contributor uses another engine.
- **k3s's bundled Traefik is *not* a long-term commitment.** A future slice may rip it out. → Captured as a deliberate spike, not a hidden risk. Any workload that touches ingress (none in this slice) will weigh the swap explicitly.
- **`--enable-helm` is required for `kustomize build` and is easy to forget when running it by hand.** → `justfile` wraps it; documented in README; the recipe is the supported entry point.
- **The plain-Secret-in-git pattern *must not* be reused on the Hetzner overlay.** → Called out explicitly in the Hetzner placeholder `kustomization.yaml`'s comment.
- **A multi-component slice has more surfaces to get subtly wrong than a tight one.** → Mitigated by the explicit "first deploy = postgres only" scope; the next slices (backend, observability, Hetzner) each pick up exactly one logical chunk.

## Migration Plan

This is a breaking change to the local dev loop. Mitigation: a small README section describes the one-time switch.

**For the developer pulling this branch:**

1. `brew install lima just kubectl helm` (if missing).
2. `docker compose stop postgres` (the named volume `postgres-data` is preserved; no data loss for the prior compose setup).
3. `just vm-up` — Lima boots, provision script installs k3s, postgres pod starts.
4. `just k8s-apply` — Bitnami chart deploys postgres into the `social` namespace; LoadBalancer Service comes up; Lima `portForwards` plumbs `localhost:5432`.
5. `just psql` (or any local postgres client at `localhost:5432`) — connect to confirm.
6. Resume normal backend dev. The backend's `application.yaml` still points at `localhost:5432`; everything works unchanged.

**Migrating observability in this slice:**

1. Update `docker-compose.yml`: remove the `postgres` service, retarget `postgres-exporter`'s `DATA_SOURCE_URI` to `host.docker.internal:5432/social?sslmode=disable`, remove the init-script bind mount on the deleted service.
2. `docker compose --profile observability up -d` recreates `postgres-exporter` against the new target. Prometheus, Grafana, alerts unchanged.

**Rollback:**

1. `git revert <merge-commit>`.
2. `just vm-down` (optional — Lima VM may be kept for the next slice).
3. `docker compose up -d postgres` — the named volume `postgres-data` is intact; prior data persists.

**CI:**

- No CI changes in this slice. Existing CI continues to use `docker-compose --profile observability` for the observability tests; nothing references k3s.
- A future slice may add a CI job that brings up Lima + k3s, when the test surface is large enough to justify the runtime cost.

## Open Questions

- **k3s version pin.** Exact patch version chosen at implementation time. Lean: pin to `v1.31.x+k3s1` (stable channel as of slice authoring). Re-pin as part of the implementation PR if a newer stable cuts.
- **Bitnami chart version pin.** Decide at implementation. Lean: pin to the latest stable that bundles postgres 16.x.
- **`infra/observability/postgres/init/01-pg-stat-statements.sql` — keep the file or inline the SQL into chart values?** Lean: keep the file in place and inline-reference it via Helm values (`{{ .Files.Get "infra/observability/postgres/init/01-pg-stat-statements.sql" }}` is not Bitnami's pattern; the simpler approach is to inline the SQL directly in `values.yaml` under `primary.initdb.scripts`). Decide at implementation; the SQL is two lines.
- **Lima kubeconfig sync — `copyToHost` or rely on a `just` recipe to fetch?** Lima supports both. Lean: use the declarative `copyToHost` block in `lima.yaml`; the host `~/.kube/config` gets a `lima-social` context appended on every VM start. Confirm during implementation that the rewrite of `127.0.0.1:6443` → the Lima VM's host-mapped port works correctly.
- **Should `just k8s-apply` automatically wait for the postgres pod to become Ready before exiting?** Lean: yes — `kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=postgresql -n social --timeout=120s` after the apply. Avoids surprising "the apply succeeded but the pod is still pulling" race for first-time developers.
- **Intel-Mac story.** The `lima.yaml` is `arch: arm64`. Intel-Mac developers would need an `arch: amd64` variant or accept QEMU emulation. Lean: defer — add the variant only if an Intel-Mac contributor needs it.
- **Naming of the LoadBalancer Service.** `postgres-lb` is descriptive but breaks the Bitnami chart's naming convention. `postgresql-external` is also viable. Lean: `postgres-lb` for clarity. Decide at implementation.
- **`hetzner` overlay placeholder content.** Empty `kustomization.yaml` with a TODO comment, or a structured stub that lists the things the Hetzner slice will add (HetznerCloud LoadBalancer annotations, real Secret strategy, real PVC sizing, real resource requests / limits)? Lean: a structured stub commented out, so the next slice knows where to plug things in. Decide at implementation.
- **README "Local k3s cluster" depth.** Lean: short — one paragraph of context, the `just` verb table, the "if Lima is down" recovery section, and the explicit non-goals. The detailed design rationale stays in design.md.
- **`~/dotfiles/install.sh` additions.** Per global CLAUDE.md, `brew install lima` and `brew install just` should be added there idempotently. The dotfiles repo is out-of-tree; the change is recorded in the slice's commit body so the dotfiles edit is not lost.
- **Future spike: rewrite postgres as DIY Kustomize manifests.** Captured here so it is not lost. Goal: internalize StatefulSet, headless Service, volumeClaimTemplate, ordered pod lifecycle. The spike *replaces* the Bitnami install, not adds to it.
- **Future migration: CloudNativePG operator.** Captured here. Goal: production-grade postgres (backup to S3-compatible storage, PITR, rolling upgrades, optional HA). Sized as its own slice.
- **Future spike: swap Traefik for ingress-nginx.** Captured here. Trigger: first workload that needs an Ingress object (likely the backend in k3s, several slices away).
- **Future slice: Hetzner provisioning + Hetzner overlay.** The eventual deploy. This slice's `overlays/hetzner/` placeholder is the seed.
