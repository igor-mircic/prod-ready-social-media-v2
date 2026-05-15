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

A single Kubernetes namespace named `social` SHALL hold every resource the slice deploys (postgres workload, Service, Secret, backend workload). The namespace SHALL be declared at the base `kustomization.yaml` level so every component inherits it.

#### Scenario: Base kustomization declares the namespace and lists every component
- **WHEN** a reader inspects `infra/k8s/base/kustomization.yaml`
- **THEN** the file declares `namespace: social`
- **AND** the file lists `./postgres` under `resources:`
- **AND** the file lists `./backend` under `resources:`

#### Scenario: All slice resources land in the social namespace
- **WHEN** the slice has been applied via `just k8s-apply` and `just backend-apply`
- **AND** an operator runs `kubectl get all -n social`
- **THEN** the postgres StatefulSet, Service(s), Secret, PVC, and the backend Deployment, ReplicaSet, Pod, Service are listed
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

The backend Deployment SHALL set `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://host.docker.internal:4318` (or the documented VM-host-reachable equivalent that the slice settles on) so the in-cluster backend's OTel agent reaches the still-in-compose collector. This is a transitional choice; a future observability-migration slice replaces the target.

#### Scenario: Deployment sets the OTLP endpoint env var
- **WHEN** a reader inspects `infra/k8s/base/backend/deployment.yaml`
- **THEN** a container `env:` entry sets `OTEL_EXPORTER_OTLP_ENDPOINT` to a value whose host is the VM-side alias for the macOS host (`host.docker.internal` or `host.lima.internal`, per the slice's design decision)
- **AND** the value's port is `4318`

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

