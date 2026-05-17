# G5 — Postgres deepening

**Status:** planning · 2-slice arc
**Promotes to:** `openspec/changes/replace-postgres-bitnami-with-raw-manifests/` for the first slice; later slice gets its own change directory.

## Why

Postgres landed in slice 14 (`add-local-k3s-postgres`) via the Bitnami chart — fast to install, opinionated defaults, hides the k8s primitives behind chart values. README's "Future spikes" section calls out two explicit follow-ups against this baseline:

> **DIY postgres as Kustomize manifests.** Replace the Bitnami chart install with hand-written StatefulSet / headless Service / volumeClaimTemplate / PodDisruptionBudget / Secret. Goal: internalise the k8s primitives. The spike *replaces* the Bitnami install rather than running alongside it.

> **CloudNativePG migration.** Move postgres to the CNPG operator for production-grade backup-to-S3, point-in-time recovery, rolling minor-version upgrades, and optional `instances: 3` HA. Sized as its own slice.

Both are real production trajectories — most teams run on a managed Postgres (RDS, Cloud SQL) or a real operator (CNPG, Zalando, Crunchy). Neither runs Bitnami in prod. Doing both *locally* — DIY first to learn the primitives, then CNPG to learn the operator surface — internalises the layers that today are invisible inside a chart.

## Slices in this group

```
G5.1  replace-postgres-bitnami-with-raw-manifests   the DIY spike
G5.2  add-cnpg-postgres                             operator migration
```

G5.1 first. G5.2 builds on the lessons but doesn't strictly require G5.1 — they could swap order. Recommendation: DIY first; doing CNPG without first hand-writing the primitives means CNPG abstracts away things you never saw.

## Slice sketches

### G5.1 — `replace-postgres-bitnami-with-raw-manifests`

**The artifact set:** hand-written kustomize manifests for postgres, replacing the entire Bitnami chart install. Live under `infra/k8s/base/postgres-raw/` (don't overwrite `infra/k8s/base/postgres/` until the new path is green — keep both in tree during the slice, delete the chart wiring at the end).

- **StatefulSet** with one replica:
  - `serviceName:` pointing at the headless Service (mandatory for stable pod DNS).
  - `volumeClaimTemplates:` — each replica gets its own PVC, named `<sts-name>-<replica>`. Local storage class is `local-path` (k3s default).
  - Container: official `postgres:16-alpine` image (slice 14 was on Bitnami's `bitnamilegacy/postgresql` — also relevant: project memory `project_bitnami_image_migration.md` flags the legacy registry workaround).
  - `securityContext`: `runAsNonRoot: true`, `runAsUser: 999` (the official image's postgres uid), `fsGroup: 999`. Forces fix of any G3.1 PSS-restricted violation in the same slice.
  - Probes: `livenessProbe` running `pg_isready -U postgres`; `readinessProbe` same; `startupProbe` allows ~30s for first init.
  - Resource requests/limits unchanged from the chart's local defaults.
- **Headless Service** (`clusterIP: None`) named `postgres-headless` — gives stable per-pod DNS (`postgres-0.postgres-headless.social.svc.cluster.local`).
- **ClusterIP Service** named `postgres` for clients that don't need stable per-pod DNS (the BE Deployment connects via this).
- **PodDisruptionBudget** with `minAvailable: 1`.
- **Secret** for `postgres` superuser + `social` app user passwords. Continue to use the local-dev `social.io/credential-scope: local-dev` label.
- **Init**: drop the chart's init container; use an explicit init container (or `initdb` post-start) that runs `infra/k8s/base/postgres/init/01-pg-stat-statements.sql` (relocated in slice 22b). The file gets re-mounted via a `configMapGenerator` in kustomization.
- **PostgreSQL config**: a configmap with `postgresql.conf` overrides (shared_buffers, max_connections, log_min_duration_statement) mounted via `--config-file`. Local-dev values; production overrides happen at the (deferred) Hetzner overlay.

**Migration approach within the slice:**
1. Land `infra/k8s/base/postgres-raw/` alongside the existing chart wiring under `infra/k8s/base/postgres/`. Both unreferenced at first.
2. Local overlay: point the `social` namespace's `kustomization.yaml` at `postgres-raw/` instead of `postgres/`. Apply.
3. Migrate PVC contents: simplest path is *nothing* — local-dev postgres state is throwaway; document that the slice intentionally drops the chart's data and accept it. Alternative (if rejected): `pg_dump` from the chart pod before swap, `psql` into the raw pod after. **Recommend dropping the data** — keeps the slice's complexity low.
4. Once raw is green, delete `infra/k8s/base/postgres/` (the chart install) entirely.
5. Update justfile, README, any e2e fixtures referencing the chart Service name (likely the Service name stays `postgres` to minimise diff).

**Verification:**
- Backend connects, `select 1` works.
- `pg_stat_statements` extension loaded; the slice-12 db-observability dashboard still has data.
- PDB visibly blocks `kubectl drain` (verified by G2.2 if it's landed).
- e2e suite green end-to-end.

### G5.2 — `add-cnpg-postgres`

- Install the CloudNativePG operator into a dedicated `cnpg-system` namespace via the operator's published manifest (pinned version).
- Replace `postgres-raw/` with a `Cluster` CRD declaration (`cnpg.io/v1`):
  - `instances: 1` for local (toy-scale; HA is a `instances: 3` change later).
  - `storage.size: 10Gi`, `storage.storageClass: local-path`.
  - `imageName: ghcr.io/cloudnative-pg/postgresql:16-bullseye` (or pin to the operator's recommended image).
  - `bootstrap.initdb` block: creates the `social` database, the `social` app user, grants, and a `postgres_initialization_sql:` running `pg_stat_statements` setup.
  - `monitoring.enablePodMonitor: true` — CNPG ships a Prometheus PodMonitor; surfaces operator-shaped Postgres metrics into obs prometheus. (Slice 22a's hand-rolled postgres-exporter Deployment becomes redundant; the slice deletes it.)
- **Exercise the operator's real differentiators locally** — this is the learning intent, not just a swap:
  - **Backup to S3.** Use a local MinIO Deployment as an S3 target (one-pod chart-free install). Configure CNPG `backup.barmanObjectStore` against it. Run `kubectl cnpg backup <cluster>` and verify backup objects land in MinIO.
  - **Point-in-time recovery.** Restore the cluster to a timestamp before a deliberately destructive `DROP TABLE` issued in a test. CNPG's `Cluster` CRD has a `bootstrap.recovery` block that points at a backup + a target time.
  - **Rolling minor-version upgrade.** Bump `imageName` minor; observe the operator's rolling restart sequence.
- Operator metrics: CNPG exposes operator-level metrics on `:8080/metrics`; add a scrape target on the obs prom (operator metrics live in the app cluster; cross-cluster scrape lands through the existing app-collector → obs-collector → obs-prom fan-out).
- Backend's Postgres connection string: the CNPG `Cluster` produces a `<cluster>-rw` Service for the primary (and `<cluster>-r` for replicas, `-ro` for read-only); BE swaps from `postgres` → `<cluster>-rw`.

**Open questions for G5.2:**
- Operator install method: bundled YAML, Helm chart, or OLM? Recommendation: published YAML, pinned version (matches the project's "explicit pinning, no operator surface" stance from slice 17).
- Pin the operator version where? `infra/k8s/base/cnpg-operator/` as a kustomize base. Document the upgrade discipline (read the operator's release notes; verify the `Cluster` API version still works).
- Does the Bitnami `postgres-exporter` (slice 22a) get deleted or kept? **Delete**: CNPG's PodMonitor produces a superset of the same series, and the exporter Deployment was hand-wired around the chart's missing Prometheus integration — that gap is closed by the operator.

## Non-goals

- **No HA in G5.2's first cut.** `instances: 1` for local; the `instances: 3` change is a follow-up if/when multi-node (G2) is in place. Single-node Lima won't schedule 3 replicas anyway.
- **No Patroni / Zalando / Stackgres comparison.** CNPG is the pick; a comparison spike isn't worth the time.
- **No prod backup target.** MinIO is the local S3 stand-in; real S3 (Hetzner Object Storage, AWS S3, Backblaze B2) is a Hetzner-slice concern.
- **No DDL migrations framework in this group.** Flyway/Liquibase choice is a backend slice, not a Postgres-deploy slice.

## Sequencing

```
G5.1 ──→ G5.2
```

G5.2 can technically land without G5.1 (replace Bitnami chart directly with CNPG), but the learning value drops — CNPG abstracts the same primitives G5.1 would have made you write by hand. Recommendation: keep the order.

G5.2 benefits from G2.1 (multi-node) only if you also want to bump to `instances: 3` to exercise HA; otherwise multi-node is orthogonal.

## Risk

- **G5.1 drops local Postgres data** (under the recommended approach). Acceptable for local-dev; document the data-drop in the slice's README addendum.
- **G5.2's CNPG operator is a CRD-bearing dependency** — first slice in the project to install a third-party operator. Adds upgrade discipline (operator releases tied to PG-version compatibility matrices). Pin explicitly; document the upgrade procedure as part of the slice.
- **Bitnami → official image cutover (G5.1).** `postgres:16-alpine` runs as uid 999 by default; Bitnami's chart used uid 1001. PVC ownership migration is the failure mode if data is preserved; since G5.1's recommended approach drops data, the issue evaporates.

## Size estimate

- G5.1: 2–3 evenings (the StatefulSet/headless/PDB/Secret/configmap assembly + the BE connection verification).
- G5.2: 3–4 evenings (operator install + Cluster CRD + MinIO + backup verification + PITR drill).

Total: ~1 week of evenings.
