## 1. Local OCI registry and cluster mirror

- [x] 1.1 Add a `registry` service to `docker-compose.yml` (image `registry:2` pinned to a specific tag, bound to `127.0.0.1:5000`, named volume `registry-data` for `/var/lib/registry`, `profiles: [registry]`, `restart: unless-stopped`).
- [x] 1.2 Declare the new `registry-data` named volume in the top-level `volumes:` block of `docker-compose.yml`.
- [x] 1.3 Bring the registry up locally (`docker compose --profile registry up -d registry`) and confirm `curl -sf http://localhost:5000/v2/` returns `{}`. (Note: on macOS with AirPlay Receiver enabled, `localhost` resolves to `::1` first and hits AirPlay's 403; use `http://127.0.0.1:5000/v2/` instead. The slice's Gradle publish URL and README document the IPv4 form for this reason.)
- [x] 1.4 Extend `infra/provisioning/install-k3s.sh` with an idempotent block that writes `/etc/rancher/k3s/registries.yaml` with a `mirrors:` entry rewriting the chosen image-tag hostname to a VM-reachable host-side endpoint, and a `configs:` entry marking that endpoint as `insecure_skip_verify: true`.
- [x] 1.5 In the same provision-script block, restart k3s if and only if the content of `/etc/rancher/k3s/registries.yaml` changed (compare a checksum, or use `cmp`).
- [x] 1.6 Re-provision the Lima VM or apply the new `registries.yaml` manually (`lima shell` → write file → `systemctl restart k3s`) and confirm `kubectl get pods -A` is healthy.
- [x] 1.7 Pin down which hostname pods will reference in their `image:` field (open question in design.md): `registry.local:5000` with a mirror rewrite is the lean. Document the decision in the design.md "Decisions" section with a one-line update.
- [x] 1.8 Validate the chosen VM-host alias resolves from inside a k3s pod (`kubectl run --rm -it --image=busybox:1.36 net-test -- nslookup <alias>`), and if it does not, add `hostAliases` to the backend Deployment (Task 4.7). (Verified 2026-05-16: `host.lima.internal` resolves to `192.168.5.2` from a default-namespace busybox pod, and `wget http://host.lima.internal:5000/v2/` returns `{}`. No `hostAliases` needed.)

## 2. Gradle and image build

- [x] 2.1 Extend the `tasks.named<BootBuildImage>("bootBuildImage")` block in `backend/build.gradle.kts` with `imageName.set(providers.gradleProperty("imageName").orElse("registry.local:5000/backend:dev"))`. (Implementation note: `bootBuildImage` produces `<imageName>-base`; the agent bake step retags as `<imageName>` plus a `127.0.0.1:5000/...` push tag, since the host has no `registry.local` DNS entry.)
- [x] 2.2 Add the `publish.set(...)` and `docker { publishRegistry { url.set(...) } }` configuration so `-Ppublish=true` pushes to `http://localhost:5000`. (Implementation note: `bootBuildImage.publish=false` always; pushing is delegated to a dedicated `pushBackendImage` Exec task that runs only when `-Ppublish=true`, since the buildpack-output base tag is never pushed — only the agent-baked image.)
- [x] 2.3 Decide between the buildpack-binding pattern and the post-build Docker layer for the OTel agent bake (open question in design.md). Document the decision in design.md. (Decision: post-build Docker layer via `backend/docker/agent/Dockerfile` and a Gradle Exec task. Buildpack-bindings would require learning Paketo's BPL/BPE metadata for marginal benefit.)
- [x] 2.4 Implement the chosen agent-baking mechanism: ensure `opentelemetry-javaagent.jar` lands at a stable in-image path (e.g. `/workspace/agent/opentelemetry-javaagent.jar`) and that the image's environment sets `JAVA_TOOL_OPTIONS=-javaagent:<path>`.
- [x] 2.5 Run `./gradlew bootBuildImage` locally and verify with `docker inspect` that (a) the image is `linux/arm64`, (b) `Config.Env` contains the `JAVA_TOOL_OPTIONS=-javaagent:...` entry, and (c) the agent jar exists at the documented path inside the image. (Verified 2026-05-16: arm64/linux, env contains the entry, and `docker run --entrypoint /layers/paketo-buildpacks_bellsoft-liberica/jre/bin/java <image> -version` logs `opentelemetry-javaagent - version: 2.10.0`.)
- [x] 2.6 Run `./gradlew bootBuildImage -Ppublish=true` and verify the push succeeds (`curl -s http://localhost:5000/v2/backend/tags/list` lists `dev`). (Verified 2026-05-16: `curl -s http://127.0.0.1:5000/v2/backend/tags/list` returns `{"name":"backend","tags":["dev"]}`.)

## 3. Kustomize backend base

- [x] 3.1 Create `infra/k8s/base/backend/kustomization.yaml` declaring `resources: [./deployment.yaml, ./service.yaml]`, `labels:` setting `app.kubernetes.io/name: backend` across all generated resources, and matching the slice's namespace convention (inherited from `base/kustomization.yaml`).
- [x] 3.2 Create `infra/k8s/base/backend/service.yaml` declaring a `Service` of `type: ClusterIP`, selector `app.kubernetes.io/name: backend`, port 8080 → targetPort 8080.
- [x] 3.3 Create `infra/k8s/base/backend/deployment.yaml` with: `spec.replicas: 1`; one container named `backend`; `image: registry.local:5000/backend:dev` (or whatever hostname Task 1.7 settles on); `ports: - containerPort: 8080 name: http`; resource requests `cpu: 250m / memory: 512Mi`; resource limits `cpu: 1000m / memory: 1.5Gi`.
- [x] 3.4 Wire the three probes on the backend container per design.md Decision 9: liveness (`/actuator/health/liveness`, `initialDelaySeconds: 30`, `periodSeconds: 10`, `failureThreshold: 3`), readiness (`/actuator/health/readiness`, `periodSeconds: 5`, `failureThreshold: 3`), startup (`/actuator/health/liveness`, `periodSeconds: 5`, `failureThreshold: 30`).
- [x] 3.5 Wire the env block on the backend container: `SPRING_DATASOURCE_USERNAME` and `SPRING_DATASOURCE_PASSWORD` via `valueFrom.secretKeyRef` against `postgres-credentials`; `SPRING_DATASOURCE_URL` set to `jdbc:postgresql://postgres-postgresql.social.svc.cluster.local:5432/social`; `OTEL_EXPORTER_OTLP_ENDPOINT` set to `http://host.docker.internal:4318` (or the alias Task 1.8 settles on). (Implementation note: added a `username` key to `postgres-credentials` Secret so SPRING_DATASOURCE_USERNAME can come from secretKeyRef like the password. OTLP endpoint uses `host.lima.internal:4318` per the slice's alias decision.)
- [x] 3.6 Decide whether to ship `infra/k8s/base/backend/configmap.yaml` or drop the placeholder (open question in design.md). Lean: drop if empty; add it back when a real override appears. (Decision: dropped — every override fits in env vars; no dead resource shipped.)
- [x] 3.7 Update `infra/k8s/base/kustomization.yaml` to append `./backend` to the `resources:` list (`./postgres` stays first).

## 4. Overlay wiring

- [x] 4.1 Update `infra/k8s/overlays/local/kustomization.yaml` to declare a strategic-merge patch that sets the backend container's `imagePullPolicy: Always`.
- [x] 4.2 Confirm that resource caps from the base fit the Lima VM (`postgres` ≈ 1 GiB + `backend` ≤ 1.5 GiB headroom) by running `kubectl top pods -n social` after the first apply; if not, patch caps down in the local overlay. (Verified 2026-05-16: backend at 394Mi / 72m, postgres at 86Mi / 6m — both well below caps; no overlay patch needed.)
- [x] 4.3 Update `infra/k8s/overlays/hetzner/kustomization.yaml` with the commented stub for the backend Hetzner deploy (image source from `ghcr.io/<owner>/backend:<tag>`, `imagePullSecrets`, tighter probe timings, production resource caps, replica count once the second instance is justified). Comments only — no live resources.

## 5. justfile recipes

- [x] 5.1 Add `backend-image` recipe to `justfile`: `docker compose --profile registry up -d registry` then `./gradlew bootBuildImage -Ppublish=true`. Print the resulting image tag after the push.
- [x] 5.2 Add `backend-apply` recipe: `kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl apply -f -` then `kubectl rollout status deploy/backend -n {{PG_NAMESPACE}} --timeout=180s`.
- [x] 5.3 Add `backend-logs` recipe: `kubectl logs -n {{PG_NAMESPACE}} deploy/backend -f`.
- [x] 5.4 Add `backend-forward` recipe: `kubectl port-forward -n {{PG_NAMESPACE}} svc/backend 18080:8080`. Document the 18080 port choice in a recipe comment so the deliberate non-collision with host `:8080` is visible.
- [x] 5.5 Add `backend-delete` recipe: `kubectl delete deploy,svc,cm -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=backend --ignore-not-found`.
- [x] 5.6 Decide whether to add a `backend-rebuild` one-shot recipe (open question). Lean: yes, since it will be the 95% path; defer otherwise. (Decision: yes — added as the 95% path.)
- [x] 5.7 Run `just --list` and confirm the new recipes appear alongside the slice-14 verbs with their inline descriptions.

## 6. End-to-end verification on the Lima VM

- [x] 6.1 From a clean checkout with the Lima VM up: `just backend-image` succeeds; the image is visible at `http://localhost:5000/v2/backend/tags/list`. (Verified 2026-05-16: `curl -s http://127.0.0.1:5000/v2/backend/tags/list` returns `{"name":"backend","tags":["dev"]}`.)
- [x] 6.2 `just backend-apply` succeeds; `kubectl get pods -n social -l app.kubernetes.io/name=backend` shows the pod transitioning Pending → ContainerCreating → Running → Ready within 3 minutes; rollout-status returns 0. (Verified 2026-05-16 after fixing SecurityConfig to allow `/actuator/health/liveness` and `/actuator/health/readiness` — without that allowlist, the startup probe got 401 and the pod restarted in a tight loop.)
- [x] 6.3 `kubectl describe pod` shows the image was pulled from the mirrored endpoint, with no `ErrImagePull` or `ImagePullBackOff` events. (Verified 2026-05-16: pull completes in 285ms, only `Pulling` / `Pulled` events.)
- [x] 6.4 `just backend-forward` (in a second terminal) succeeds; `curl -sf http://localhost:18080/actuator/health` returns `{"status":"UP"}`. (Verified: returns `{"groups":["liveness","readiness"],"status":"UP"}`.)
- [x] 6.5 `curl -sf http://localhost:18080/actuator/health/liveness` and `/readiness` both return `{"status":"UP"}`.
- [x] 6.6 `curl -s http://localhost:18080/actuator/prometheus | head` returns Prometheus text-exposition format with the expected metric families (`hikaricp_*`, `jvm_*`, `http_server_requests_seconds_*`). (Verified: hikaricp_connections, hikaricp_connections_acquire_seconds_* visible immediately.)
- [x] 6.7 With the `observability` compose profile up, generate a few requests (`curl http://localhost:18080/actuator/health` repeated) and verify in Tempo that traces appear with the in-cluster pod's `service.instance.id` (distinct from the host backend's instance id when both run). (Verified: traces visible via `curl 'http://localhost:3200/api/search?tags=service.name%3Dbackend'`; one trace's `service.instance.id=e8a72198-...` confirms in-cluster origin.)
- [x] 6.8 Hit a route that performs a DB query (any controller path that touches a Repository) and verify the pod's logs (`just backend-logs`) show ECS-format JSON entries carrying populated `trace.id` and `span.id`. (Verified: drove signup + login + /me; pod logs contain ECS-shaped lines with `"trace":{"id":"af67b72e..."}` and `"span":{"id":"88b1e02b..."}`. POST /api/v1/auth/login also visible in Tempo as a 169ms backend root span.)
- [x] 6.9 `just backend-delete` followed by `kubectl get all -n social -l app.kubernetes.io/name=backend` returns "No resources found".

## 7. README and documentation

- [x] 7.1 Add a new subsection to `README.md` under "Local k3s cluster" titled "Run the backend in cluster (optional)" explaining the four-recipe flow (`backend-image` → `backend-apply` → `backend-forward` → `backend-logs`) and the side-channel posture.
- [x] 7.2 In the same subsection, restate the explicit non-goal that this does NOT replace `./gradlew bootRun`, e2e tests still target the host backend, and IDE run configurations are unchanged.
- [x] 7.3 Document the registry hostname asymmetry (`localhost:5000` for push, `registry.local:5000` in the manifest) and why it exists, so future readers do not get confused.
- [x] 7.4 Document the `host.docker.internal` (or chosen alias) OTLP transport and call it out as a transitional choice the observability-migration slice will replace.
- [x] 7.5 Update the slice-14 "Local k3s cluster" section's non-goals list to remove "backend not yet in k3s" (the slice closes that non-goal) while keeping "frontend not yet in k3s" and "observability not yet in k3s".

## 8. Validation and archive prep

- [x] 8.1 Run `openspec validate add-local-k3s-backend --strict` and resolve any errors. (Passed: "Change 'add-local-k3s-backend' is valid".)
- [x] 8.2 Run `openspec diff add-local-k3s-backend` and skim for sanity: every requirement added under specs/ should show as additive (or, for the kubernetes `social` namespace requirement, as a MODIFIED replacement). (CLI lacks a `diff` subcommand in this version; reviewed deltas via `openspec show add-local-k3s-backend --type change --deltas-only` — all additive plus the kubernetes `social namespace` MODIFIED requirement, as expected.)
- [x] 8.3 Confirm `git status` is clean except for the slice's expected file set (proposal, design, tasks, three spec deltas, plus the implementation touches once they land).
- [ ] 8.4 After implementation lands and CI passes, archive the change with `openspec archive add-local-k3s-backend --yes` (per the OpenSpec apply-to-archive autonomous flow).
