## Why

Slice 14 moved postgres into a Lima-hosted single-node k3s cluster but left the Spring Boot backend running on the macOS host. The cluster therefore hosts one stateful workload and zero application workloads, and the next planned step — eventual Hetzner deploy — has no live image-build, image-distribution, or Deployment pattern to land on. Until the backend has a path into k3s, every later concern (observability migration, frontend in-cluster, Hetzner overlay) is theory. This slice introduces the smallest end-to-end "application in k3s" loop — build the backend with Spring Boot buildpacks, publish it through a local OCI registry, and run it as a Deployment that talks to the in-cluster postgres and the still-in-compose OTel collector — while keeping the host `./gradlew bootRun` dev loop unchanged. The k3s backend is a *side-channel* opt-in, not a replacement, so the slice is bounded and reversible.

## What Changes

- **Local OCI registry as a new `docker-compose.yml` service** named `registry` (image `registry:2`, bound to `localhost:5000`, named volume for layer storage). Hidden behind a new `registry` compose profile so it does not auto-start with default services. The `just backend-image` recipe brings the profile up implicitly.
- **k3s `registries.yaml` configuration via the shared provision script** so the cluster trusts the host-side registry as a mirror. The `infra/provisioning/install-k3s.sh` script gains an idempotent step that drops `/etc/rancher/k3s/registries.yaml` and reloads k3s. The mirror entry rewrites `registry.local:5000` to the host-reachable address inside the Lima VM.
- **Spring Boot buildpacks wiring in `backend/build.gradle.kts`** — the existing `bootBuildImage` task gets `imageName` pointed at `registry.local:5000/backend:dev` (overridable via a project property so Hetzner overrides cleanly), a `publish: true` block targeting the unauthenticated local registry, and a layer/binding that drops `opentelemetry-javaagent.jar` into the image with `JAVA_TOOL_OPTIONS=-javaagent:...` pre-set. Mirrors how host dev attaches the agent today.
- **New `infra/k8s/base/backend/` Kustomize directory** containing:
  - `kustomization.yaml` listing the slice's resources, default labels (`app.kubernetes.io/name=backend`), and a default image tag that the local overlay overrides as needed.
  - `deployment.yaml` declaring a single-replica `backend` Deployment that mounts the existing `postgres-credentials` Secret for `SPRING_DATASOURCE_USERNAME` / `SPRING_DATASOURCE_PASSWORD`, sets `SPRING_DATASOURCE_URL` at the in-cluster ClusterIP DNS name (`postgres-postgresql.social.svc.cluster.local:5432`), and sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` so the agent reaches the host-side collector. Liveness probe `/actuator/health/liveness`, readiness probe `/actuator/health/readiness`, startupProbe with a JVM-friendly grace window so the pod survives Flyway + bean wiring before failing.
  - `service.yaml` — ClusterIP `:8080` (no LoadBalancer; access is via `kubectl port-forward`).
  - `configmap.yaml` — placeholder for `application.yaml` overrides that do not fit cleanly into env vars (small in this slice; may stay empty).
- **`infra/k8s/base/kustomization.yaml` updated** to include `./backend` alongside the existing `./postgres`.
- **`infra/k8s/overlays/local/kustomization.yaml` updated** with `imagePullPolicy: Always` patched onto the backend Deployment so iterating on the `:dev` tag picks up new pushes. Resource caps from base may be patched down here if the Lima VM's remaining headroom (~7 GiB after postgres) warrants it.
- **`infra/k8s/overlays/hetzner/kustomization.yaml`** gains a commented stub block listing what the Hetzner backend deploy will add (ghcr.io image reference, `imagePullSecrets`, production resource caps, tighter probe timings, replicas). No live resources.
- **`justfile` recipes added** for the backend k3s loop:
  - `backend-image` — boots the `registry` compose profile, runs `./gradlew bootBuildImage`, pushes to the local registry, prints the resulting digest.
  - `backend-apply` — `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -` then `kubectl rollout status deploy/backend -n social --timeout=180s`.
  - `backend-logs` — `kubectl logs -n social deploy/backend -f`.
  - `backend-forward` — `kubectl port-forward -n social svc/backend 18080:8080` so a developer can hit `http://localhost:18080/actuator/health`.
  - `backend-delete` — removes the Deployment, Service, and ConfigMap by `app.kubernetes.io/name=backend` label.
- **`README.md`** gains a new subsection under "Local k3s cluster" titled "Run the backend in cluster (optional)" describing the build → push → apply → forward flow, the side-channel posture, and the explicit non-goal that this does NOT replace `./gradlew bootRun`. The non-goal is restated so a fresh reader does not infer the host loop is deprecated.

Explicit non-goals:

- **No Ingress, no DNS, no TLS.** The Traefik-vs-ingress-nginx decision deferred in slice 14's design.md stays deferred; the slice ships only a ClusterIP Service and a `kubectl port-forward` recipe.
- **No removal of the host `./gradlew bootRun` loop.** The e2e harness, the IDE run configurations, and the README's existing "Run the backend" section are untouched. The k3s backend is opt-in.
- **No observability stack migration into k3s.** Prometheus, Grafana, Tempo, Loki, OTel collector all stay in docker-compose. The in-cluster backend reaches the collector via `host.docker.internal:4318`, symmetric with the `postgres-exporter` retarget from slice 14.
- **No Hetzner overlay live resources for backend.** A commented stub planted in `overlays/hetzner/` is the only output; the next slice fills it.
- **No frontend in k3s, no CI job that exercises the k3s deploy.** Existing CI continues to use docker-compose for tests; the k3s deploy is dev-only for now.
- **No image signing (cosign), no SBOM publication, no NetworkPolicy, no HPA, no PodDisruptionBudget, no JVM tuning beyond resource requests/limits.** Each is a follow-up consideration; none is needed for the smallest end-to-end loop.
- **No multi-replica.** Single replica is fine because the cluster is single-node and the workload is dev-only.

## Capabilities

### New Capabilities

(none — `kubernetes` was introduced by slice 14 and is the natural home for the backend Deployment requirements.)

### Modified Capabilities

- `kubernetes` — adds requirements covering: (a) the local OCI registry as the image-distribution path, (b) the k3s `registries.yaml` mirror configuration via the provision script, (c) the backend Deployment shape (image source, env from `postgres-credentials` Secret, OTLP target, ClusterIP exposure, JVM-aware probes), and (d) the backend's Kustomize base + local-overlay patch layout.
- `monorepo-layout` — extends the `infra/k8s/base/` sibling list with a new `backend/` directory and re-states the `helmCharts:`-coexists-with-plain-resources convention now that the slice introduces the first plain-resource Deployment.
- `observability` — modifies the OTLP transport requirement: an in-cluster backend SHALL send OTLP to `http://host.docker.internal:4318` rather than `http://localhost:4318`, while the host-run backend's behavior is unchanged. Additive note — no existing requirement is removed.

## Impact

- **Affected files / directories:**
  - `infra/k8s/base/backend/kustomization.yaml`, `deployment.yaml`, `service.yaml`, `configmap.yaml` (new)
  - `infra/k8s/base/kustomization.yaml` — appends `./backend` to `resources:`
  - `infra/k8s/overlays/local/kustomization.yaml` — adds a strategic-merge patch for `imagePullPolicy: Always` and (conditionally) resource caps
  - `infra/k8s/overlays/hetzner/kustomization.yaml` — appends a commented stub block for the Hetzner backend deploy
  - `infra/provisioning/install-k3s.sh` — appends an idempotent block that writes `/etc/rancher/k3s/registries.yaml` and restarts k3s
  - `docker-compose.yml` — new `registry` service under a new `registry` compose profile; new named volume
  - `backend/build.gradle.kts` — extends the existing `tasks.named<BootBuildImage>("bootBuildImage")` block with `imageName`, `publish`, and an OTel-agent baking mechanism (chosen at implementation time; see design.md)
  - `justfile` — five new recipes (`backend-image`, `backend-apply`, `backend-logs`, `backend-forward`, `backend-delete`)
  - `README.md` — new "Run the backend in cluster (optional)" subsection
- **New tool dependencies:**
  - No new host dependencies. `docker` (already required for compose), `kubectl` and `helm` (already required for slice 14), `gradlew` (already vendored) cover everything.
  - The `registry:2` Docker image is the only new container image; pinned to an explicit tag.
- **Dependencies on external services:**
  - The Bitnami chart pull continues to require network on first apply (unchanged from slice 14).
  - The OTel Java agent JAR continues to be resolved through the existing Gradle `agent` configuration (unchanged from slice 4-onwards).
- **CI:** no new CI jobs. The k3s flow is dev-only; CI continues using the existing docker-compose-based test surface. A future slice may add a Lima + k3s smoke test once the deploy is touched by enough other slices to justify the runtime cost.
- **Compatibility:** additive. Anyone who pulls this branch and never runs `just backend-image` sees no behavior change to the host dev loop. Running `docker compose up` without the `registry` profile leaves the new service dormant.
- **Rollback:** `git revert` the merge. The new compose service, k8s manifests, justfile recipes, and Gradle wiring disappear; the host loop and slice 14's postgres-in-k3s are untouched. The named registry volume is preserved on disk but unreferenced and can be deleted with `docker volume rm` if desired.
