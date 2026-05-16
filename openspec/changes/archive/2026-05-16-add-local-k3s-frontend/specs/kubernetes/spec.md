## ADDED Requirements

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

The frontend pod's nginx config SHALL forward HTTP requests matching path prefixes `/api/` and `/actuator/` to the in-cluster backend ClusterIP Service via the FQDN `backend.social.svc.cluster.local:8080`. All other paths SHALL be served from the static bundle under `/usr/share/nginx/html`, with a single-page-application fallback: any unmatched path under `/` SHALL be served as `/index.html` (HTTP 200) so client-side routes deep-link correctly.

#### Scenario: nginx config forwards `/api/` to the backend Service
- **WHEN** a reader inspects the nginx config baked into the frontend image (e.g. `frontend/docker/nginx.conf`)
- **THEN** a `location /api/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`
- **AND** the block sets at least `proxy_set_header Host $host;`

#### Scenario: nginx config forwards `/actuator/` to the backend Service
- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /actuator/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`

#### Scenario: nginx config serves the SPA fallback
- **WHEN** a reader inspects the nginx config baked into the frontend image
- **THEN** a `location /` block declares `try_files $uri $uri/ /index.html;`

#### Scenario: Pod-to-pod traffic actually reaches the backend
- **WHEN** the frontend and backend Deployments are both applied and Ready
- **AND** an operator port-forwards the frontend Service and issues `curl -sf http://localhost:<port>/actuator/health`
- **THEN** the response is HTTP 200 with body `{"status":"UP"}` (the backend's actuator response), demonstrating the proxy hop succeeded

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

## MODIFIED Requirements

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
