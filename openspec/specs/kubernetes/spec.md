# kubernetes Specification

## Purpose
TBD - created by archiving change add-local-k3s-postgres. Update Purpose after archive.
## Requirements
### Requirement: A Lima VM definition lives in `infra/lima/lima.yaml`

The repository SHALL contain a declarative Lima VM definition at `infra/lima/lima.yaml` describing a single-node Linux VM whose shape matches the eventual Hetzner CAX21 deploy target (4 vCPU, 8 GiB RAM, 64 GiB disk, arm64, Ubuntu 24.04 LTS). The VM definition SHALL be committed to git as the source of truth for the local cluster's hardware shape.

#### Scenario: Lima YAML declares the target shape
- **WHEN** a reader inspects `infra/lima/lima.yaml`
- **THEN** the file declares `arch: aarch64` (or the Lima-canonical equivalent for arm64)
- **AND** the file declares `cpus: 4`
- **AND** the file declares `memory: "8GiB"` (or the Lima-canonical equivalent)
- **AND** the file declares a disk size of at least `64GiB`
- **AND** the file declares an Ubuntu 24.04 LTS image

#### Scenario: Lima YAML declares the port-forwarding rule for postgres
- **WHEN** a reader inspects the `portForwards:` block in `infra/lima/lima.yaml`
- **THEN** the block contains an entry mapping `guestPort: 5432` to `hostPort: 5432`
- **AND** no other port-forward entry shadows or conflicts with that mapping

#### Scenario: Lima YAML wires the kubeconfig to the host
- **WHEN** a reader inspects `infra/lima/lima.yaml`
- **THEN** the file declares a mechanism (either `copyToHost:` block or `provision:` step) that surfaces the k3s kubeconfig on the macOS host with a context name that does not collide with existing entries in `~/.kube/config`
- **AND** the host-facing kubeconfig points at the host-side port that the `portForwards:` block maps to the in-VM kube-apiserver port

#### Scenario: Lima YAML invokes the shared provision script on first boot
- **WHEN** a reader inspects the `provision:` block in `infra/lima/lima.yaml`
- **THEN** the block invokes `infra/provisioning/install-k3s.sh` (either by inline source-and-execute or by mounting and running it)
- **AND** no k3s install logic is duplicated inline inside `lima.yaml` itself (the provision script remains the single source of truth)

### Requirement: A shared k3s install script lives at `infra/provisioning/install-k3s.sh`

The repository SHALL contain a POSIX shell script at `infra/provisioning/install-k3s.sh` that installs k3s on a fresh Ubuntu 24.04 host. The same script SHALL be usable by Lima's `provision:` block (local development) and by a future Hetzner cloud-init userdata invocation; it MUST NOT contain Lima-specific or Hetzner-specific branching that would prevent either reuse.

#### Scenario: Script pins k3s version explicitly
- **WHEN** a reader inspects `infra/provisioning/install-k3s.sh`
- **THEN** the script sets `INSTALL_K3S_VERSION` to an explicit version string (`v1.<minor>.<patch>+k3s<release>`)
- **AND** the script does not use the `latest` channel
- **AND** the version string appears at the top of the script in a clearly editable form

#### Scenario: Script keeps k3s defaults (Traefik, klipper, local-path, metrics-server)
- **WHEN** a reader inspects the k3s install invocation in `infra/provisioning/install-k3s.sh`
- **THEN** the script does NOT pass any `--disable traefik`, `--disable servicelb`, or `--disable local-storage` flag (the bundled components stay enabled)
- **AND** a comment near the install line documents that the bundled defaults are the deliberate choice for this slice

#### Scenario: Script is idempotent
- **WHEN** the script runs on a host that already has k3s installed at the pinned version
- **THEN** the script either exits early (after detecting the existing install) or completes without changing the running k3s installation

#### Scenario: Script is host-agnostic
- **WHEN** a reader greps the script for Lima-specific or Hetzner-specific identifiers
- **THEN** no occurrence of `limactl`, `lima_`, `LIMA_`, `hcloud`, or similar appears in the script body

### Requirement: A single-node k3s cluster runs inside the Lima VM

Running `limactl start infra/lima/lima.yaml` on a fresh host SHALL produce a working single-node k3s cluster reachable from macOS via `kubectl` using the host-side kubeconfig context the slice declares.

#### Scenario: kubectl from the host reports a Ready node
- **WHEN** an operator has run `limactl start` and the VM has finished booting
- **AND** the operator switches to the slice's kubeconfig context
- **AND** the operator runs `kubectl get nodes`
- **THEN** exactly one node is listed with `STATUS: Ready`
- **AND** the node's `ROLES` includes `control-plane` (k3s server role)

#### Scenario: Bundled k3s components are healthy
- **WHEN** the cluster has reached steady state
- **AND** the operator runs `kubectl -n kube-system get deploy,daemonset`
- **THEN** Traefik, klipper-lb (`svclb-*`), local-path-provisioner, and metrics-server are present
- **AND** each reports Available / Ready

### Requirement: Kustomize and Helm cooperate via `helmCharts:` to deploy postgres

The repository SHALL deploy postgres into the cluster via the Bitnami `postgresql` Helm chart, with the chart declared inside a Kustomize `kustomization.yaml` under the `helmCharts:` directive (rendered with `kustomize build --enable-helm`). The chart version SHALL be pinned to an explicit release (not a channel and not `latest`).

#### Scenario: Postgres base declares the Bitnami chart with a pinned version
- **WHEN** a reader inspects `infra/k8s/base/postgres/kustomization.yaml`
- **THEN** the file declares a `helmCharts:` entry naming `postgresql` from the Bitnami chart repository
- **AND** the entry's `version` field is an explicit version string
- **AND** the entry's `valuesFile` (or inline `valuesInline:`) references `infra/k8s/base/postgres/values.yaml`

#### Scenario: Chart values pin the postgres image tag
- **WHEN** a reader inspects `infra/k8s/base/postgres/values.yaml`
- **THEN** the values set `image.tag` (or the chart-equivalent path) to an explicit `16.x` tag
- **AND** no field is set to `latest`

#### Scenario: Chart values preserve `pg_stat_statements`
- **WHEN** a reader inspects `infra/k8s/base/postgres/values.yaml`
- **THEN** the values set `primary.extendedConfiguration` (or the chart-equivalent path) to a string containing `shared_preload_libraries = 'pg_stat_statements'`
- **AND** the values declare a `primary.initdb.scripts` entry that runs `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`

#### Scenario: Chart values preserve the docker-compose credentials and database name
- **WHEN** a reader inspects `infra/k8s/base/postgres/values.yaml`
- **THEN** the values declare a database named `social`
- **AND** the values declare a user named `social`
- **AND** the values reference an existing Kubernetes Secret (not an inline `password:` field) for the credential, by Secret name

#### Scenario: A plain Secret is committed for local development
- **WHEN** a reader inspects `infra/k8s/base/postgres/secret.yaml`
- **THEN** the file declares a Kubernetes `Secret` whose name matches the `existingSecret` reference in the chart values
- **AND** the Secret contains the local-development password (base64-encoded `social`)
- **AND** the Secret's metadata documents (via comment, label, or annotation) that it is a local-development credential and SHALL NOT be reused on Hetzner

### Requirement: All slice resources live in the `social` namespace

A single Kubernetes namespace named `social` SHALL hold every resource the cluster's tier-1 workloads deploy (postgres workload, Service, Secret, backend workload, frontend workload). The namespace SHALL be declared at the base `kustomization.yaml` level so every component inherits it.

#### Scenario: Base kustomization declares the namespace and lists every component
- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the file declares `namespace: social`
- **AND** the file lists `./postgres` under `resources:`
- **AND** the file lists `./backend` under `resources:`
- **AND** the file lists `./frontend` under `resources:`

#### Scenario: All slice resources land in the social namespace
- **WHEN** the slice has been applied via `just k8s-apply`, `just backend-apply`, and `just frontend-apply`
- **AND** an operator runs `kubectl get all -n social`
- **THEN** the postgres StatefulSet, Service(s), Secret, PVC, the backend Deployment + ReplicaSet + Pod + Service, and the frontend Deployment + ReplicaSet + Pod + Service are listed
- **AND** `kubectl get all -n default` shows no slice-owned resources

### Requirement: Postgres is reachable from the macOS host on `localhost:5432`

The slice SHALL expose the in-cluster postgres on the macOS host's `localhost:5432` via a `LoadBalancer`-type Service plus a Lima `portForwards` entry, so the existing backend, IDE, `psql`, and observability `postgres-exporter` see no transport change.

#### Scenario: A LoadBalancer Service exposes postgres in the VM
- **WHEN** a reader inspects `infra/k8s/base/postgres/service-lb.yaml`
- **THEN** the file declares a Kubernetes `Service` of type `LoadBalancer`
- **AND** the Service selects the Bitnami chart's postgres pod (by the chart's primary-pod selector labels)
- **AND** the Service exposes port `5432` (TCP)

#### Scenario: klipper-lb assigns an external IP on the VM's network
- **WHEN** the slice has been applied
- **AND** an operator runs `kubectl get svc -n social postgres-lb` (or the chosen Service name)
- **THEN** the Service reports an `EXTERNAL-IP` value (assigned by klipper-lb) that is the VM's primary network address
- **AND** the Service reports `5432:5432/TCP` in the `PORT(S)` column

#### Scenario: macOS localhost:5432 reaches the in-cluster postgres
- **WHEN** an operator has run `just vm-up && just k8s-apply` on a fresh host
- **AND** the operator runs `psql postgres://social:social@localhost:5432/social -c 'SELECT 1'`
- **THEN** the connection succeeds and returns `1`

### Requirement: A `justfile` at the repository root drives the local cluster lifecycle

The repository SHALL contain a `justfile` at the repo root declaring recipes for the daily-dev verbs the local cluster requires. The recipe surface SHALL include VM lifecycle, manifest apply/diff/delete, and a local `psql` shortcut. The `--enable-helm` flag for `kustomize build` MUST be wrapped inside the relevant recipes (not relied on at the call site).

#### Scenario: `just --list` enumerates the daily-dev verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least: `vm-up`, `vm-down`, `vm-shell`, `k8s-apply`, `k8s-diff`, `k8s-delete`, `psql`

#### Scenario: `just k8s-apply` invokes Kustomize with `--enable-helm`
- **WHEN** a reader inspects the `k8s-apply` recipe in `justfile`
- **THEN** the recipe's command line includes `kustomize build --enable-helm` (or the kubectl-equivalent shorthand) against `infra/k8s/overlays/local`
- **AND** the recipe pipes the rendered manifests to `kubectl apply -f -`

#### Scenario: `just psql` connects to the in-cluster postgres
- **WHEN** an operator has run `just vm-up && just k8s-apply` and the postgres pod is Ready
- **AND** the operator runs `just psql`
- **THEN** a `psql` interactive session opens against `postgres://social:social@localhost:5432/social`

### Requirement: Kustomize overlays exist for `local` and a placeholder `hetzner`

Two Kustomize overlays SHALL exist under `infra/k8s/overlays/`: an active `local` overlay used by `just k8s-apply` and a placeholder `hetzner` overlay that establishes the layout for the next slice without declaring active resources.

#### Scenario: Local overlay references the base and applies local-specific patches
- **WHEN** a reader inspects `infra/k8s/overlays/local/kustomization.yaml`
- **THEN** the file declares `../../base` (or the canonical Kustomize path equivalent) as a resource
- **AND** the file documents (via comment or patch) the local-specific tuning (PVC size, resource caps) the slice settled on in design.md

#### Scenario: Hetzner overlay placeholder exists with a TODO marker
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file declares `../../base` as a resource
- **AND** the file contains a clearly marked TODO comment noting that real Hetzner-specific configuration (Secret strategy, resource requests, LoadBalancer annotations, persistence sizing) lands in the next slice
- **AND** the placeholder does NOT reuse the local plain Secret on the Hetzner overlay path

### Requirement: docker-compose stops shipping postgres; postgres-exporter retargets at the new postgres

The slice SHALL remove the `postgres` service from `docker-compose.yml` (the named volume `postgres-data` is preserved) and SHALL retarget the `postgres-exporter` service's `DATA_SOURCE_URI` from the now-deleted `postgres` service to `host.docker.internal:5432`, so the existing observability stack continues to scrape the new in-k3s postgres without any other change.

#### Scenario: docker-compose no longer defines a postgres service
- **WHEN** a reader inspects `docker-compose.yml`
- **THEN** no `services.postgres` block exists
- **AND** the file's top-of-file comment notes that dev postgres now lives in k3s and points at `infra/k8s/base/postgres/`

#### Scenario: Named volume `postgres-data` is preserved
- **WHEN** a reader inspects `docker-compose.yml`
- **THEN** the top-level `volumes:` block still contains a `postgres-data` declaration
- **AND** a comment notes that the volume is no longer mounted by any service but is preserved so a revert restores the prior compose definition cleanly

#### Scenario: postgres-exporter retargets at host.docker.internal:5432
- **WHEN** a reader inspects the `postgres-exporter` service block in `docker-compose.yml`
- **THEN** the `DATA_SOURCE_URI` environment variable references `host.docker.internal:5432/social?sslmode=disable`
- **AND** the service no longer `depends_on: postgres` (the docker-compose dependency is gone with the service)

#### Scenario: postgres-exporter continues to expose metrics that match slice-12 expectations
- **WHEN** an operator brings up the observability profile after the migration
- **AND** the operator hits `curl -s http://localhost:9187/metrics`
- **THEN** the response contains the same metric families slice 12 wired through (`pg_stat_database_*`, `pg_settings_max_connections`, the custom-queries projection of `pg_stat_statements`)

### Requirement: README documents the local k3s cluster

The top-level `README.md` SHALL gain a "Local k3s cluster" section documenting Lima installation, the `justfile` verb surface, the postgres-via-k3s dev loop, the explicit non-goals (backend / frontend / observability still on host or compose), and the documented spike notes (DIY postgres rewrite, CNPG migration, ingress-nginx swap).

#### Scenario: README has the new section
- **WHEN** a reader inspects `README.md`
- **THEN** a top-level or near-top-level section titled (or equivalent to) "Local k3s cluster" exists
- **AND** the section names the required brew packages (`lima`, `just`) and the one-time install command
- **AND** the section describes the `vm-up`, `k8s-apply`, `psql`, `vm-down`, `vm-shell` flow with copy-pasteable commands

#### Scenario: README documents the non-goals
- **WHEN** a reader inspects the new section
- **THEN** an explicit non-goals subsection (or paragraph) states that the backend, frontend, and observability stack are NOT yet in k3s
- **AND** the non-goals subsection lists the captured future spikes (DIY postgres, CNPG migration, ingress-nginx swap, Hetzner deploy) so a future reader can find them

### Requirement: A local OCI registry runs as a docker-compose service under the `registry` profile

The repository's `docker-compose.yml` SHALL define a `registry` service running the official `registry:2` image, bound to `127.0.0.1:5000` on the host, with a named volume for layer storage. The service SHALL belong to a new compose profile named `registry` so it does not start with the default `docker compose up` invocation, and SHALL only come up when explicitly selected (directly via `--profile registry` or transitively via the `justfile` recipe that wraps it).

#### Scenario: docker-compose declares the registry service under the `registry` profile
- **WHEN** a reader inspects `docker-compose.yml`
- **THEN** a `services.registry` block exists
- **AND** the block's `image` field references `registry:2` with an explicit tag (no `:latest`)
- **AND** the block declares `profiles: [registry]`
- **AND** the block's `ports:` entry binds host port `5000` on `127.0.0.1` (not `0.0.0.0`) to container port `5000`
- **AND** the block mounts a named volume at `/var/lib/registry`

#### Scenario: Registry does not start with the default compose invocation
- **WHEN** an operator runs `docker compose up -d` with no `--profile` flag in a fresh checkout
- **THEN** the `registry` service is not started
- **AND** `docker compose ps` shows no `registry` container

#### Scenario: Registry starts when the profile is selected
- **WHEN** an operator runs `docker compose --profile registry up -d registry`
- **THEN** the `registry` container is running
- **AND** `curl -sf http://localhost:5000/v2/` returns HTTP 200 with an empty JSON object

### Requirement: The k3s provision script configures the cluster to pull from the local registry

The `infra/provisioning/install-k3s.sh` script SHALL include an idempotent step that writes `/etc/rancher/k3s/registries.yaml` with a mirror entry rewriting the project's image-tag hostname (the hostname used in pod `image:` references) to a VM-reachable address of the host-side local registry. The step SHALL restart k3s if and only if the file's content changed, and SHALL be a no-op on subsequent runs once the content is in place.

#### Scenario: Provision script writes `registries.yaml`
- **WHEN** a reader inspects `infra/provisioning/install-k3s.sh`
- **THEN** the script writes a `/etc/rancher/k3s/registries.yaml` file
- **AND** the file's `mirrors:` block contains an entry for the project's image-tag hostname
- **AND** the entry's `endpoint:` list contains a single VM-reachable host-side URL on port `5000`
- **AND** the file's `configs:` block marks the endpoint as `insecure_skip_verify: true` (the local registry is HTTP and unauthenticated)

#### Scenario: Provision script restart is idempotent
- **WHEN** the provision script runs on a VM where `/etc/rancher/k3s/registries.yaml` already contains the exact expected content
- **THEN** the script does not restart k3s
- **AND** the script exits with success

#### Scenario: Pods pull the backend image successfully
- **WHEN** the host has run `just backend-image` (registry up, image pushed)
- **AND** an operator applies a manifest that references the backend image by the tag the project uses
- **THEN** the pod transitions from `ImagePulling` to `Running` without an `ErrImagePull` or `ImagePullBackOff` event
- **AND** `kubectl describe pod` shows the image was pulled successfully from the mirrored endpoint

### Requirement: The backend Deployment lives at `infra/k8s/base/backend/`

The repository SHALL contain a Kustomize directory at `infra/k8s/base/backend/` declaring the backend workload. The directory SHALL contain at minimum: a `kustomization.yaml` listing the directory's resources and applying default labels (`app.kubernetes.io/name=backend`); a `deployment.yaml` declaring a single-replica Deployment of the backend image; and a `service.yaml` declaring a ClusterIP Service on port 8080.

#### Scenario: Base backend directory exists
- **WHEN** a reader lists `infra/k8s/base/backend/`
- **THEN** the directory contains `kustomization.yaml`, `deployment.yaml`, and `service.yaml`

#### Scenario: Backend kustomization lists its resources and labels
- **WHEN** a reader inspects `infra/k8s/base/backend/kustomization.yaml`
- **THEN** the file's `resources:` block lists `./deployment.yaml` and `./service.yaml`
- **AND** the file declares a `commonLabels:` or `labels:` block setting `app.kubernetes.io/name: backend`

#### Scenario: Backend Deployment declares one replica and the chosen image reference
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** the file declares `kind: Deployment` with `spec.replicas: 1`
- **AND** the pod template's container `image:` field references the project's local-registry image tag (the same hostname mirrored by `/etc/rancher/k3s/registries.yaml`)

#### Scenario: Backend Service is ClusterIP on port 8080
- **WHEN** a reader inspects `infra/k8s/base/backend/service.yaml`
- **THEN** the file declares `kind: Service` with `spec.type: ClusterIP`
- **AND** the Service exposes port `8080` (TCP) targeting the pod's container port `8080`

### Requirement: The backend pod reads database credentials from the existing postgres Secret

The backend Deployment's container SHALL source `SPRING_DATASOURCE_USERNAME` and `SPRING_DATASOURCE_PASSWORD` from the same `postgres-credentials` Secret that the postgres workload consumes. The backend Deployment SHALL NOT declare a new Secret resource for these credentials.

#### Scenario: Deployment references the postgres-credentials Secret
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** at least one container `env:` entry sources `SPRING_DATASOURCE_USERNAME` from the `postgres-credentials` Secret via `valueFrom.secretKeyRef`
- **AND** at least one container `env:` entry sources `SPRING_DATASOURCE_PASSWORD` from the same Secret via `valueFrom.secretKeyRef`

#### Scenario: No new credentials Secret is introduced
- **WHEN** a reader inspects `infra/k8s/base/backend/`
- **THEN** no `Secret` resource is declared under that directory

### Requirement: The backend pod talks to postgres via the in-cluster ClusterIP DNS name

The backend Deployment's `SPRING_DATASOURCE_URL` SHALL be a JDBC URL whose host is the in-cluster Service DNS name of the postgres ClusterIP Service (not the LoadBalancer Service, not `localhost`, not a hardcoded IP). The Service DNS name SHALL be expressed in its FQDN form (`<svc>.<ns>.svc.cluster.local`).

#### Scenario: SPRING_DATASOURCE_URL points at the postgres ClusterIP Service FQDN
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `SPRING_DATASOURCE_URL` to a JDBC URL of the form `jdbc:postgresql://postgres-postgresql.social.svc.cluster.local:5432/social` (the exact ClusterIP Service name may differ if the chart's naming changes, but the FQDN form is preserved)

#### Scenario: Backend does not reference the LoadBalancer Service or localhost
- **WHEN** a reader greps `infra/k8s/base/backend/deployment.yaml` for `localhost`, `127.0.0.1`, or the LoadBalancer Service name from slice 14
- **THEN** no occurrence is found

### Requirement: The backend pod sends OTLP to the host-side collector

The backend Deployment SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318` so the in-cluster backend's OTel agent reaches the in-cluster OpenTelemetry Collector pod (NOT the compose collector via the VM-host alias). The in-cluster collector relays traces to the compose collector for the duration of the transition; the eventual `bridge-collectors-to-obs-cluster` slice replaces the collector's exporter target without touching the backend. (The requirement title is retained from slice 15 for spec-delta header continuity; the requirement's intent is now an in-cluster collector target.)

#### Scenario: Deployment sets the OTLP endpoint to the in-cluster Service FQDN
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://collector.social.svc.cluster.local:4318`
- **AND** the value's host is the in-cluster Service FQDN (NOT `host.docker.internal`, NOT `host.lima.internal`, NOT `localhost`, NOT a hardcoded IP)
- **AND** the value's port is `4318`

#### Scenario: Backend does not reference the VM-host alias for OTLP
- **WHEN** a reader greps `infra/k8s/base/backend/deployment.yaml` for `host.lima.internal:4318` or `host.docker.internal:4318`
- **THEN** no occurrence is found

### Requirement: The backend pod declares liveness, readiness, and startup probes

The backend container SHALL declare three HTTP probes:

- a `livenessProbe` against `/actuator/health/liveness` with `initialDelaySeconds: 30`, `periodSeconds: 10`, and `failureThreshold: 3`;
- a `readinessProbe` against `/actuator/health/readiness` with `periodSeconds: 5` and `failureThreshold: 3`;
- a `startupProbe` against `/actuator/health/liveness` with `periodSeconds: 5` and a `failureThreshold` high enough to absorb cold-start (Spring boot + Flyway) within at least 120 seconds.

#### Scenario: All three probes are declared with the documented endpoints
- **WHEN** a reader inspects the backend container spec in `infra/k8s/base/backend/deployment.yaml`
- **THEN** `livenessProbe.httpGet.path` is `/actuator/health/liveness`
- **AND** `readinessProbe.httpGet.path` is `/actuator/health/readiness`
- **AND** `startupProbe.httpGet.path` is `/actuator/health/liveness`

#### Scenario: Startup probe grace window absorbs cold-start
- **WHEN** a reader inspects the `startupProbe` spec
- **THEN** `periodSeconds * failureThreshold` is at least `120`

### Requirement: The backend container declares JVM-friendly resource requests and limits

The backend container SHALL declare `resources.requests` and `resources.limits` for both CPU and memory. The values SHALL be chosen so the pod fits within the Lima VM's 8 GiB envelope alongside the postgres pod's existing 1 GiB limit and so the same numbers transfer to the Hetzner CAX21 envelope without modification. The memory limit SHALL be at least 1 GiB to give a Java 21 Spring Boot 3 process room for heap, metaspace, native, and the OTel agent.

#### Scenario: Container declares CPU and memory resource bounds
- **WHEN** a reader inspects the backend container spec
- **THEN** the container declares both `resources.requests.cpu` and `resources.requests.memory`
- **AND** the container declares both `resources.limits.cpu` and `resources.limits.memory`
- **AND** `resources.limits.memory` parses to at least `1Gi`

### Requirement: The local overlay sets `imagePullPolicy: Always` for the backend

The `infra/k8s/overlays/local/` overlay SHALL patch the backend Deployment to set the container's `imagePullPolicy` to `Always`, so iterating on the floating `:dev` tag picks up new pushes without a digest swap.

#### Scenario: Local overlay declares the imagePullPolicy patch
- **WHEN** a reader inspects `infra/k8s/overlays/local/kustomization.yaml`
- **THEN** the file declares a strategic-merge patch (or a JSON 6902 patch) that sets the backend container's `imagePullPolicy` to `Always`

### Requirement: The Hetzner overlay declares a commented stub for the backend

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the next slice (Hetzner backend deploy) will add: the production image reference (`ghcr.io/<owner>/backend:<tag-or-digest>`), `imagePullSecrets`, production resource caps, tighter probe timings, and any other production-specific concerns the Hetzner slice will own. The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the backend additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production image reference, imagePullSecrets, resource caps, and probe-timing changes the Hetzner slice will add
- **AND** none of those declarations are uncommented in this slice

### Requirement: A `just` recipe surface drives the backend k3s loop

The repo-root `justfile` SHALL declare recipes covering the backend-in-k3s daily verbs. The recipe surface SHALL include image build + push, manifest apply with rollout-status gating, log tailing, port-forwarding, and resource teardown. Recipe names SHALL follow the `backend-<verb>` convention.

#### Scenario: `just --list` enumerates the backend k3s verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least: `backend-image`, `backend-apply`, `backend-logs`, `backend-forward`, `backend-delete`

#### Scenario: `backend-image` brings up the registry profile and builds the image
- **WHEN** a reader inspects the `backend-image` recipe in `justfile`
- **THEN** the recipe invokes `docker compose --profile registry up -d registry` (or equivalent)
- **AND** the recipe invokes `./gradlew bootBuildImage` with `-Ppublish=true` (or the project property that the slice settles on for publishing)

#### Scenario: `backend-apply` gates on rollout-status
- **WHEN** a reader inspects the `backend-apply` recipe in `justfile`
- **THEN** the recipe applies the local overlay via `kustomize build --enable-helm` piped to `kubectl apply -f -`
- **AND** the recipe runs `kubectl rollout status deploy/backend -n social` with an explicit `--timeout`

#### Scenario: `backend-forward` exposes the Service on a non-conflicting host port
- **WHEN** a reader inspects the `backend-forward` recipe
- **THEN** the recipe invokes `kubectl port-forward` against the backend Service on a host port that does not collide with the host backend's `:8080` (e.g. `18080`)

#### Scenario: `backend-delete` is label-scoped
- **WHEN** a reader inspects the `backend-delete` recipe
- **THEN** the recipe targets resources by the label selector `app.kubernetes.io/name=backend`

### Requirement: The frontend Deployment lives at `infra/k8s/base/frontend/`

The repository SHALL contain a Kustomize directory at `infra/k8s/base/frontend/` declaring the frontend workload. The directory SHALL contain at minimum: a `kustomization.yaml` listing the directory's resources and applying default labels (`app.kubernetes.io/name=frontend`); a `deployment.yaml` declaring a single-replica Deployment of the frontend image; and a `service.yaml` declaring a ClusterIP Service that maps port `80` to the pod's container port `8080`.

#### Scenario: Base frontend directory exists
- **WHEN** a reader lists `infra/k8s/base/frontend/`
- **THEN** the directory contains `kustomization.yaml`, `deployment.yaml`, and `service.yaml`

#### Scenario: Frontend kustomization lists its resources and labels
- **WHEN** a reader inspects `infra/k8s/base/frontend/kustomization.yaml`
- **THEN** the file's `resources:` block lists `./deployment.yaml` and `./service.yaml`
- **AND** the file declares a `commonLabels:` or `labels:` block setting `app.kubernetes.io/name: frontend`

#### Scenario: Frontend Deployment declares one replica and the chosen image reference
- **WHEN** a reader inspects `infra/k8s/base/frontend/deployment.yaml`
- **THEN** the file declares `kind: Deployment` with `spec.replicas: 1`
- **AND** the pod template's container `image:` field references the project's local-registry image tag for the frontend (the same hostname mirrored by `/etc/rancher/k3s/registries.yaml`)
- **AND** the container exposes port `8080` (the unprivileged-nginx default)

#### Scenario: Frontend Service is ClusterIP mapping 80 to 8080
- **WHEN** a reader inspects `infra/k8s/base/frontend/service.yaml`
- **THEN** the file declares `kind: Service` with `spec.type: ClusterIP`
- **AND** the Service exposes port `80` (TCP) targeting the pod's container port `8080`

### Requirement: The frontend pod reverse-proxies `/api/*` and `/actuator/*` to the in-cluster backend Service

The frontend pod's nginx config SHALL forward HTTP requests matching path prefixes `/api/` and `/actuator/` to the in-cluster backend ClusterIP Service via the FQDN `backend.social.svc.cluster.local:8080`. The frontend pod's nginx config SHALL ALSO forward HTTP requests matching the path prefix `/v1/` to the in-cluster collector ClusterIP Service via the FQDN `collector.social.svc.cluster.local:4318` (this is the OTLP/HTTP receiver port for the slice-18a app collector, used by browser OTLP for traces, logs, and metrics under `/v1/traces`, `/v1/logs`, `/v1/metrics`). All other paths SHALL be served from the static bundle under `/usr/share/nginx/html`, with a single-page-application fallback: any unmatched path under `/` SHALL be served as `/index.html` (HTTP 200) so client-side routes deep-link correctly.

#### Scenario: nginx config forwards `/api/` to the backend Service

- **WHEN** a reader inspects the nginx config baked into the frontend image (e.g. `frontend/docker/nginx.conf`)
- **THEN** a `location /api/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`
- **AND** the block sets at least `proxy_set_header Host $host;`

#### Scenario: nginx config forwards `/actuator/` to the backend Service

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /actuator/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`

#### Scenario: nginx config forwards `/v1/` to the collector Service

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /v1/` block declares `proxy_pass http://collector.social.svc.cluster.local:4318;`
- **AND** the block sets at least `proxy_set_header Host $host;`
- **AND** the block does NOT include a CORS-related `add_header` (the same-origin shape means no preflight is involved).

#### Scenario: nginx config serves the SPA fallback

- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /` block declares `try_files $uri $uri/ /index.html;`

#### Scenario: Pod-to-pod traffic actually reaches the backend

- **WHEN** the frontend and backend Deployments are both applied and Ready
- **AND** an operator port-forwards the frontend Service and issues `curl -sf http://localhost:<port>/actuator/health`
- **THEN** the response is HTTP 200 with body `{"status":"UP"}` (the backend's actuator response), demonstrating the proxy hop succeeded

#### Scenario: Pod-to-pod traffic actually reaches the collector via `/v1/`

- **WHEN** the frontend Deployment and the collector Deployment are both applied and Ready
- **AND** an operator port-forwards the frontend Service and issues a minimal valid OTLP/HTTP traces POST to `http://localhost:<port>/v1/traces`
- **THEN** the response is HTTP 2xx (the collector accepted the payload), demonstrating the proxy hop succeeded
- **AND** the request appears in `just collector-logs` for the app k3s collector pod.

### Requirement: The in-k3s frontend strictly pairs with the in-k3s backend

The base frontend manifests SHALL NOT include any fallback mechanism (alternate nginx upstream, ConfigMap-based upstream override, or local-overlay strategic-merge patch) that points the frontend pod at the host-loop backend. If a developer applies the frontend overlay without also applying the backend overlay, nginx SHALL return HTTP 502 on `/api/*` and `/actuator/*` calls because the backend Service has no endpoints.

#### Scenario: No host-loop fallback exists in base manifests
- **WHEN** a reader greps `infra/k8s/base/frontend/` and `infra/k8s/overlays/local/` for `host.lima.internal:8080` or `host.docker.internal:8080`
- **THEN** no occurrence is found

#### Scenario: Missing backend endpoints surface as 502
- **WHEN** the frontend Deployment is applied but the backend Deployment is deleted (`just backend-delete`)
- **AND** a developer hits `http://localhost:13000/api/v1/anything` through the frontend port-forward
- **THEN** the response is HTTP 502 (`Bad Gateway`)
- **AND** the response is served by the frontend pod's nginx (visible in `just frontend-logs`)

### Requirement: The frontend container declares liveness and readiness probes

The frontend container SHALL declare two HTTP probes against port 8080:

- a `livenessProbe` against `/` with `initialDelaySeconds: 5`, `periodSeconds: 10`, and `failureThreshold: 3`;
- a `readinessProbe` against `/` with `periodSeconds: 5` and `failureThreshold: 3`.

The container SHALL NOT declare a `startupProbe` — nginx is up in under one second; the liveness probe's `initialDelaySeconds: 5` covers the cold start.

#### Scenario: Liveness and readiness probes are declared with the documented endpoint
- **WHEN** a reader inspects the frontend container spec in `infra/k8s/base/frontend/deployment.yaml`
- **THEN** `livenessProbe.httpGet.path` is `/`
- **AND** `livenessProbe.httpGet.port` resolves to `8080`
- **AND** `readinessProbe.httpGet.path` is `/`
- **AND** `readinessProbe.httpGet.port` resolves to `8080`

#### Scenario: No startup probe is declared
- **WHEN** a reader inspects the frontend container spec
- **THEN** no `startupProbe` block is declared

### Requirement: The frontend container declares lightweight resource requests and limits

The frontend container SHALL declare `resources.requests` and `resources.limits` for both CPU and memory. The values SHALL reflect nginx's light footprint and SHALL fit alongside the postgres and backend pods in the Lima VM's 8 GiB envelope (and the CAX21 Hetzner envelope), with `resources.limits.memory` at or below `256Mi`.

#### Scenario: Container declares CPU and memory resource bounds
- **WHEN** a reader inspects the frontend container spec
- **THEN** the container declares both `resources.requests.cpu` and `resources.requests.memory`
- **AND** the container declares both `resources.limits.cpu` and `resources.limits.memory`
- **AND** `resources.limits.memory` parses to at most `256Mi`

### Requirement: The local overlay sets `imagePullPolicy: Always` for the frontend

The `infra/k8s/overlays/local/` overlay SHALL patch the frontend Deployment to set the container's `imagePullPolicy` to `Always`, mirroring the slice-15 backend patch, so iterating on the floating `:dev` tag picks up new pushes without a digest swap.

#### Scenario: Local overlay declares the frontend imagePullPolicy patch
- **WHEN** a reader inspects `infra/k8s/overlays/local/kustomization.yaml`
- **THEN** the file declares a strategic-merge patch (or a JSON 6902 patch) that sets the frontend container's `imagePullPolicy` to `Always`

### Requirement: The Hetzner overlay declares a commented stub for the frontend

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the next slice (Hetzner frontend deploy) will add: the production image reference (`ghcr.io/<owner>/frontend:<tag-or-digest>`), `imagePullSecrets`, production resource caps if different from base, tighter probe timings, and the `imagePullPolicy: IfNotPresent` posture appropriate for digest-pinned tags. The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the frontend additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production image reference, imagePullSecrets, resource caps, probe-timing changes, and imagePullPolicy posture the Hetzner slice will add for the frontend
- **AND** none of those declarations are uncommented in this slice

### Requirement: A `just` recipe surface drives the frontend k3s loop

The repo-root `justfile` SHALL declare recipes covering the frontend-in-k3s daily verbs. The recipe surface SHALL include image build + push, manifest apply with rollout-status gating, log tailing, port-forwarding, resource teardown, and a one-shot rebuild that chains build and apply. Recipe names SHALL follow the `frontend-<verb>` convention, mirroring slice 15's `backend-<verb>` convention.

#### Scenario: `just --list` enumerates the frontend k3s verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least: `frontend-image`, `frontend-apply`, `frontend-logs`, `frontend-forward`, `frontend-delete`, `frontend-rebuild`

#### Scenario: `frontend-image` brings up the registry profile and builds the image
- **WHEN** a reader inspects the `frontend-image` recipe in `justfile`
- **THEN** the recipe invokes `docker compose --profile registry up -d registry` (or equivalent)
- **AND** the recipe invokes `docker build` against the `frontend/` directory producing a tag of the form `<host-registry-alias>/frontend:dev`
- **AND** the recipe invokes `docker push` against the same tag

#### Scenario: `frontend-apply` gates on rollout-status
- **WHEN** a reader inspects the `frontend-apply` recipe in `justfile`
- **THEN** the recipe applies the local overlay via `kustomize build --enable-helm` piped to `kubectl apply -f -`
- **AND** the recipe runs `kubectl rollout status deploy/frontend -n social` with an explicit `--timeout`

#### Scenario: `frontend-forward` exposes the Service on a non-conflicting host port
- **WHEN** a reader inspects the `frontend-forward` recipe
- **THEN** the recipe invokes `kubectl port-forward` against the frontend Service on a host port that does not collide with Vite dev (`5173`), Vite preview (`4173`), or the slice-15 backend forward (`18080`)

#### Scenario: `frontend-delete` is label-scoped
- **WHEN** a reader inspects the `frontend-delete` recipe
- **THEN** the recipe targets resources by the label selector `app.kubernetes.io/name=frontend`

#### Scenario: `frontend-rebuild` chains the build and apply primitives
- **WHEN** a reader inspects the `frontend-rebuild` recipe
- **THEN** the recipe invokes the `frontend-image` recipe (or its body) and then the `frontend-apply` recipe (or its body)

### Requirement: An OpenTelemetry Collector Deployment lives at `infra/k8s/base/collector/`

The repository SHALL contain a Kustomize directory `infra/k8s/base/collector/` declaring an OpenTelemetry Collector workload that runs inside the application Kubernetes cluster. The directory SHALL follow the established `base/<component>/` convention with `kustomization.yaml`, `deployment.yaml`, `service.yaml`, and `configmap.yaml`. The image tag SHALL be pinned via the directory's `kustomization.yaml` `images:` directive so a future bump touches a single line.

#### Scenario: Collector directory follows the established layout
- **WHEN** a reader lists `infra/k8s/base/collector/`
- **THEN** the directory contains `kustomization.yaml`, `deployment.yaml`, `service.yaml`, and `configmap.yaml`
- **AND** each file is referenced from the directory's `kustomization.yaml` `resources:` block

#### Scenario: Collector image tag is pinned in one place
- **WHEN** a reader inspects `infra/k8s/base/collector/kustomization.yaml`
- **THEN** the file declares an `images:` directive with `name: otel/opentelemetry-collector-contrib` and an explicit `newTag` value
- **AND** the `deployment.yaml` references the image by name without an inline tag (so the directive controls the resolved tag)

#### Scenario: Collector is listed in the base kustomization index
- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the `resources:` block includes `./collector` alongside `./postgres`, `./backend`, and `./frontend`

### Requirement: The collector Deployment exposes OTLP receivers via a ClusterIP Service named `collector`

The collector workload SHALL be reachable from other in-cluster pods at the stable DNS name `collector.social.svc.cluster.local`. A `Service` of `type: ClusterIP` in the `social` namespace SHALL surface the collector's OTLP/gRPC and OTLP/HTTP receivers on ports `4317` and `4318` respectively. The Service SHALL NOT publish a NodePort or LoadBalancer — only in-cluster traffic reaches the collector in this slice.

#### Scenario: Service is ClusterIP with both OTLP ports
- **WHEN** a reader inspects `infra/k8s/base/collector/service.yaml`
- **THEN** the file declares `kind: Service`, `metadata.namespace: social`, `metadata.name: collector`
- **AND** `spec.type` is `ClusterIP`
- **AND** the `ports:` list includes one entry with `name: otlp-grpc, port: 4317` and one entry with `name: otlp-http, port: 4318`
- **AND** no port declares a `nodePort` value
- **AND** the Service is NOT referenced anywhere in the repository as type `LoadBalancer`

#### Scenario: Service selector matches the collector Deployment labels
- **WHEN** a reader inspects the Service's `spec.selector` and the Deployment's `spec.template.metadata.labels`
- **THEN** the selector matches the Deployment template labels (`app.kubernetes.io/name=collector`)

### Requirement: The collector pipeline is declared in a `collector-config` ConfigMap mounted read-only at `/etc/otelcol-contrib/`

The collector's runtime configuration SHALL live in a `ConfigMap` named `collector-config` in the `social` namespace, mounted into the pod's container at `/etc/otelcol-contrib/` read-only. The pipeline SHALL declare exactly one `otlp` receiver (gRPC `0.0.0.0:4317` and HTTP `0.0.0.0:4318`, no CORS block — slice 18c moved browser OTLP to same-origin via the frontend nginx, so the collector's OTLP/HTTP receiver no longer needs CORS for any client), `batch` and `transform/redact-path-ids` processors, a `filter/exclude_observability_self` processor (used only in the logs pipeline as defence-in-depth against feedback loops if the log-agent's namespace scope is ever widened to include the observability cluster's own pods), a `health_check` extension exposing `:13133/` for kubelet probes, and the following exporters:

- `otlp/compose-relay` (traces, OTLP/gRPC) targeting `host.lima.internal:4317` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-logs` (logs, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlphttp/compose-relay-metrics` (metrics, OTLP/HTTP) targeting `http://host.lima.internal:4318` with `tls.insecure: true`. Plaintext; local-only; retired in slice 22.
- `otlp/obs-cluster` (traces, OTLP/gRPC) targeting `host.lima.internal:14317` with a `tls:` block declaring `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`. The endpoint stays scheme-less (gRPC clients select transport via the `tls:` block, not the URL scheme).
- `otlphttp/obs-cluster-logs` (logs, OTLP/HTTP) targeting `https://host.lima.internal:14318` with a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`. URL scheme is `https://` because OTLP/HTTP exporters select transport via the URL scheme.
- `otlphttp/obs-cluster-metrics` (metrics, OTLP/HTTP) targeting `https://host.lima.internal:14318` with the same `tls:` block as the logs exporter.

The declared pipelines SHALL be exactly three:

- `traces`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay, otlp/obs-cluster]`.
- `logs`, with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids, filter/exclude_observability_self]`, `exporters: [otlphttp/compose-relay-logs, otlphttp/obs-cluster-logs]`.
- `metrics`, with `receivers: [otlp]`, `processors: [batch]`, `exporters: [otlphttp/compose-relay-metrics, otlphttp/obs-cluster-metrics]`.

The cert files referenced by the three `*obs-cluster*` exporters SHALL resolve to a Secret-mounted volume at `/etc/otelcol-contrib/certs/` (declared by the Deployment / Kustomize per the cert-mount requirement).

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s/base/collector/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the deployment mounts this ConfigMap at `/etc/otelcol-contrib/` (so the in-pod file path is `/etc/otelcol-contrib/config.yaml`)
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`

#### Scenario: Receivers enable OTLP on both gRPC and HTTP without CORS

- **WHEN** a reader inspects the `receivers:` block in the collector config
- **THEN** an `otlp` receiver is declared with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`
- **AND** no `cors:` block appears under `protocols.http`

#### Scenario: Processors mirror the compose collector's redaction policy and include the modern `url.path` attribute

- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `transform/redact-path-ids` processor is declared
- **AND** the OTTL `trace_statements` target the attribute key `url.path` for every redaction pattern (UUID, opaque-hex, numeric)
- **AND** the OTTL statements also target `span.name`, `attributes["http.url"]`, `attributes["http.target"]`, `attributes["url.full"]` (kept as defence-in-depth for legacy instrumentation)
- **AND** no `filter/drop_high_cardinality`, `transform/pii_scrub`, or `attributes/loki_labels` processor is declared

#### Scenario: `filter/exclude_observability_self` processor is declared and used only in the logs pipeline

- **WHEN** a reader inspects the `processors:` block in the collector config
- **THEN** a `filter/exclude_observability_self` processor is declared that drops log records whose `resource.attributes["k8s.namespace.name"] == "observability"`
- **AND** the processor appears in the `service.pipelines.logs.processors` list
- **AND** the processor does NOT appear in `service.pipelines.traces.processors` or `service.pipelines.metrics.processors`
- **AND** no processor named `filter/frontend_only` remains in the config

#### Scenario: Compose-relay exporters remain plaintext

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/compose-relay` exporter is declared with `endpoint: host.lima.internal:4317` and `tls.insecure: true`
- **AND** an `otlphttp/compose-relay-logs` exporter is declared with `endpoint: http://host.lima.internal:4318` and `tls.insecure: true`
- **AND** an `otlphttp/compose-relay-metrics` exporter is declared with `endpoint: http://host.lima.internal:4318` and `tls.insecure: true`

#### Scenario: Obs-cluster exporters present a client cert and verify against the shared CA

- **WHEN** a reader inspects the `exporters:` block in the collector config
- **THEN** an `otlp/obs-cluster` exporter is declared with `endpoint: host.lima.internal:14317` (scheme-less)
- **AND** the exporter's `tls:` block declares `cert_file: /etc/otelcol-contrib/certs/client.crt`, `key_file: /etc/otelcol-contrib/certs/client.key`, `ca_file: /etc/otelcol-contrib/certs/ca.crt`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-logs` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same `cert_file`, `key_file`, `ca_file`, and `insecure: false`
- **AND** an `otlphttp/obs-cluster-metrics` exporter is declared with `endpoint: https://host.lima.internal:14318` and a `tls:` block declaring the same cert files and `insecure: false`
- **AND** no `*obs-cluster*` exporter declares `tls.insecure: true`

#### Scenario: Three pipelines fan out to both compose and obs destinations

- **WHEN** a reader inspects the `service.pipelines:` block in the collector config
- **THEN** exactly three pipelines are declared: `traces`, `logs`, and `metrics`
- **AND** each pipeline's `receivers` list contains `otlp`
- **AND** the `traces` pipeline's `processors` list is `[batch, transform/redact-path-ids]` in that order
- **AND** the `traces` pipeline's `exporters` list contains both `otlp/compose-relay` and `otlp/obs-cluster`
- **AND** the `logs` pipeline's `processors` list is `[batch, transform/redact-path-ids, filter/exclude_observability_self]` in that order
- **AND** the `logs` pipeline's `exporters` list contains both `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs`
- **AND** the `metrics` pipeline's `processors` list is `[batch]`
- **AND** the `metrics` pipeline's `exporters` list contains both `otlphttp/compose-relay-metrics` and `otlphttp/obs-cluster-metrics`

#### Scenario: health_check extension is enabled and registered with the service block

- **WHEN** a reader inspects the collector config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

#### Scenario: Cross-cluster handshake succeeds end-to-end on the local mirror

- **WHEN** the operator brings up both clusters via `just obs-up` (which auto-runs `just obs-certs` if certs are missing) and `just up` and applies both overlays
- **AND** generates backend traffic through the app cluster
- **THEN** the app collector logs show NO `tls: handshake error` lines against any `*obs-cluster*` exporter
- **AND** the obs collector receiver accepts the connection without "remote error: tls: bad certificate" entries
- **AND** the trace flows through to obs grafana on `:3001` end-to-end

#### Scenario: Browser FE error logs still flow through the renamed filter

- **WHEN** a browser FE error is captured by the frontend SDK and pushed via OTLP/HTTP through the frontend nginx proxy to the gateway collector
- **AND** the record reaches the `filter/exclude_observability_self` processor
- **THEN** the record passes the filter (its `resource.attributes["k8s.namespace.name"]` is absent or null, not `observability`)
- **AND** the record continues through the dual-write to both `otlphttp/compose-relay-logs` and `otlphttp/obs-cluster-logs`
- **AND** the record appears in obs grafana → Explore → Loki for `service.name=frontend`

### Requirement: The collector Deployment declares health-check probes against the bundled extension

The collector container SHALL declare a `livenessProbe` and a `readinessProbe`, both HTTP GETs against the named `healthcheck` container port (the contrib collector's bundled `health_check` extension on port `13133`). The probes SHALL NOT target the OTLP receiver ports (a bare GET against `:4318/` returns 404, which kubelet treats as unhealthy).

#### Scenario: Both probes target the healthcheck port
- **WHEN** a reader inspects the collector container spec in `infra/k8s/base/collector/deployment.yaml`
- **THEN** `livenessProbe.httpGet.port` is the named port `healthcheck` (or its numeric equivalent `13133`)
- **AND** `readinessProbe.httpGet.port` is the same port
- **AND** the path is `/`
- **AND** the container declares a `containerPorts:` entry `name: healthcheck, containerPort: 13133`

#### Scenario: Probes are NOT directed at the OTLP receivers
- **WHEN** a reader greps `infra/k8s/base/collector/deployment.yaml` for the OTLP port numbers `4317` or `4318` inside `livenessProbe` or `readinessProbe` blocks
- **THEN** no match is found

### Requirement: The collector container declares conservative resource requests and limits

The collector container SHALL declare CPU and memory `requests` and `limits` sized for the local single-node cluster's headroom (~7 GiB free after postgres + backend + frontend). The values SHALL be conservative enough that the collector remains a polite cluster citizen but generous enough that the typical local-dev span volume does not throttle or OOM.

#### Scenario: Container declares both requests and limits for CPU and memory
- **WHEN** a reader inspects the collector container's `resources:` block
- **THEN** `requests.cpu` and `requests.memory` are declared
- **AND** `limits.cpu` and `limits.memory` are declared
- **AND** `limits.memory` parses to at least `256Mi`

### Requirement: The Hetzner overlay declares a commented stub for the collector

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the collector: production resource caps, the cross-cluster exporter endpoint (the production-side obs-cluster receiver address — the local mirror's `host.lima.internal:14317` becomes the obs box's private-network IP), TLS / mTLS material reference, tighter probe timings, anti-affinity considerations if multi-node, and a note that dual-write to the compose collector MUST NOT be carried into production (slice 22 collapses dual-write before any prod cutover). The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the collector additions a future slice will plug in
- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, cross-cluster exporter endpoint, TLS material, and probe-timing changes the Hetzner slice will add for the collector
- **AND** the commented narrative explicitly warns that dual-write to the compose collector is local-only and MUST NOT be inherited by the Hetzner deploy
- **AND** none of those declarations are uncommented in this slice

### Requirement: A `just` recipe surface drives the collector lifecycle

The repo-root `justfile` SHALL declare two recipes covering the in-cluster collector's daily verbs: log tailing and rolling restart (the documented Kubernetes pattern for picking up ConfigMap edits, since the kubelet does not auto-restart pods when a mounted ConfigMap changes). Recipe names SHALL follow the `collector-<verb>` convention.

#### Scenario: `just --list` enumerates the collector verbs
- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least `collector-logs` and `collector-rollout`

#### Scenario: `collector-rollout` waits for rollout completion
- **WHEN** an operator runs `just collector-rollout`
- **THEN** the recipe issues `kubectl rollout restart deploy/collector -n social`
- **AND** waits for the rollout to complete via `kubectl rollout status` before returning

### Requirement: The app collector pod mounts the cross-cluster client-cert Secret

The collector container in `infra/k8s/base/collector/deployment.yaml` SHALL declare a second `volumeMount` named `certs` mounted read-only at `/etc/otelcol-contrib/certs/`, and the Deployment's `volumes:` block SHALL declare a corresponding `secret`-typed volume named `certs` referencing a Secret produced by a Kustomize `secretGenerator`. The secretGenerator entry in `infra/k8s/base/collector/kustomization.yaml` SHALL read the per-cluster certs directory `./certs/` (containing `client.crt`, `client.key`, and `ca.crt`) and SHALL NOT disable name suffixing (so a regenerated cert produces a new Secret name and the Deployment rolls automatically). The mounted directory SHALL be the same path the collector's exporter `tls:` blocks reference in `cert_file`, `key_file`, and `ca_file`.

#### Scenario: Deployment declares the certs volume and mount

- **WHEN** a reader inspects the collector container spec in `infra/k8s/base/collector/deployment.yaml`
- **THEN** the container's `volumeMounts:` list contains an entry `name: certs, mountPath: /etc/otelcol-contrib/certs, readOnly: true`
- **AND** the pod's `volumes:` list contains an entry `name: certs` of type `secret` whose `secretName` matches the Secret produced by the kustomization's secretGenerator
- **AND** the existing `config` volume mount at `/etc/otelcol-contrib/` is unchanged

#### Scenario: kustomization.yaml declares the secretGenerator for the app collector certs

- **WHEN** a reader inspects `infra/k8s/base/collector/kustomization.yaml`
- **THEN** the file declares a `secretGenerator:` block with an entry whose `name` is the Secret name referenced by the Deployment's `certs` volume
- **AND** the entry's `files:` list (or `envs:` if files: is not used) materializes `client.crt`, `client.key`, and `ca.crt` from `infra/k8s/base/collector/certs/`
- **AND** the generator does NOT set `disableNameSuffixHash: true` (so contents-hashed naming triggers automatic rollouts on cert regeneration)

#### Scenario: Per-directory `.gitignore` keeps private key out of git

- **WHEN** a reader inspects `infra/k8s/base/collector/certs/.gitignore` (or the repo-root `.gitignore` patterns)
- **THEN** the pattern excludes `client.key` (or `*.key`)
- **AND** `client.crt` and `ca.crt` are NOT excluded (they are public material and SHALL be committed)

### Requirement: The log-agent DaemonSet lives at `infra/k8s/base/log-agent/`

The repository SHALL contain a Kustomize directory at `infra/k8s/base/log-agent/` declaring an OpenTelemetry Collector DaemonSet that runs one pod per node in the app cluster and ships node-local pod logs to the gateway collector. The directory SHALL contain at minimum: `kustomization.yaml`, `daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, and `rbac.yaml`. The image SHALL be `otel/opentelemetry-collector-contrib:0.111.0` — the same pin used by the gateway collector, the compose collector, and the obs cluster collector.

#### Scenario: log-agent directory follows the established layout

- **WHEN** a reader lists `infra/k8s/base/log-agent/`
- **THEN** the directory contains `kustomization.yaml`, `daemonset.yaml`, `configmap.yaml`, `serviceaccount.yaml`, and `rbac.yaml`
- **AND** each file is referenced from the directory's `kustomization.yaml` `resources:` block

#### Scenario: DaemonSet image is pinned to the project-wide contrib collector tag

- **WHEN** a reader inspects `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** the container's `image` is `otel/opentelemetry-collector-contrib:0.111.0`
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`
- **AND** the ConfigMap is mounted read-only at `/etc/otelcol-contrib/`

#### Scenario: DaemonSet is listed in the base kustomization index

- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the `resources:` block includes `./log-agent` alongside `./postgres`, `./backend`, `./frontend`, and `./collector`

#### Scenario: Common labels mark the workload

- **WHEN** a reader inspects `infra/k8s/base/log-agent/kustomization.yaml`
- **THEN** the file declares a `commonLabels:` or `labels:` block setting `app.kubernetes.io/name: log-agent`

### Requirement: The log-agent DaemonSet tolerates all taints and mounts the host pod-log directory

The DaemonSet pod-spec SHALL declare a `tolerations:` entry that tolerates every taint (so the pod schedules on every node including the control-plane node in a single-node k3s cluster), SHALL mount the host's `/var/log/pods` directory read-only at the same in-pod path, and SHALL declare conservative CPU and memory `requests` and `limits` sized for the local Lima VM's 8 GiB envelope.

#### Scenario: Tolerations cover the control-plane taint

- **WHEN** a reader inspects the DaemonSet pod-spec in `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** the `tolerations:` list contains an entry `operator: Exists` with no `key:` or `value:`
- **AND** the pod schedules on the only node of a single-node k3s cluster

#### Scenario: hostPath mount of /var/log/pods is read-only

- **WHEN** a reader inspects the pod-spec
- **THEN** the pod's `volumes:` list contains a `hostPath` volume named `varlogpods` whose `path:` is `/var/log/pods`
- **AND** the container's `volumeMounts:` declares an entry mounting that volume at `/var/log/pods` with `readOnly: true`

#### Scenario: Container resources are declared

- **WHEN** a reader inspects the container's `resources:` block
- **THEN** `requests.cpu` and `requests.memory` are declared
- **AND** `limits.cpu` and `limits.memory` are declared
- **AND** `limits.memory` parses to at most `256Mi`

#### Scenario: DaemonSet pod-spec sets the service account

- **WHEN** a reader inspects the pod-spec
- **THEN** `spec.template.spec.serviceAccountName` is set to the ServiceAccount declared in `infra/k8s/base/log-agent/serviceaccount.yaml`

### Requirement: The log-agent ServiceAccount has cluster-scoped read on pods, namespaces, and replicasets

The repository SHALL declare a `ServiceAccount` in `infra/k8s/base/log-agent/serviceaccount.yaml` (in the `social` namespace) and a `ClusterRole` + `ClusterRoleBinding` in `infra/k8s/base/log-agent/rbac.yaml` granting the ServiceAccount read-only access (verbs: `get`, `list`, `watch`) to `pods`, `namespaces`, and `replicasets` across all namespaces. No write or admin verb SHALL be granted. The grant SHALL be cluster-scoped because the `k8sattributes` processor resolves pod metadata across namespace boundaries.

#### Scenario: ServiceAccount is declared in the social namespace

- **WHEN** a reader inspects `infra/k8s/base/log-agent/serviceaccount.yaml`
- **THEN** the file declares a `ServiceAccount` resource
- **AND** no `Secret` or token resource is created alongside (the projected-token mechanism mounts automatically)

#### Scenario: ClusterRole verbs are read-only on the documented resource kinds

- **WHEN** a reader inspects `infra/k8s/base/log-agent/rbac.yaml`
- **THEN** the file declares a `ClusterRole` whose `rules:` grants verbs `get`, `list`, `watch` on resource kinds `pods`, `namespaces`, `replicasets`
- **AND** no rule grants `create`, `update`, `patch`, `delete`, or any wildcard verb
- **AND** no rule grants access to resource kinds outside `pods`, `namespaces`, `replicasets`

#### Scenario: ClusterRoleBinding binds the ClusterRole to the ServiceAccount

- **WHEN** a reader inspects `infra/k8s/base/log-agent/rbac.yaml`
- **THEN** the file declares a `ClusterRoleBinding` whose `roleRef:` points at the ClusterRole declared in the same file
- **AND** whose `subjects:` references the ServiceAccount declared in `serviceaccount.yaml` (by name and namespace `social`)

### Requirement: The log-agent ConfigMap declares the filelog → k8sattributes → batch → otlp pipeline

The log-agent's runtime configuration SHALL live in a `ConfigMap` named `log-agent-config` in the `social` namespace, mounted read-only at `/etc/otelcol-contrib/`. The pipeline SHALL declare:

- A `filelog` receiver whose `include:` glob is exactly `/var/log/pods/social_*/*/*.log` (the social namespace's pods plus, by inclusion, the log-agent's own pods which run in `social`). The receiver SHALL declare a `start_at: beginning` (so a fresh pod re-reads existing files) and an `operators:` chain that (a) strips the CRI envelope (`container` parser or equivalent), (b) routes on whether the body starts with `{` after optional whitespace, (c) JSON-parses the routed branch with `on_error: send_quiet`, promoting `timestamp`, `level`, `message`, `trace_id`, and `span_id` to log-record fields, (d) maps `level` to `severity_text` and `severity_number`.
- A `k8sattributes` processor with `auth_type: serviceAccount` and an `extract:` block that pulls `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`, and the workload-level label `app.kubernetes.io/name`.
- A `batch` processor.
- An `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true` (in-cluster plaintext gRPC).
- A `health_check` extension on `:13133/` and a `service.extensions:` entry registering it.

The declared pipelines SHALL be exactly one:

- `logs`, with `receivers: [filelog]`, `processors: [k8sattributes, batch]`, `exporters: [otlp]`.

No `traces` or `metrics` pipeline SHALL be declared in the log-agent ConfigMap.

#### Scenario: ConfigMap key projects as a file at the expected path

- **WHEN** a reader inspects `infra/k8s/base/log-agent/configmap.yaml`
- **THEN** the ConfigMap has a single data key named `config.yaml`
- **AND** the daemonset mounts this ConfigMap at `/etc/otelcol-contrib/`
- **AND** the container's `args:` references `--config=/etc/otelcol-contrib/config.yaml`

#### Scenario: filelog receiver is scoped to social namespace pods

- **WHEN** a reader inspects the `receivers:` block in the log-agent config
- **THEN** a `filelog` receiver is declared with an `include:` glob exactly matching `/var/log/pods/social_*/*/*.log`
- **AND** no other namespace prefix (e.g. `kube-system_*`, `default_*`, `observability_*`) appears in the include list
- **AND** `start_at: beginning` is declared

#### Scenario: filelog operators chain handles CRI envelope and JSON parsing

- **WHEN** a reader inspects the filelog receiver's `operators:` block
- **THEN** an operator strips the CRI envelope before the body is examined
- **AND** a `router` operator branches on whether the body matches a JSON-shaped predicate (start-of-line `{` after optional whitespace)
- **AND** a `json_parser` operator on the JSON branch declares `on_error: send_quiet` (so a malformed line falls back to raw text rather than dropping)
- **AND** the JSON branch promotes inner fields `timestamp`, `level`, `message`, `trace_id`, `span_id` to log-record fields (timestamp → record timestamp, level → severity, message → body)

#### Scenario: trace correlation fields are normalized to underscored form

- **WHEN** the JSON branch parses a backend log line whose body contains MDC keys `trace.id` and `span.id` (the OTel dotted convention used by the backend's logback config)
- **THEN** the resulting log record carries `trace_id` and `span_id` as the underscored top-level fields Grafana's trace-to-logs correlation expects
- **AND** no dotted `trace.id` / `span.id` field survives on the record

#### Scenario: k8sattributes processor extracts the documented attribute set

- **WHEN** a reader inspects the `processors:` block in the log-agent config
- **THEN** a `k8sattributes` processor is declared with `auth_type: serviceAccount`
- **AND** the processor's `extract.metadata:` (or chart-equivalent) lists `k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`, `k8s.container.name`, `k8s.node.name`
- **AND** the processor's `extract.labels:` (or chart-equivalent) lists `app.kubernetes.io/name`

#### Scenario: Exporter targets the in-cluster gateway and stays plaintext

- **WHEN** a reader inspects the `exporters:` block in the log-agent config
- **THEN** an `otlp` exporter is declared with `endpoint: collector.social.svc.cluster.local:4317` and `tls.insecure: true`
- **AND** no `otlphttp/*` exporter is declared
- **AND** no cross-cluster endpoint (`host.lima.internal:14317`, `host.lima.internal:14318`) is referenced

#### Scenario: One logs pipeline and no other pipelines

- **WHEN** a reader inspects the `service.pipelines:` block in the log-agent config
- **THEN** exactly one pipeline is declared: `logs`
- **AND** the pipeline's `receivers` list is `[filelog]`
- **AND** the pipeline's `processors` list is `[k8sattributes, batch]` in that order
- **AND** the pipeline's `exporters` list is `[otlp]`
- **AND** no `traces` or `metrics` pipeline is declared

#### Scenario: health_check extension is registered

- **WHEN** a reader inspects the log-agent config
- **THEN** the `extensions:` block declares `health_check: {}`
- **AND** the `service.extensions:` list contains `health_check`

### Requirement: The log-agent container declares liveness and readiness probes against the health_check extension

The log-agent container SHALL declare a `livenessProbe` and a `readinessProbe`, both HTTP GETs against the named `healthcheck` container port (the contrib collector's bundled `health_check` extension on port `13133`). The probes SHALL NOT target an OTLP port (the agent does not expose OTLP; it is a client).

#### Scenario: Both probes target the healthcheck port

- **WHEN** a reader inspects the log-agent container spec in `infra/k8s/base/log-agent/daemonset.yaml`
- **THEN** `livenessProbe.httpGet.port` is the named port `healthcheck` (or its numeric equivalent `13133`)
- **AND** `readinessProbe.httpGet.port` is the same port
- **AND** the path is `/`
- **AND** the container declares a `containerPorts:` entry `name: healthcheck, containerPort: 13133`

### Requirement: Backend pod logs land in obs grafana's Loki end-to-end with k8s attributes as label dimensions

When the app cluster's log-agent DaemonSet is applied, the gateway collector's renamed filter is applied, the obs cluster is up, and the backend pod has emitted at least one structured JSON log line, that log line SHALL appear in obs grafana → Explore → Loki when queried by k8s attributes. The log record SHALL carry `k8s.namespace.name=social`, `k8s.pod.name=backend-*`, `k8s.container.name=backend`, and `k8s.node.name=<the only node>` as label dimensions, and SHALL carry `trace_id` / `span_id` fields matching the same request's span in obs grafana's Tempo datasource.

#### Scenario: Operator queries backend pod logs in obs grafana

- **WHEN** the operator runs `just k8s-apply` against a cluster where the obs cluster is also up
- **AND** the operator runs `just backend-forward` and issues a request that the backend logs at INFO
- **AND** the operator opens obs grafana → Explore → Loki
- **AND** queries `{k8s_namespace_name="social", k8s_container_name="backend"}` (or the chart-driven label-name equivalent)
- **THEN** at least one log entry is returned within 30 seconds
- **AND** the entry's body matches the backend logback line for the same request

#### Scenario: Backend pod log line is byte-equivalent to kubectl logs

- **WHEN** the operator runs `kubectl logs deploy/backend -n social --tail=1` immediately after the backend logs a line
- **AND** queries the same line in obs grafana → Explore → Loki within 30 seconds
- **THEN** the body content of the Loki entry equals the body content of the `kubectl logs` line
- **AND** any structured JSON fields present in `kubectl logs` (timestamp, level, message, trace_id) are also present as attributes on the Loki entry

#### Scenario: Trace correlation works from a Loki entry to its Tempo span

- **WHEN** the operator opens a Loki entry that has a `trace_id` field
- **AND** clicks the "View trace" / trace-link action in grafana
- **THEN** grafana navigates to obs Tempo and renders the trace whose ID matches the log entry's `trace_id`

### Requirement: A `just` recipe surface drives the log-agent lifecycle

The repo-root `justfile` SHALL declare two recipes covering the log-agent's daily verbs: log tailing and rolling restart. Recipe names SHALL follow the `log-agent-<verb>` convention, mirroring the `collector-<verb>` and `obs-collector-<verb>` conventions from earlier slices.

#### Scenario: `just --list` enumerates the log-agent verbs

- **WHEN** an operator runs `just --list` at the repo root
- **THEN** the output includes at least `log-agent-logs` and `log-agent-rollout`

#### Scenario: `log-agent-logs` targets the DaemonSet

- **WHEN** a reader inspects the `log-agent-logs` recipe in `justfile`
- **THEN** the recipe runs `kubectl logs -n social daemonset/log-agent` (or `-l app.kubernetes.io/name=log-agent` equivalent) with a tail / follow flag

#### Scenario: `log-agent-rollout` issues rollout-restart against the DaemonSet and waits

- **WHEN** an operator runs `just log-agent-rollout`
- **THEN** the recipe issues `kubectl rollout restart daemonset/log-agent -n social`
- **AND** waits for the rollout to complete via `kubectl rollout status` before returning

### Requirement: The Hetzner overlay declares a commented stub for the log-agent

The `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL contain a commented stub naming what the Hetzner-deploy slice will add for the log-agent: production resource caps tuned to the multi-node Hetzner box's node count, optional namespace scope widening (with the corresponding Loki retention review), and structured-log volume implications for the obs cluster's Loki PVC sizing. The stub SHALL be comments only — no live resources.

#### Scenario: Hetzner overlay names the log-agent additions a future slice will plug in

- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains commented YAML or commented narrative naming the production resource caps, potential namespace-scope widening, and Loki retention implications the Hetzner slice will weigh for the log-agent
- **AND** none of those declarations are uncommented in this slice

### Requirement: README documents the k3s pod log shipping path

The top-level `README.md` SHALL gain a "k3s pod log shipping" subsection (under the existing "Local observability" / "Log shipping" section) documenting: the agent's namespace scope (`social` only), the apply-once-and-go behavior (the base kustomization already lists `./log-agent`), the expected end-to-end loop (apply → trigger backend traffic → see logs in obs grafana → Explore → Loki), the trace-to-logs correlation in grafana, and the documented non-goals (no `kube-system`, no audit logs, no log-based alerting).

#### Scenario: README has the new subsection

- **WHEN** a reader inspects `README.md`
- **THEN** a subsection titled (or equivalent to) "k3s pod log shipping" exists under the "Local observability" / "Log shipping" tree
- **AND** the subsection names the `social`-only scope
- **AND** the subsection describes the end-to-end loop with copy-pasteable commands (`just k8s-apply`, `just backend-forward`, `just obs-grafana`)

#### Scenario: README documents the non-goals

- **WHEN** a reader inspects the new subsection
- **THEN** an explicit non-goals paragraph names what slice 20 deliberately did not ship (no `kube-system` / `default` namespace scope, no audit logs, no log-based alerting, no retention tuning)

### Requirement: The metrics-agent DaemonSet lives at `infra/k8s/base/metrics-agent/`

A new DaemonSet workload SHALL run one pod per node of the app cluster in the `social` namespace. The directory SHALL contain a kustomization, a DaemonSet manifest, a ConfigMap with the collector pipeline, a ServiceAccount, and an RBAC manifest binding a ClusterRole to the ServiceAccount. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./metrics-agent` in its `resources:` array. The DaemonSet's container image SHALL be `otel/opentelemetry-collector-contrib:0.111.0` — the same pin every other collector in this repository uses (gateway, log-agent, obs collector).

#### Scenario: Base kustomization includes the metrics-agent

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a DaemonSet named `metrics-agent` in the `social` namespace
- **AND** the DaemonSet's pod-spec image is `otel/opentelemetry-collector-contrib:0.111.0`

#### Scenario: DaemonSet schedules on every node

- **WHEN** the cluster has applied the new manifests
- **AND** an operator runs `kubectl --context social -n social get daemonset metrics-agent`
- **THEN** the `DESIRED` and `READY` counts equal the cluster's node count
- **AND** `kubectl --context social -n social get pods -l app.kubernetes.io/name=metrics-agent -o wide` shows one pod per node

### Requirement: The metrics-agent DaemonSet tolerates all taints

The DaemonSet pod-spec SHALL declare `tolerations: [{operator: Exists}]` so that pods schedule on every node including the control-plane-tainted only node of a single-node k3s cluster. The DaemonSet SHALL NOT declare any `nodeSelector` that would narrow placement. The DaemonSet SHALL inject the node name into the pod's environment via the downward API (`spec.nodeName`) under the env var `NODE_NAME` so the `kubeletstats` receiver can dial the local kubelet by name.

#### Scenario: Toleration matches control-plane taint

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/daemonset.yaml`
- **THEN** the pod-spec `tolerations:` list contains an entry with `operator: Exists` and no `key` or `effect`

#### Scenario: NODE_NAME env var is injected

- **WHEN** a reader inspects the pod-spec `env:` list
- **THEN** an entry named `NODE_NAME` SHALL declare `valueFrom.fieldRef.fieldPath: spec.nodeName`

#### Scenario: Pod schedules on a control-plane-only single-node cluster

- **WHEN** the cluster has exactly one node carrying the `node-role.kubernetes.io/control-plane` taint
- **AND** the metrics-agent DaemonSet has been applied
- **THEN** `kubectl get pods -l app.kubernetes.io/name=metrics-agent -n social` shows exactly one Running pod

### Requirement: The metrics-agent ConfigMap declares the kubeletstats + hostmetrics → batch → otlp pipeline

The ConfigMap at `infra/k8s/base/metrics-agent/configmap.yaml` SHALL be named `metrics-agent-config` and SHALL declare a single OpenTelemetry Collector `metrics:` pipeline composed of: a `kubeletstats` receiver scraping `https://${NODE_NAME}:10250`, a `hostmetrics` receiver reading `/proc` and `/sys` from a hostPath mount at `/hostfs`, a `batch` processor, and an `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true`. The pipeline SHALL NOT declare any logs or traces pipelines.

The `kubeletstats` receiver SHALL declare `auth_type: serviceAccount`, `insecure_skip_verify: true`, and a collection interval of 15s.

The `hostmetrics` receiver SHALL declare `root_path: /hostfs` and SHALL enable the scrapers `cpu`, `memory`, `load`, `disk`, `filesystem`, `network`, `paging`, `processes` and SHALL NOT enable the scrapers `process`, `processes_temperature`, `system`. The collection interval SHALL be 15s.

The `health_check` extension SHALL bind to `0.0.0.0:13133` so the kubelet probe can reach it from outside the pod's network namespace.

#### Scenario: Two receivers, one exporter, single pipeline

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/configmap.yaml`
- **THEN** the `service.pipelines.metrics.receivers:` list contains exactly `kubeletstats` and `hostmetrics`
- **AND** the `service.pipelines.metrics.processors:` list contains exactly `batch`
- **AND** the `service.pipelines.metrics.exporters:` list contains exactly `otlp`
- **AND** the `service.pipelines:` block does NOT declare a `logs:` or `traces:` key

#### Scenario: OTLP exporter targets the gateway Service

- **WHEN** a reader inspects the `exporters.otlp:` block
- **THEN** the `endpoint:` is `collector.social.svc.cluster.local:4317`
- **AND** `tls.insecure: true` is declared

#### Scenario: hostmetrics scraper allow-list is explicit

- **WHEN** a reader inspects the `receivers.hostmetrics.scrapers:` block
- **THEN** keys exist for `cpu`, `memory`, `load`, `disk`, `filesystem`, `network`, `paging`, `processes`
- **AND** no keys exist for `process`, `processes_temperature`, or `system`

### Requirement: The metrics-agent ServiceAccount has cluster-scoped read on node stats

A ServiceAccount named `metrics-agent` SHALL exist in the `social` namespace. A ClusterRole named `metrics-agent` SHALL grant `get`, `list`, `watch` on `nodes`, `nodes/stats`, `nodes/proxy`, and `nodes/metrics` in the core (`""`) apiGroup. A ClusterRoleBinding SHALL bind the ClusterRole to the ServiceAccount. The grant SHALL be read-only — no `create`, `update`, `patch`, or `delete` verbs.

The grant is cluster-scoped because the `kubeletstats` receiver dials the local node's kubelet via its node name resolution path, which requires permissions registered at the cluster level even when the kubelet is on the same node as the pod.

#### Scenario: ClusterRole verbs are read-only

- **WHEN** a reader inspects `infra/k8s/base/metrics-agent/rbac.yaml`
- **THEN** every rule's `verbs:` list contains only members of `{"get", "list", "watch"}`
- **AND** no rule references `nodes/log` or `nodes/exec`

#### Scenario: ClusterRoleBinding refers to the correct subjects

- **WHEN** a reader inspects the ClusterRoleBinding manifest
- **THEN** `roleRef.name` is `metrics-agent`
- **AND** `subjects[0].kind` is `ServiceAccount` with name `metrics-agent` in namespace `social`

### Requirement: The metrics-agent container declares health-check probes against the `health_check` extension

The metrics-agent container SHALL declare a `livenessProbe` and a `readinessProbe` that both `httpGet` the `health_check` extension's bind port (`13133`). The probes SHALL declare conservative timings (initialDelaySeconds, periodSeconds, failureThreshold) consistent with the gateway and log-agent collector probes.

#### Scenario: Probes target the health_check extension

- **WHEN** a reader inspects the DaemonSet's `containers[0]` block
- **THEN** `livenessProbe.httpGet.port` and `readinessProbe.httpGet.port` both reference the named port `healthcheck` (or the literal `13133`)
- **AND** the named container port `healthcheck` SHALL declare `containerPort: 13133`

### Requirement: The metrics-agent container declares conservative resource requests and limits

The metrics-agent container SHALL declare `requests: cpu=50m, memory=128Mi` and `limits: cpu=200m, memory=256Mi`. These values match the slice-20 log-agent envelope so operators learn one envelope across both agents.

#### Scenario: Resources are sized like the log-agent

- **WHEN** a reader inspects the DaemonSet pod-spec
- **THEN** the container's `resources.requests` and `resources.limits` equal the slice-20 log-agent's values byte-for-byte

### Requirement: The metrics-cluster-agent Deployment lives at `infra/k8s/base/metrics-cluster-agent/`

A new Deployment workload SHALL run a singleton pod (`replicas: 1`) in the `social` namespace. The directory SHALL contain a kustomization, a Deployment manifest, a ConfigMap with the collector pipeline, a ServiceAccount, and an RBAC manifest. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./metrics-cluster-agent` in its `resources:` array. The Deployment's container image SHALL be `otel/opentelemetry-collector-contrib:0.111.0`.

The Deployment SHALL NOT declare `tolerations:` beyond the cluster default. The Deployment SHALL NOT declare a `nodeSelector` that narrows placement.

#### Scenario: Singleton Deployment exists

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a Deployment named `metrics-cluster-agent` in the `social` namespace
- **AND** the Deployment's `spec.replicas` is `1`

#### Scenario: Deployment does not duplicate cluster-state metrics

- **WHEN** the Deployment has been applied
- **AND** an operator runs `kubectl --context social -n social get pods -l app.kubernetes.io/name=metrics-cluster-agent`
- **THEN** exactly one pod is listed
- **AND** in obs prometheus, the query `count(k8s_deployment_available{deployment="backend"})` returns a single series

### Requirement: The metrics-cluster-agent ConfigMap declares the k8s_cluster → batch → otlp pipeline

The ConfigMap at `infra/k8s/base/metrics-cluster-agent/configmap.yaml` SHALL be named `metrics-cluster-agent-config` and SHALL declare a single OpenTelemetry Collector `metrics:` pipeline composed of: a `k8s_cluster` receiver, a `batch` processor, and an `otlp` exporter targeting `collector.social.svc.cluster.local:4317` with `tls.insecure: true`. The pipeline SHALL NOT declare any logs or traces pipelines.

The `k8s_cluster` receiver SHALL declare `auth_type: serviceAccount`, `collection_interval: 15s`, and `node_conditions_to_report: [Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]`.

The `health_check` extension SHALL bind to `0.0.0.0:13133`.

#### Scenario: One receiver, one exporter, single pipeline

- **WHEN** a reader inspects `infra/k8s/base/metrics-cluster-agent/configmap.yaml`
- **THEN** the `service.pipelines.metrics.receivers:` list contains exactly `k8s_cluster`
- **AND** the `service.pipelines.metrics.processors:` list contains exactly `batch`
- **AND** the `service.pipelines.metrics.exporters:` list contains exactly `otlp`
- **AND** the `service.pipelines:` block does NOT declare a `logs:` or `traces:` key

#### Scenario: All five node conditions reported

- **WHEN** a reader inspects the `receivers.k8s_cluster:` block
- **THEN** `node_conditions_to_report:` is exactly `[Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]`

### Requirement: The metrics-cluster-agent ServiceAccount has cluster-scoped read on apiserver resources

A ServiceAccount named `metrics-cluster-agent` SHALL exist in the `social` namespace. A ClusterRole named `metrics-cluster-agent` SHALL grant `get`, `list`, `watch` on the resource kinds the `k8s_cluster` contrib receiver documents as its minimum: `events`, `namespaces`, `namespaces/status`, `nodes`, `nodes/status`, `persistentvolumeclaims`, `persistentvolumes`, `pods`, `pods/status`, `replicationcontrollers`, `replicationcontrollers/status`, `resourcequotas`, `services` in the core (`""`) apiGroup; `daemonsets`, `deployments`, `replicasets`, `statefulsets` in the `apps` apiGroup; `daemonsets`, `deployments`, `replicasets` in the `extensions` apiGroup; `jobs`, `cronjobs` in the `batch` apiGroup; `horizontalpodautoscalers` in the `autoscaling` apiGroup. A ClusterRoleBinding SHALL bind the ClusterRole to the ServiceAccount.

The grant SHALL be read-only — no `create`, `update`, `patch`, or `delete` verbs.

#### Scenario: ClusterRole covers every receiver-required resource kind

- **WHEN** a reader inspects `infra/k8s/base/metrics-cluster-agent/rbac.yaml`
- **THEN** the rules block enumerates every kind named above with its correct apiGroup
- **AND** every rule's `verbs:` list contains only `get`, `list`, `watch`

#### Scenario: ClusterRoleBinding refers to the correct subjects

- **WHEN** a reader inspects the ClusterRoleBinding manifest
- **THEN** `roleRef.name` is `metrics-cluster-agent`
- **AND** `subjects[0].kind` is `ServiceAccount` with name `metrics-cluster-agent` in namespace `social`

### Requirement: The metrics-cluster-agent container declares health-check probes and conservative resources

The metrics-cluster-agent container SHALL declare `livenessProbe` and `readinessProbe` against the `health_check` extension's port `13133`. The container SHALL declare `requests: cpu=50m, memory=128Mi` and `limits: cpu=200m, memory=256Mi` (matching the metrics-agent and slice-20 log-agent envelopes).

#### Scenario: Probes and resources match the agent envelope

- **WHEN** a reader inspects the Deployment pod-spec
- **THEN** `livenessProbe.httpGet.port` and `readinessProbe.httpGet.port` both reference the named port `healthcheck` (or `13133`)
- **AND** the container's `resources.requests` and `resources.limits` equal the metrics-agent's values byte-for-byte

### Requirement: Cluster metrics land in obs prometheus end-to-end

After the slice is applied, the obs cluster's prometheus SHALL contain at least one sample of `k8s_node_cpu_utilization_ratio` (from the metrics-agent's kubeletstats receiver), at least one sample of `system_memory_usage_bytes` (from the metrics-agent's hostmetrics receiver), and at least one sample of `k8s_deployment_available` (from the metrics-cluster-agent's k8s_cluster receiver), within two scrape intervals (30s) of the agents becoming Ready.

Names carry the unit suffixes the `prometheusremotewrite` exporter appends as part of its OpenMetrics-conformant translation (`_ratio` for ratio-typed metrics, `_bytes` for byte-typed gauges, `_bytes_total` for byte-typed cumulative counters). The OTel-dotted name in v0.111.0 contrib (e.g. `k8s.node.cpu.utilization`) translates to the underscored-plus-suffixed prometheus name (e.g. `k8s_node_cpu_utilization_ratio`).

#### Scenario: Per-node kubeletstats metric is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries the obs prometheus via grafana Explore: `k8s_node_cpu_utilization_ratio`
- **THEN** at least one series is returned with a `k8s_node_name` label matching the cluster's node

#### Scenario: hostmetrics scraper output is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries `system_memory_usage_bytes{state="used"}`
- **THEN** at least one series is returned with a `host_name` label matching the cluster's node

#### Scenario: k8s_cluster cluster-state metric is queryable

- **WHEN** both new pods have been Ready for at least 30s
- **AND** an operator queries `k8s_deployment_available{k8s_deployment_name="backend"}`
- **THEN** exactly one series is returned with a value of `1` (the backend deployment is healthy)

### Requirement: A `cluster-overview` dashboard is provisioned in obs grafana

A grafana dashboard JSON file at `infra/k8s-obs/base/grafana/dashboards/cluster-overview.json` SHALL render rows of panels for nodes, pods, workloads, and PVCs. The dashboard SHALL be loaded automatically via the slice-17 grafana chart's provisioning path so an operator opening obs grafana sees it under Dashboards without manual import.

Panel coverage SHALL include at minimum:
- Node CPU utilization per node (gauge or time-series)
- Node memory used/available per node
- Node load1/load5/load15 per node
- Node filesystem usage by mountpoint
- Node network rx/tx bytes/sec per node
- Per-namespace pod CPU utilization (time-series, summed by namespace)
- Per-namespace pod memory working-set (time-series, summed by namespace)
- Top-N pods by CPU and by memory
- Deployment available replicas (stat panel with thresholds)
- Pod phase distribution by namespace (stacked / bar)
- Container restart count over the last 1h (expected 0)
- Persistent volume capacity (bytes) and used % per pod-mounted volume

All panel PromQL SHALL target OTel-translated metric names with the OpenMetrics-conformant unit suffixes the `prometheusremotewrite` exporter appends (e.g. `k8s_node_cpu_utilization_ratio`, `k8s_pod_memory_working_set_bytes`, `k8s_deployment_available`, `system_network_io_bytes_total`), NOT cAdvisor names (`container_cpu_usage_seconds_total`).

#### Scenario: Dashboard file exists

- **WHEN** a reader runs `ls infra/k8s-obs/base/grafana/dashboards/cluster-overview.json`
- **THEN** the file exists and is valid JSON

#### Scenario: Dashboard visible in obs grafana

- **WHEN** the obs cluster has applied the slice's manifests
- **AND** an operator opens obs grafana at the slice-17 published host port
- **AND** navigates to Dashboards → Browse
- **THEN** a dashboard titled `Cluster overview` is listed without manual import

#### Scenario: Dashboard PromQL targets OTel-translated names

- **WHEN** a reader greps the dashboard JSON for `"expr":`
- **THEN** the expressions reference families starting with `k8s_`, `container_`, or `system_`
- **AND** no expression references `container_cpu_usage_seconds_total` or other Docker-cAdvisor families

### Requirement: A `just` recipe surface drives the metrics-agent and metrics-cluster-agent lifecycle

The repository-root `justfile` SHALL declare four new recipes:

- `metrics-agent-logs`: tail logs from the metrics-agent DaemonSet's pods (follow).
- `metrics-agent-rollout`: restart the metrics-agent DaemonSet and wait on rollout status with a 60s timeout.
- `metrics-cluster-agent-logs`: tail logs from the metrics-cluster-agent Deployment's pod (follow).
- `metrics-cluster-agent-rollout`: restart the metrics-cluster-agent Deployment and wait on rollout status with a 60s timeout.

The recipes SHALL mirror the slice-20 `log-agent-logs` and `log-agent-rollout` recipe shape (same `kubectl` flags, same namespace variable, same timeout) so the four agents (gateway collector, log-agent, metrics-agent, metrics-cluster-agent) share one operator vocabulary.

#### Scenario: Four recipes exist with the expected shape

- **WHEN** a reader runs `just --list`
- **THEN** the list contains `metrics-agent-logs`, `metrics-agent-rollout`, `metrics-cluster-agent-logs`, `metrics-cluster-agent-rollout`

#### Scenario: Rollout recipes wait on status

- **WHEN** a reader inspects the recipe body
- **THEN** the body contains both `kubectl rollout restart` and `kubectl rollout status` with a `--timeout=60s` flag

### Requirement: The Hetzner overlay declares a commented stub for the cluster-metrics agents

The Hetzner overlay at `infra/k8s/overlays/hetzner/kustomization.yaml` SHALL declare a commented block alongside the existing slices' stubs naming the production-side concerns for slice 21: multi-node toleration considerations, leader election for `k8s_cluster` on multi-node clusters, kubelet TLS verification (the local-overlay `insecure_skip_verify: true` MUST NOT be inherited), resource cap re-sizing for a busier cluster, and prometheus PVC / retention re-sizing alongside the higher cluster-metric volume. The stub SHALL be comments only — no live patches.

#### Scenario: Hetzner stub names the production concerns

- **WHEN** a reader inspects `infra/k8s/overlays/hetzner/kustomization.yaml`
- **THEN** the file contains a commented block whose header references `slice 21` or `add-k3s-cluster-metrics`
- **AND** the block names at least: multi-node tolerations, leader election, kubelet TLS verification, resource caps, prometheus retention sizing

### Requirement: README documents the cluster metrics path

The repository README SHALL gain a "Cluster metrics" subsection under the local observability narrative naming the two new agents, the apply order, and the expected end-to-end loop (apply → wait one scrape interval → cluster-overview dashboard populates in obs grafana). The subsection SHALL reference the agent/gateway pattern's continuity with slice 20 and SHALL name the OTel-receiver-side choice over prometheus chart-side scrape jobs.

#### Scenario: README subsection exists

- **WHEN** a reader greps the README for a heading containing `Cluster metrics` (case-insensitive)
- **THEN** exactly one such heading is found
- **AND** the section names both `metrics-agent` and `metrics-cluster-agent`
- **AND** the section names the agent → gateway → obs prometheus path

### Requirement: The postgres-exporter Deployment lives at `infra/k8s/base/postgres-exporter/`

A new Deployment workload SHALL run a single `quay.io/prometheuscommunity/postgres-exporter:v0.17.1` pod in the `social` namespace of the app cluster. The directory SHALL contain a `kustomization.yaml`, a `deployment.yaml`, a `service.yaml`, and a `serviceaccount.yaml`. The image tag pin SHALL match the compose-side service in `docker-compose.yml` so the two exporters emit byte-identical metric families and labels during the parity window. The base kustomization at `infra/k8s/base/kustomization.yaml` SHALL list `./postgres-exporter` in its `resources:` array.

#### Scenario: Base kustomization includes the postgres-exporter

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a Deployment named `postgres-exporter` in the `social` namespace
- **AND** the pod-spec image is `quay.io/prometheuscommunity/postgres-exporter:v0.17.1`
- **AND** the Deployment's `replicas:` is `1`

#### Scenario: Image tag matches the compose-side exporter

- **WHEN** a reader compares the Deployment's image tag with the compose service's image tag at `docker-compose.yml`
- **THEN** the tag string after the colon is identical

### Requirement: The postgres-exporter pod reaches postgres via the in-cluster Service DNS

The pod SHALL load Postgres credentials from the existing `postgres-credentials` Secret in the `social` namespace (the same Secret the backend uses, established in slice 14). The pod SHALL declare `DATA_SOURCE_USER`, `DATA_SOURCE_PASS`, and `DATA_SOURCE_URI` env vars; `DATA_SOURCE_URI` SHALL target `postgres.social.svc.cluster.local:5432/social?sslmode=disable`. The pod SHALL NOT declare any `host.docker.internal` reference (compose-only host-loopback alias).

#### Scenario: Credentials load from the postgres-credentials Secret

- **WHEN** a reader inspects `infra/k8s/base/postgres-exporter/deployment.yaml`
- **THEN** the pod-spec env list declares `DATA_SOURCE_USER` and `DATA_SOURCE_PASS` with `valueFrom.secretKeyRef.name: postgres-credentials`
- **AND** the key names match those the backend Deployment already uses (slice 14)

#### Scenario: DATA_SOURCE_URI targets the in-cluster postgres Service

- **WHEN** a reader inspects the pod-spec env list
- **THEN** the `DATA_SOURCE_URI` value contains `postgres.social.svc.cluster.local:5432`
- **AND** no env or arg references `host.docker.internal`

### Requirement: The postgres-exporter loads the `pg_stat_statements` custom-queries projection via a kustomize-generated ConfigMap

The kustomization at `infra/k8s/base/postgres-exporter/kustomization.yaml` SHALL declare a `configMapGenerator:` entry named `postgres-exporter-queries` sourcing the file `infra/observability/postgres-exporter/queries.yaml` (the compose-side source of truth, which projects `pg_stat_statements` columns into Prometheus metrics — slice 12). The pod SHALL mount the generated ConfigMap at `/etc/postgres-exporter/` and SHALL declare `PG_EXPORTER_EXTEND_QUERY_PATH: /etc/postgres-exporter/queries.yaml`.

#### Scenario: Kustomization generates the queries ConfigMap

- **WHEN** `kustomize build infra/k8s/overlays/local` is run
- **THEN** the rendered output contains a ConfigMap named with the `postgres-exporter-queries-` prefix (kustomize's hash suffix is permitted)
- **AND** the ConfigMap's `data:` map contains a key `queries.yaml` whose value is the content of `infra/observability/postgres-exporter/queries.yaml`

#### Scenario: Pod mounts the queries ConfigMap and reads the extend-query path

- **WHEN** a reader inspects the pod-spec
- **THEN** a `volumes:` entry references the `postgres-exporter-queries` ConfigMap
- **AND** a `volumeMounts:` entry mounts that volume at `/etc/postgres-exporter/`
- **AND** the env list declares `PG_EXPORTER_EXTEND_QUERY_PATH` with value `/etc/postgres-exporter/queries.yaml`

### Requirement: The postgres-exporter Service exposes ClusterIP on port 9187

A `Service/postgres-exporter` SHALL be defined in `infra/k8s/base/postgres-exporter/service.yaml` of type `ClusterIP` exposing port `9187` and selecting the Deployment's pod label. The Service's DNS name `postgres-exporter.social.svc.cluster.local` SHALL be the only address other workloads dial to scrape the exporter; no NodePort or LoadBalancer is required for this slice.

#### Scenario: Service is ClusterIP on 9187

- **WHEN** a reader inspects `infra/k8s/base/postgres-exporter/service.yaml`
- **THEN** the Service's `type:` is `ClusterIP`
- **AND** the `ports:` list contains exactly one entry with `port: 9187`, `targetPort: metrics` (or `9187`), and `protocol: TCP`

#### Scenario: Service selector matches the Deployment's pod label

- **WHEN** a reader inspects the Service's `selector:` block and the Deployment's `spec.template.metadata.labels:` block
- **THEN** every key/value in the Service selector also appears in the Deployment's pod-template labels

### Requirement: The app collector ConfigMap declares a `prometheus` receiver scraping postgres-exporter

The collector ConfigMap at `infra/k8s/base/collector/configmap.yaml` SHALL declare a `prometheus` receiver named `prometheus/postgres-exporter` under `receivers:` configured to scrape `postgres-exporter.social.svc.cluster.local:9187/metrics` every 15s under `job_name: postgres-exporter`. The `metrics:` pipeline SHALL list `prometheus/postgres-exporter` alongside its existing receivers; no other pipeline (`traces:`, `logs:`) SHALL reference the new receiver. The pipeline's exporter list and processor list SHALL be unchanged.

#### Scenario: Receiver block declares the scrape target

- **WHEN** a reader inspects the collector ConfigMap
- **THEN** the `receivers:` block contains an entry named `prometheus/postgres-exporter`
- **AND** the entry declares `config.scrape_configs:` with a single job `postgres-exporter`
- **AND** that job's `static_configs:` lists `postgres-exporter.social.svc.cluster.local:9187` as the only target
- **AND** the job's `scrape_interval` is `15s` and `metrics_path` is `/metrics`

#### Scenario: Receiver joins the metrics pipeline only

- **WHEN** a reader inspects the `service.pipelines.metrics:` block
- **THEN** the `receivers:` list contains `prometheus/postgres-exporter`
- **AND** the `traces:` pipeline's `receivers:` list does NOT contain `prometheus/postgres-exporter`
- **AND** the `logs:` pipeline's `receivers:` list does NOT contain `prometheus/postgres-exporter`

#### Scenario: `pg_*` series arrive at both prometheus instances after the apply

- **GIVEN** the slice has been applied to a running cluster
- **AND** both compose (`:9090`) and obs (`:3001`) prometheus instances are up
- **WHEN** a reader queries `pg_stat_database_numbackends{datname="social"}` against each
- **THEN** both return at least one series with the same value (the fan-out at the gateway delivers the same scrape result to both)

