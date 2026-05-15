## 1. Lima VM definition

- [x] 1.1 Create `infra/lima/lima.yaml` declaring the VM shape (`arch: aarch64`, `cpus: 4`, `memory: "8GiB"`, `disk: "64GiB"`, Ubuntu 24.04 LTS image). Pin the image identifier explicitly (no `release: latest`).
- [x] 1.2 Add a `portForwards:` block mapping `guestPort: 5432` → `hostPort: 5432`. Add a comment naming the workload that owns the port (postgres). Reserve the syntax so additional forwards (kube-apiserver, future backend, future ingress) can be appended without churn.
- [x] 1.3 Add a `copyToHost:` block (or equivalent `provision:` step) that surfaces the k3s kubeconfig on the macOS host. Confirm the rewrite of `https://127.0.0.1:6443` lands at a host-side port that does NOT conflict with anything in `~/.kube/config`. Document the chosen context name (e.g. `lima-social`) in a header comment.
- [x] 1.4 Wire a `provision:` block that invokes `infra/provisioning/install-k3s.sh` on first boot. Do not duplicate any k3s install logic inline.
- [x] 1.5 Verify locally: on a fresh checkout, `limactl start infra/lima/lima.yaml` boots the VM end-to-end, the provision script runs once, `lima shell <name> -- kubectl get nodes` reports one Ready node, and macOS `kubectl --context <name> get nodes` reports the same one Ready node. <!-- exercised end-to-end on 2026-05-15: `just vm-up` brought up Lima 2.1.1 with k3s v1.31.7+k3s1, `kubectl get nodes` reports `lima-lima-social Ready control-plane,master` from both inside the VM and from the host kubeconfig at `~/.lima/lima-social/copied-from-guest/kubeconfig.yaml` -->

## 2. k3s install script

- [x] 2.1 Create `infra/provisioning/install-k3s.sh`. Make it POSIX shell (or `#!/usr/bin/env bash` if any bashism is needed — match the project's existing script conventions). Set `set -euo pipefail` (or POSIX-equivalent) at the top.
- [x] 2.2 Pin the k3s version at the top of the script in a clearly editable form: `INSTALL_K3S_VERSION="v1.31.x+k3s1"` (resolve `x` to the current patch at implementation time). Document the pin's rationale in a header comment.
- [x] 2.3 Implement the install body using the official one-liner pattern (`curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$INSTALL_K3S_VERSION" sh -`). Do NOT pass `--disable traefik`, `--disable servicelb`, or `--disable local-storage` — keep bundled defaults.
- [x] 2.4 Make the script idempotent: detect an existing pinned-version k3s install and exit early without re-running. Detect `command -v k3s` AND match the running version before treating as "already installed."
- [x] 2.5 Audit the script for any Lima-specific or Hetzner-specific identifiers (`limactl`, `LIMA_`, `hcloud`, etc.). Confirm the script is host-agnostic.
- [x] 2.6 Verify the script runs cleanly when invoked twice in a row inside the Lima VM (`lima shell <name> -- sudo bash /tmp/install-k3s.sh` from the host — exact path depends on the `provision:` integration). <!-- exercised end-to-end on 2026-05-15: the idempotency guard at the top of install-k3s.sh fires when `command -v k3s` succeeds and the running version matches `INSTALL_K3S_VERSION`. Provision ran once on first boot; a second `just vm-up` (after `vm-down`) is a no-op for the install. -->

## 3. Kustomize layout

- [x] 3.1 Create `infra/k8s/base/kustomization.yaml` declaring `namespace: social` and listing `./postgres` under `resources:`. Add a header comment naming the convention (single namespace, components nested under `base/`).
- [x] 3.2 Create the `infra/k8s/overlays/local/kustomization.yaml` declaring `../../base` as the resource and providing the local-specific patches the slice settled on (PVC size, resource caps if they differ from base).
- [x] 3.3 Create the `infra/k8s/overlays/hetzner/kustomization.yaml` placeholder declaring `../../base` and containing a clearly marked TODO comment naming the things the next slice will add (Hetzner-specific Secret strategy, LoadBalancer annotations, persistence sizing, resource requests/limits). The placeholder MUST NOT reuse the local plain Secret on the Hetzner overlay path.
- [x] 3.4 Verify `kustomize build --enable-helm infra/k8s/overlays/local` renders cleanly to stdout with no errors (after tasks 4 and 5 land the Helm chart bits).

## 4. Postgres via Bitnami Helm chart

- [x] 4.1 Create `infra/k8s/base/postgres/kustomization.yaml` declaring a `helmCharts:` entry: `name: postgresql`, `repo: https://charts.bitnami.com/bitnami`, `version: <pinned>` (resolve at implementation time), `releaseName: postgres`, `namespace: social`, `valuesFile: values.yaml`. List `./service-lb.yaml` and `./secret.yaml` under `resources:`.
- [x] 4.2 Create `infra/k8s/base/postgres/values.yaml` setting:
  - `image.tag: 16.x.y-debian-12-r0` (pin the explicit `16.x` Bitnami tag at implementation time; never `latest`).
  - `auth.username: social`, `auth.database: social`, `auth.existingSecret: postgres-credentials` (reference the Secret committed in task 4.4).
  - `primary.extendedConfiguration: |\n  shared_preload_libraries = 'pg_stat_statements'`
  - `primary.initdb.scripts.01-pg-stat-statements.sql: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"` (inline the SQL; the standalone file at `infra/observability/postgres/init/` is left in place for slice-12 audit traceability and may be removed in a follow-up).
  - `primary.persistence.size: 5Gi`, `primary.persistence.storageClass: local-path`.
  - `primary.resources.requests.memory: 256Mi`, `requests.cpu: 250m`, `limits.memory: 1Gi`, `limits.cpu: 2000m` (match the docker-compose ceiling).
  - `metrics.enabled: false` (the in-compose `postgres-exporter` still does the scraping; the Bitnami exporter sidecar is a future slice).
- [x] 4.3 Create `infra/k8s/base/postgres/service-lb.yaml` declaring a Kubernetes `Service` named `postgres-lb` (or the name settled at implementation time) of type `LoadBalancer`, selecting the Bitnami chart's primary-pod labels (`app.kubernetes.io/name=postgresql`, `app.kubernetes.io/instance=postgres`, `app.kubernetes.io/component=primary` — resolve exact labels against the chart's rendered output during implementation), exposing port `5432/TCP`.
- [x] 4.4 Create `infra/k8s/base/postgres/secret.yaml` declaring a Kubernetes `Secret` named `postgres-credentials` containing the local-dev password (base64-encoded `social`). Add a comment / label / annotation noting it is a local-dev credential and SHALL NOT be reused on Hetzner.
- [x] 4.5 Render the slice end-to-end: `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply --dry-run=client -f -` succeeds, all manifests are in the `social` namespace, the Secret is named `postgres-credentials`, the LoadBalancer Service is named `postgres-lb` and selects the chart's primary pod. <!-- statically validated: render produces Namespace+ServiceAccount+ConfigMaps+Secret+3 Services (headless, ClusterIP, postgres-lb LoadBalancer)+NetworkPolicy+PodDisruptionBudget+StatefulSet, all in namespace=social; postgres-lb selector matches the Bitnami primary labels; kubectl apply --dry-run=client requires a live apiserver to fetch OpenAPI and is therefore part of task 5 -->

## 5. Apply, verify, and prove the loop

- [x] 5.1 `just vm-up` (after task 6 lands the justfile) boots Lima and waits for the cluster to be Ready. <!-- exercised end-to-end on 2026-05-15: `just vm-up` finishes with "READY. Run `limactl shell lima-social` to open the shell." in ~90 s after a one-time Ubuntu image download. -->
- [x] 5.2 `just k8s-apply` renders and applies the local overlay. Wait for the postgres pod to reach `Ready` (`kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=postgresql -n social --timeout=120s`). <!-- exercised 2026-05-15: the recipe sleeps 5 s before kubectl-wait (StatefulSet-pod-spawn race) and then runs CREATE EXTENSION via kubectl exec as a belt-and-braces step (chart 15.5.38 initdb-scripts loop bug — see values.yaml comment); both finish clean. -->
- [x] 5.3 Verify `kubectl get svc -n social postgres-lb` shows an `EXTERNAL-IP` assigned by klipper-lb and `5432:5432/TCP` in PORTS. <!-- exercised 2026-05-15: `EXTERNAL-IP=192.168.5.15`, `PORT(S)=5432:30929/TCP` — klipper assigns the VM's primary IP and a random NodePort, and Lima portForwards plumbs guest :5432 to host :5432. -->
- [x] 5.4 Verify from the macOS host: `psql postgres://social:social@localhost:5432/social -c 'SELECT 1'` returns `1`. <!-- exercised 2026-05-15: returns `1`. -->
- [x] 5.5 Verify `pg_stat_statements` is active: `psql postgres://social:social@localhost:5432/social -c "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements'"` returns one row. <!-- exercised 2026-05-15: returns one row. Note: extension creation comes from the `kubectl exec CREATE EXTENSION` step in `just k8s-apply`, not from the chart's initdb-scripts loop (which silently skips the .sql file in 15.5.38). -->
- [x] 5.6 Verify the backend still works end-to-end against the new postgres: start the backend on host, run the existing backend smoke / integration tests that exercise the database, confirm they pass without code change. <!-- exercised 2026-05-15: `./gradlew :backend:bootRun` connected to `jdbc:postgresql://localhost:5432/social (PostgreSQL 16.6)`; Flyway ran all 5 migrations against the empty schema; `curl /actuator/health → UP`; signup POST returned 201; `SELECT email,display_name FROM users WHERE email='smoke@k3s.test'` confirmed the row landed; login POST returned 200. End-to-end read + write via Hikari + JPA + Flyway proven. No backend code change. -->

## 6. justfile at repo root

- [x] 6.1 Create `justfile` at the repository root. Add a `default` recipe that runs `@just --list`.
- [x] 6.2 Implement `vm-up`: `limactl start infra/lima/lima.yaml` (or `limactl start --name=<chosen-name>` if a name override is preferred). Block on the VM reaching Ready.
- [x] 6.3 Implement `vm-down`: `limactl stop <name>`. Do NOT auto-delete the VM.
- [x] 6.4 Implement `vm-shell`: `limactl shell <name>` (drops the developer into the VM's shell).
- [x] 6.5 Implement `k8s-apply`: `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -`. After applying, `kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=postgresql -n social --timeout=120s`.
- [x] 6.6 Implement `k8s-diff`: `kustomize build --enable-helm infra/k8s/overlays/local | kubectl diff -f -` (acceptable for the diff exit code to be non-zero when changes exist).
- [x] 6.7 Implement `k8s-delete`: `kustomize build --enable-helm infra/k8s/overlays/local | kubectl delete -f -`.
- [x] 6.8 Implement `psql`: shorthand for `psql postgres://social:social@localhost:5432/social`. Document in the recipe comment that the host machine needs the `psql` client (`brew install libpq` or similar).
- [x] 6.9 Implement `db-forward-hetzner` as a placeholder that prints a TODO message naming the next slice. Do not invoke `kubectl port-forward` against any cluster.
- [x] 6.10 Add a header comment at the top of `justfile` linking to the README's "Local k3s cluster" section.
- [x] 6.11 Run `just --list` and confirm every recipe shows up with its description. <!-- exercised 2026-05-15: `default`, `vm-up`, `vm-down`, `vm-shell`, `k8s-apply`, `k8s-diff`, `k8s-delete`, `psql`, `db-forward-hetzner` — all 9 listed. Descriptions are slightly truncated by just's "last comment line" convention; cosmetic, not blocking. -->

## 7. docker-compose migration

- [x] 7.1 In `docker-compose.yml`, remove the `postgres` service block in its entirety. Preserve the top-level `volumes.postgres-data` declaration; add a comment noting that it is no longer mounted by any service but is retained so a `git revert` of this slice restores the prior compose definition cleanly.
- [x] 7.2 Update the `postgres-exporter` service's `DATA_SOURCE_URI` from `postgres:5432/social?sslmode=disable` to `host.docker.internal:5432/social?sslmode=disable`. Remove `depends_on: postgres` (the dependency target no longer exists).
- [x] 7.3 Update the file's top-of-file comment to document that the dev postgres now lives in k3s, with a pointer at `infra/k8s/base/postgres/`.
- [x] 7.4 Verify `docker compose config --quiet` parses cleanly.
- [x] 7.5 Verify the observability profile still works end-to-end: `just vm-up && just k8s-apply` (postgres-in-k3s) + `docker compose --profile observability up -d`; then hit `http://localhost:9187/metrics` and confirm it contains `pg_stat_database_*` series populated with non-zero values (proving the exporter reached the in-k3s postgres via `host.docker.internal:5432`). <!-- exercised 2026-05-15: `pg_stat_database_numbackends{datname="social"}=3`, `pg_stat_database_xact_commit{datname="social"}=395` (non-zero, real signal). Required granting `pg_read_all_stats` to the `social` role — the Bitnami chart creates `social` as a non-superuser, unlike the old `postgres:16-alpine` compose image that made it a superuser. Without the grant, `pg_stat_statements` rows the non-superuser can't see collapse to `queryid=""` and the exporter emits duplicate-label-set errors. The GRANT is baked into `just k8s-apply` (idempotent kubectl exec). -->
- [x] 7.6 Spot-check Prometheus targets at `http://localhost:9090/targets` — the `postgres-exporter` job should be `up`. Spot-check a panel on the slice-12 Database overview dashboard renders real data. <!-- exercised 2026-05-15: Prometheus API `/api/v1/targets` reports `postgres-exporter → up | <no error>`. Grafana `/api/datasources/proxy/uid/prometheus/api/v1/query?query=pg_stat_database_numbackends` returns 4 series (template0/template1/postgres/social), confirming the Database overview dashboard's panels render real data. -->

## 8. README and global dotfiles

- [x] 8.1 Add a "Local k3s cluster" section to `README.md`. Cover (in order): one-paragraph rationale, brew prerequisites (`brew install lima just kubectl helm`), the `just` verb table with one-line descriptions, the postgres-via-k3s dev loop (start → connect → stop), an "If Lima is down" recovery paragraph (`just vm-up` again), the explicit non-goals (backend / frontend / observability still on host or compose), the captured future spikes (DIY postgres rewrite, CNPG migration, ingress-nginx swap, Hetzner deploy).
- [x] 8.2 Update the "Local observability" section to note the `postgres-exporter` retarget. One sentence; pointer back to the new section.
- [x] 8.3 Append `brew install lima` and `brew install just` (each guarded by `command -v`) to `~/dotfiles/install.sh` per the global CLAUDE.md guard. Record this edit in the slice's commit body since the dotfiles repo is out-of-tree.

## 9. Validate and ship

- [x] 9.1 Run `openspec validate add-local-k3s-postgres --strict` and resolve any findings.
- [x] 9.2 On a fresh laptop checkout, exercise the full happy-path: `brew install lima just kubectl helm` → `just vm-up` → `just k8s-apply` → `just psql` → SELECT 1 succeeds. Tear down: `just k8s-delete` → `just vm-down`. Confirm idempotent re-up (`just vm-up && just k8s-apply` from a stopped state finishes without errors). <!-- exercised 2026-05-15: full happy-path runs clean. Idempotency confirmed by wiping the PVC and re-running `just k8s-apply` — converges in one pass including the post-Ready `CREATE EXTENSION`. -->
- [x] 9.3 Confirm the existing backend test suite passes against the new postgres location with no application-side code change. If any test changed, document why. <!-- CI pass 2026-05-15 (PR #43) ran `./gradlew test` in the `backend` shard, all green. The backend test suite uses Testcontainers — it spins up an ephemeral postgres per-test and is therefore independent of the dev cluster. The "no application-side code change" property holds: zero files under `backend/` changed in this slice. -->
- [x] 9.4 Commit on a branch named `add-local-k3s-postgres`, open the PR with the proposal/design/specs/tasks summary, and follow the autonomous-apply workflow through CI to archive. <!-- done 2026-05-15: PR #43 (https://github.com/igor-mircic/prod-ready-social-media-v2/pull/43) on branch `add-local-k3s-postgres`. All 6 CI checks green on the archive-commit run. Pre-merge state. -->
