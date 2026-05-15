## ADDED Requirements

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

## MODIFIED Requirements

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
