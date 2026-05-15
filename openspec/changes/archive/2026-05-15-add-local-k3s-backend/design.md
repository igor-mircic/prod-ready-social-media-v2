## Context

Slice 14 (`add-local-k3s-postgres`) stood up a single-node k3s cluster inside a Lima VM and migrated the dev postgres into it. The slice's design.md was explicit about what would come next: "every subsequent slice — backend image build, observability migration, Hetzner deploy — has a real cluster to land on instead of a paper plan." Slice 14 also deliberately deferred two decisions to "the slice that needs them first": the ingress story (Traefik-vs-nginx) and the secret-management story (plain Secret vs. SOPS / Sealed Secrets / External Secrets). Backend-in-k3s touches the first one (the backend is the first non-stateful workload and therefore the first plausible ingress consumer) and brushes the second (the backend reads the existing postgres-credentials Secret but does not introduce new secret material).

The backend's current shape constrains the slice. It is Spring Boot 3.x on Java 21, structured logs in ECS JSON format, Micrometer Prometheus, OTel Java agent attached via `-javaagent:` (built and copied by `build.gradle.kts`'s `copyOtelAgent`-style task to `build/otel/opentelemetry-javaagent.jar` and `build/libs/opentelemetry-javaagent.jar`). The host dev loop is `./gradlew bootRun` and the e2e harness in `e2e/src/setup/backend.ts` spawns the same jar with the agent attached. All thirteen observability slices were built around this attach-the-agent-via-JVM-flag assumption. Any move into a container has to preserve that assumption or rewire every observability dashboard, alert, and exemplar mapping that depends on the agent's OTLP output.

The Lima VM has a fixed envelope: 4 vCPU, 8 GiB RAM, 64 GiB disk, arm64. Postgres consumed ~1 GiB of that envelope in slice 14. The backend pod must fit comfortably in the remaining headroom while still leaving room for any other workloads that land in subsequent slices (collector, frontend). The CAX21 Hetzner box has the same 4 vCPU / 8 GiB envelope, so any resource decision made for the local backend pod transfers 1:1 to production — which is a feature, not an accident.

The image-distribution question has no "obvious" default. macOS-built images do not appear in the Lima VM's containerd cache automatically. Production-real options range from a local OCI registry (a `registry:2` container) to remote (ghcr.io) to import-by-tarball. The slice has to pick one whose shape transfers to the Hetzner overlay with a small edit, not a rewrite.

## Goals / Non-Goals

**Goals:**

- Build the Spring Boot backend into an OCI image using Spring Boot's bundled buildpacks support (`bootBuildImage`), preserving the existing OTel agent attach pattern by baking the agent into the image.
- Stand up a local OCI registry as a docker-compose service so the host can `docker push` images and the k3s VM can pull them, configured so the in-VM `containerd` mirror rewrite is the single piece of cluster configuration that varies between local and Hetzner.
- Deploy the backend into the `social` namespace as a Deployment + ClusterIP Service, with environment configured to talk to (a) the in-cluster postgres via the `postgres-postgresql.social.svc.cluster.local:5432` ClusterIP DNS name and (b) the still-in-compose OTel collector via `host.docker.internal:4318`.
- Provide a small `just` verb surface that wraps the build / push / apply / forward / logs / delete loop so a developer never has to remember the underlying `kubectl` / `docker` invocations.
- Keep the host `./gradlew bootRun` loop unchanged so the slice is opt-in and easily reverted.
- Plant the Hetzner overlay seed (commented stub) so the next slice (Hetzner deploy) lands on a known-shaped surface.

**Non-Goals:**

- Migrating the host dev loop into k3s. The k3s backend is a side-channel, not a replacement. e2e tests continue to target the host backend; the IDE run configurations continue to work; the README's "Run the backend" section is untouched.
- Adding an Ingress, DNS, or TLS termination to the backend. Access is via `kubectl port-forward`.
- Migrating any observability stack component (Prometheus, Grafana, Tempo, Loki, OTel collector) into k3s. They stay in docker-compose; the in-cluster backend reaches the collector via `host.docker.internal:4318`.
- Provisioning the Hetzner box, or putting live resources into `overlays/hetzner/`.
- Image signing, SBOM publication, image scanning, registry authentication, NetworkPolicy, HPA, PodDisruptionBudget, JVM tuning beyond resource requests/limits, multi-replica.
- Adding a CI job that exercises the k3s deploy. CI continues using compose-based tests.
- Decoupling the OTel agent version from the application image (initContainer / OTel Operator patterns). Out of scope for this slice; revisit when version-pinning the agent independently from the app becomes a real need.

## Decisions

### Decision 1 — Spring Boot buildpacks (`bootBuildImage`), not Jib and not a hand-written Dockerfile

Spring Boot 3.x ships first-class support for building OCI images via Paketo buildpacks under the `bootBuildImage` Gradle task. The buildpack produces a layered image with a CDS-friendly layout (the Spring layertools split: dependencies, spring-boot-loader, snapshot-dependencies, application), automatically picks the right JDK version from the Gradle toolchain (Java 21 in this project), and emits arm64-native images on Apple Silicon hosts.

Rejected:

- **Jib (Google's build-image-without-Docker-daemon plugin).** Faster on cold caches; produces distroless images. Two drawbacks: (a) the project's existing OTel agent baking story is meaningfully harder with Jib (Jib's `extraDirectories` works but is fragile against image-layer ordering), and (b) Spring's CDS / AOT optimizations are first-class with buildpacks and second-class with Jib. The first-class path is the lower-friction one.
- **Hand-written multistage Dockerfile.** Maximum control; minimum reproducibility. Anyone touching the Dockerfile has to remember the JRE version, the user/uid, the layer order, the entrypoint script. Buildpacks remove every one of those concerns; that is their value.

Concrete configuration in `backend/build.gradle.kts`:

```kotlin
tasks.named<BootBuildImage>("bootBuildImage") {
    imageName.set(providers.gradleProperty("imageName").orElse("registry.local:5000/backend:dev"))
    publish.set(providers.gradleProperty("publish").map { it.toBoolean() }.orElse(false))
    docker {
        publishRegistry {
            url.set(providers.gradleProperty("publishRegistry").orElse("http://localhost:5000"))
        }
    }
    // OTel agent baking: see Decision 5
}
```

The `imageName` defaults to the local registry tag but can be overridden via `-PimageName=...` for the Hetzner overlay (which will push to `ghcr.io/<owner>/backend:<tag>`).

### Decision 2 — Local OCI registry as a docker-compose service, k3s configured as a mirror

The cluster has to get the image from somewhere. The slice picks a local OCI registry running as a `registry:2` container in `docker-compose.yml`, behind a new `registry` compose profile. The host pushes to `localhost:5000`; the cluster pulls from the same image reference but resolves it through a `registries.yaml` mirror entry that rewrites `registry.local:5000` (or whichever hostname the image tag uses) to the host-reachable address inside the VM.

This shape transfers 1:1 to the Hetzner overlay: the local `registry:2` becomes `ghcr.io/<owner>`, the cluster's `registries.yaml` is replaced with an `imagePullSecrets` reference, and nothing else changes. The Deployment spec is registry-agnostic; the registry-selection lives in cluster config (local) or pod config (production).

Rejected:

- **`ctr image import` after `docker save`.** Works for one-off deploys, terrible inner loop — each iteration requires building, saving to a tarball, `limactl copy` into the VM, `k3s ctr images import`. Five seconds of human time per iteration is enough to ruin the slice's ergonomics.
- **nerdctl inside the VM (build directly in the cluster's containerd).** Tight inner loop; the macOS host never sees the image (a downside for sanity-checks like `docker run --rm <image> --help`). Also drifts from the Hetzner story, where the build happens in CI and the cluster pulls from a remote registry.
- **ghcr.io from day one.** Production-real, but requires GitHub Actions or `gh auth` flows on every dev iteration; the inner loop runs over the public internet; pushing test images to a public registry leaks WIP. Reserved for Hetzner.

Compose service shape (sketch — exact YAML at implementation time):

```yaml
registry:
  image: registry:2
  profiles: [registry]
  ports: ["127.0.0.1:5000:5000"]
  volumes: [registry-data:/var/lib/registry]
  restart: unless-stopped
```

Cluster-side `registries.yaml` (placed by the provision script at `/etc/rancher/k3s/registries.yaml`):

```yaml
mirrors:
  "registry.local:5000":
    endpoint:
      - "http://host.lima.internal:5000"
configs:
  "host.lima.internal:5000":
    tls:
      insecure_skip_verify: true
```

The exact "what is the host's IP from inside the VM" detail (`host.lima.internal`, `host.docker.internal`, or a `/etc/hosts`-injected `registry.local`) is the open question called out below; the *shape* is settled.

**Decision update (slice implementation, 2026-05-16):** the pull-side hostname pods reference in their `image:` field is `registry.local:5000`. The `registries.yaml` mirror rewrite resolves it to `http://host.lima.internal:5000` — Lima's native host-resolver alias, which routes to the host loopback (where `127.0.0.1:5000` is bound). Push uses `127.0.0.1:5000` (not `localhost:5000`) because macOS's AirPlay Receiver squats on `::1:5000` and steals IPv6 traffic to `localhost` before it reaches the registry container.

### Decision 3 — Ingress is out of scope; access is via `kubectl port-forward`

Slice 14's design.md called out Traefik-vs-ingress-nginx as a future decision triggered by "the first workload that needs an Ingress object". The backend *could* be that workload, but it does not *have* to be — the slice's purpose is to land the application-in-k3s loop, and adding an ingress object doubles the surface to get wrong while not making the slice any more useful (the host loop already serves on `localhost:8080`; the k3s backend only needs to be reachable for debugging).

The slice ships:

- `Service` of type `ClusterIP` on port 8080.
- A `just backend-forward` recipe that runs `kubectl port-forward -n social svc/backend 18080:8080`. Port 18080 is intentionally chosen to avoid colliding with a running `bootRun` on 8080.

The Traefik-vs-nginx decision is rolled forward to the slice that introduces the *frontend* in k3s, or to a dedicated ingress-strategy slice — whichever comes first.

Rejected: a klipper-lb `LoadBalancer` Service on `:8080` paired with a Lima portForward. That works but pollutes the host's `:8080` port (which the host backend already uses) and locks in the choice. Port-forward is opt-in and ephemeral.

### Decision 4 — Backend stays opt-in; host `bootRun` loop is unchanged

The k3s backend is a *side-channel*. The host loop remains the canonical dev experience and the e2e harness target. There are three reasons:

- The observability stack still lives in compose. A cutover to k3s-as-dev-loop before observability migrates means dashboards and exemplars break for everyone running the slice. Decoupling those concerns prevents the slice from blocking observability work.
- The e2e harness in `e2e/src/setup/backend.ts` spawns the backend as a host JVM. Rewriting it to target a k3s Service would require port-forward orchestration, pod-readiness gating, and a separate teardown path. That is a slice of its own.
- The slice is reversible. Anyone who does not run `just backend-image` sees zero behavior change to their normal dev experience.

Mechanism: every new entry point (justfile recipes, README section) is explicitly labelled "optional" / "side-channel" so the next contributor reading the docs cannot infer that the host loop is deprecated.

### Decision 5 — Bake the OTel agent into the image, not initContainer-mount

Every observability slice from 4 onward depends on the OTel Java agent attaching at JVM startup via `-javaagent:`. The host dev loop and the e2e harness both attach the agent the same way — by reading `build/otel/opentelemetry-javaagent.jar` or `build/libs/opentelemetry-javaagent.jar` from the local filesystem. The slice picks the option that preserves that exact attach pattern at the cost of slight image bloat.

The agent jar is added to the image during `bootBuildImage` and the image's environment sets `JAVA_TOOL_OPTIONS=-javaagent:/workspace/agent/opentelemetry-javaagent.jar` so the agent attaches automatically. Two viable mechanics exist for the bake step:

- **Paketo binding** under `bindings/otel-agent/`. Buildpacks expose a `BPL_*` / binding mechanism for runtime artifacts; the cleanest path is to publish the agent as a binding and reference it from `BPE_*` environment-setter buildpack metadata.
- **Post-build Docker layer.** After `bootBuildImage` produces the OCI image, a follow-up `docker build` step adds a `FROM` line referencing the buildpack output, `COPY`s the agent jar into `/workspace/agent/`, and sets `ENV JAVA_TOOL_OPTIONS=-javaagent:/workspace/agent/opentelemetry-javaagent.jar`. Less elegant but more obvious to a reader who is not deep in buildpack internals.

The slice picks one of the two at implementation time; both are acceptable. The design rule is "preserve the agent attach mechanic from the host loop, do not introduce sidecar / initContainer / Operator complexity." See open questions for which path is chosen.

**Decision update (slice implementation, 2026-05-16):** post-build Docker layer wins. Implementation: a checked-in `backend/docker/agent/Dockerfile` declares `FROM ${BASE_IMAGE}` + a plain `COPY opentelemetry-javaagent.jar /workspace/agent/opentelemetry-javaagent.jar` + `ENV JAVA_TOOL_OPTIONS=-javaagent:...`; Gradle's `bootBuildImage` task is configured to produce `<imageName>-base`, and a follow-up `bakeBackendImage` Exec task runs `docker build` against that Dockerfile with `--build-arg BASE_IMAGE=<imageName>-base`. The Paketo base is distroless (no `/bin/sh`), so RUN steps are not available — the bake is COPY+ENV only. `COPY --chmod=` is deliberately NOT used: BuildKit applies that mode to intermediate directories it creates, which would render `/workspace/agent/` unreadable (0644 on a directory blocks JVM traversal); plain COPY leaves the directory at 0755 and the file at 0644.

Rejected:

- **initContainer pattern** (init container copies the agent jar into a shared emptyDir; the main container reads it). Decouples agent version from app image at the cost of two surfaces (init container image, main container env) that both have to be correct. Buys nothing for slice 15 because the agent is already managed by Gradle.
- **OTel Operator with autoinstrumentation CRD.** The right answer eventually for a cluster with many JVM workloads; massive overkill for a single Deployment. Captured as a future spike.

### Decision 6 — In-cluster backend OTLPs to `host.docker.internal:4318`

The OTel collector still lives in docker-compose. The in-cluster backend must reach it. The slice picks `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` — the same loopback-to-host idiom slice 14 used for `postgres-exporter`. Symmetric, well-understood, easy to override when the collector moves.

The choice is *temporary*. The slice that migrates observability into k3s will replace this env value with an in-cluster Service DNS name (`otel-collector.observability.svc.cluster.local:4318` or similar) and the design will revisit the same question for every other workload that picks it up in the meantime. The slice's commit body and README note the temporary nature.

Rejected:

- **A thin in-k3s OTel collector that fans out to the host collectors.** Cleaner long-term but introduces a piece of observability infrastructure that the slice cannot also migrate (Prom / Grafana / Tempo / Loki are still in compose), so the slice would end up with a partial collector. Defer.
- **Skipping OTel for the in-cluster backend.** Loses all observability for the in-cluster path; defeats the slice's "the in-cluster backend is a real workload" framing.

### Decision 7 — Hetzner overlay seed for backend: commented stub, no live resources

Slice 14 planted an empty `overlays/hetzner/kustomization.yaml`. This slice appends a *commented stub* listing what the Hetzner backend deploy will add: a real image reference (`ghcr.io/<owner>/backend:<digest>`), `imagePullSecrets`, production resource caps (likely `requests: 1Gi / 0.5`, `limits: 2Gi / 1`), tighter probe timings, possibly replicas: 2 once a second node exists or once the CAX21 envelope is comfortable with two Spring Boots side by side. The stub is YAML comments only — `kubectl apply` against `overlays/hetzner/` produces a no-op deploy that still inherits the namespace and postgres/backend from `base/`.

The point of the stub is not to ship configuration; it is to ship *intent* so the next slice knows exactly where the additions go. The same pattern slice 14 used.

### Decision 8 — `justfile` recipe surface and naming

The slice adds five recipes. Names match slice 14's verb-first convention:

- `backend-image` — wraps `docker compose --profile registry up -d registry` → `./gradlew bootBuildImage -Ppublish=true` → optional confirmation print of pushed digest. The `--profile registry` ensures the registry comes up implicitly when a developer first runs the recipe; subsequent runs see it already running and the compose call is a no-op.
- `backend-apply` — `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -` then `kubectl rollout status deploy/backend -n social --timeout=180s` (rollout-status gates the recipe on the new pod becoming Ready, avoiding the "apply returned and the user immediately checks logs but the pod is still pulling" race).
- `backend-logs` — `kubectl logs -n social deploy/backend -f`.
- `backend-forward` — `kubectl port-forward -n social svc/backend 18080:8080`.
- `backend-delete` — `kubectl delete deploy,svc,cm -n social -l app.kubernetes.io/name=backend`. Scoped to label so a future per-backend ConfigMap (or any other backend-labelled resource) is included automatically.

Optionally, a `backend-rebuild` one-shot that runs `backend-image` + `backend-apply` may ship for ergonomics. Captured as an open question because if added it is the recipe developers will use 95% of the time and the others become rarely-typed primitives — worth getting the name right.

### Decision 9 — Probes, resource caps, and image-pull policy

Probes:

- `livenessProbe`: HTTP GET on `/actuator/health/liveness`, initialDelay 30s, period 10s, failure threshold 3. Survives transient HTTP 500s but kills wedged JVMs.
- `readinessProbe`: HTTP GET on `/actuator/health/readiness`, initialDelay 0s (the startupProbe handles cold-start grace), period 5s, failure threshold 3.
- `startupProbe`: HTTP GET on `/actuator/health/liveness`, initialDelay 10s, period 5s, failure threshold 30 (≈150 s grace for cold JVM + Flyway). Spring Boot's ApplicationAvailability framework wires `/readiness` to flip green only after Flyway and bean wiring complete, so the readinessProbe correctly gates traffic on Flyway completion *without* the slice needing a custom init Job. Confirm this behavior at implementation time.

Resource caps (initial guess, refine at implementation time):

- `requests: cpu=250m, memory=512Mi`
- `limits: cpu=1000m, memory=1.5Gi`

The 1.5Gi memory limit gives the JVM ~1Gi heap room with overhead for metaspace + native + the OTel agent. The CPU request is small to share well with the postgres pod; the limit allows a burst during startup. Numbers transfer 1:1 to the Hetzner overlay.

Image-pull policy:

- `local` overlay: `imagePullPolicy: Always` so iterating on the `:dev` tag picks up new pushes without a digest swap.
- `hetzner` overlay (future): `imagePullPolicy: IfNotPresent`, image reference includes the digest, so deploys are idempotent and reproducible.

### Decision 10 — Service DNS naming for postgres from the backend

Slice 14's postgres is exposed by both a chart-bundled ClusterIP Service named `postgres-postgresql` (Bitnami naming) and a sidecar LoadBalancer Service named `postgres-lb` (slice 14's choice). The in-cluster backend SHALL talk to the chart-bundled ClusterIP Service, not the LoadBalancer:

```
SPRING_DATASOURCE_URL=jdbc:postgresql://postgres-postgresql.social.svc.cluster.local:5432/social
```

The LoadBalancer is for the host loop (and any host process) only. Using the ClusterIP Service from the in-cluster backend is the right shape because (a) it avoids an unnecessary trip through klipper-lb, (b) it works identically on Hetzner where the LB-IP allocation will differ, and (c) it documents intent — "this connection stays inside the cluster".

The hostname is verbose (`postgres-postgresql.social.svc.cluster.local`) but explicit. Kubernetes' search-domain resolution would let it shorten to `postgres-postgresql`; the slice ships the long form for readability and to match what the Hetzner overlay will use unchanged.

## Risks / Trade-offs

- **`host.docker.internal` resolution from inside the Lima VM is not Docker-Desktop-symmetric.** Compose containers resolve `host.docker.internal` via Docker Desktop's loopback shim; the VM may need `host.lima.internal` or a `hostAliases` block. → Pinned via the provision script's `registries.yaml` config and (if needed) a `/etc/hosts` mutation. Documented in design.md's open questions; confirmed at implementation.

- **Image bloat from the baked OTel agent (~25 MiB).** The agent ships uncompressed-uncacheable; layered correctly it adds one small image layer. → Acceptable for a dev image. The future "decouple agent version from app image" spike (initContainer or Operator) addresses this if it ever matters.

- **Registry hostname asymmetry (`localhost:5000` for `docker push` from host, `registry.local:5000` in the image tag, `host.lima.internal:5000` from the VM via mirror rewrite).** Each leg works but a reader has to hold three names in their head. → Documented in README; the open-question section commits to picking *one* of these flows at implementation time and reducing the count.

- **`kubectl port-forward` is a long-running foreground process.** Anyone running `just backend-forward` discovers it does not background. → Documented; expected behavior; trivial wrapper if developers want backgrounding.

- **The OTel agent in the image is pinned to whatever version `agent` config resolves at build time.** Updating the agent now requires rebuilding the image, not just restarting the JVM. → Accepted for slice 15. The future initContainer / Operator spikes solve this if it becomes painful.

- **Flyway runs in-pod on every startup.** If a migration fails, the pod's readinessProbe never goes green and the rollout-status `just backend-apply` times out at 180s. → Honest failure mode; the developer sees a stuck rollout and inspects logs. A future "extract migrations to a Job before backend rolls" pattern is a known production-grade move; out of scope for slice 15.

- **Pod-to-Service-to-pod traffic flows through klipper-lb only for LoadBalancer Services; ClusterIP traffic goes via iptables.** Slice 15 uses ClusterIP for postgres, so klipper is not in the data path; good. → No risk; called out only because it differs from the host loop's "everything goes through Lima portForward".

- **The local registry container has no auth.** Anyone on the host network can push to it. → Bound to `127.0.0.1:5000` (not `0.0.0.0:5000`) in the compose service to limit exposure; documented.

- **`bootBuildImage` requires Docker daemon access.** Anyone running it under Colima / Podman Desktop / Rancher Desktop may hit subtle compatibility issues with Paketo's `pack` invocation. → Project standardizes on Docker Desktop per slice 14's note; revisit if a contributor uses another engine.

- **Multi-component slice surface.** The slice touches Gradle, compose, k8s manifests, provision script, justfile, and README. Same risk-mitigation as slice 14: tasks.md sequences the work so each stage is independently verifiable.

## Migration Plan

This slice is opt-in. There is no "migration" required of an existing developer; running `git pull` does not change behavior until the developer explicitly runs `just backend-image`.

**For a developer who wants to try the k3s backend:**

1. `git pull` to land the slice.
2. Ensure slice 14's Lima VM is running (`just vm-up` if not).
3. `just backend-image` — boots the local registry compose service, builds the backend with `bootBuildImage`, pushes to the local registry.
4. `just backend-apply` — applies the local overlay, waits for the pod to become Ready.
5. `just backend-forward` — runs in a separate terminal; opens `http://localhost:18080/actuator/health` to confirm.
6. `just backend-logs` — tails the pod logs.

**To stop using the k3s backend** (without reverting the slice):

1. `just backend-delete` — removes the Deployment, Service, and ConfigMap.
2. Optionally `docker compose --profile registry down` — stops the local registry. The named volume is preserved.

**Rollback (the slice itself):**

1. `git revert <merge-commit>`.
2. `just backend-delete` (defensive; the deployment manifests have just disappeared but the cluster still has the resources).
3. `docker compose --profile registry down`.
4. `docker volume rm <registry-volume-name>` if total cleanup is desired.
5. The host dev loop, slice 14's postgres-in-k3s, and the observability stack continue unchanged.

**CI:** no change. The slice does not touch CI workflows.

## Open Questions

- **Buildpack-binding pattern vs. post-build Dockerfile layer for the OTel agent bake.** Lean: post-build Dockerfile layer because it is more obvious to a reader; the binding pattern is "more idiomatic buildpacks" but adds learning-cost. Decide at implementation; capture the decision in the slice commit body.

- **Which hostname does the cluster use to pull from the registry?** Three options:
  - Pod image references use `registry.local:5000` and the `registries.yaml` mirror rewrites to a VM-reachable host address. (Three names: `localhost:5000` for push, `registry.local:5000` in the manifest, the actual VM-routed address invisible to the developer.)
  - Pod image references use `host.lima.internal:5000` directly; no mirror rewrite. (Two names; ties the manifest to Lima specifically.)
  - Pod image references use `localhost:5000`; the cluster sees localhost as itself, and a HostNetwork or NodePort kludge bridges it. (Bad; rejected.)
  Lean: option 1 — `registry.local:5000` in the manifest with a mirror rewrite — because it lets the Hetzner overlay use the same manifest with a different mirror (or no mirror, if it pulls from `ghcr.io/<owner>` directly). The asymmetry between push hostname and pull hostname is documented.

- **Confirm `host.docker.internal` resolves from inside the Lima VM.** Lima's `hostResolver` and `portForwards: hostIPMDNS` settings interact in non-obvious ways with this hostname. The OTel collector path depends on it working. Implementation step: verify with `nsenter` / `kubectl run --rm` / similar; if it does not resolve, add a `hostAliases` block to the backend Deployment pointing at the host's VM-side IP (Lima exposes this via `host.lima.internal`).

- **Resource caps for the backend pod.** Initial guess: `requests: 256Mi / 0.25`, `limits: 1.5Gi / 1`. Confirm at implementation that postgres + backend fits in the Lima VM's 8 GiB envelope with headroom. Spring Boot 3 idles at ~400 MiB resident; under e2e load it may push to ~1 GiB.

- **`imagePullPolicy` for the local overlay.** Lean: `Always` so iterating on the `:dev` tag is friction-free. Alternative is digest-tagging every push (`backend:dev-<sha>`) and updating the manifest each time. `Always` wins for ergonomics; `IfNotPresent` is the Hetzner default.

- **Do we ship a `just backend-rebuild` one-shot recipe?** Lean: yes — it is the recipe developers will use 95% of the time. Wraps `backend-image` and `backend-apply`. The other recipes stay as primitives for debugging.

- **`SPRING_PROFILES_ACTIVE` for the in-cluster backend.** Lean: leave unset (matching the host loop's default `local` profile resolution via the missing-profile fallback). If we want to distinguish in-cluster behavior (different log file path, different metrics tag), introduce a `cluster` profile later — out of scope here.

- **ConfigMap content.** The slice declares a `configmap.yaml` placeholder; in practice every override may fit in env vars. Decide at implementation whether to ship an empty ConfigMap (cheap forward-compatibility) or drop it entirely (no dead resource). Lean: drop it if empty; future slices can add it back.

- **Probe initialDelay and timeout tuning.** The Bitnami postgres pod readied in ~30s in slice 14. The backend's cold start (JVM + Flyway + Spring) is likely 25–45s on the CAX21-shape VM. The startupProbe's failure threshold of 30 × 5s = 150s should hold; verify at implementation and tune.

- **Whether to add a `tasks.named<Test>("test")` Gradle task that uses the buildpacks image to run an `actuator/health`-only smoke check.** Lean: no — over-engineering for slice 15. The `just backend-apply` rollout-status gate is the smoke check.

- **Whether the `registry` compose profile should also bring up the existing `observability` profile** (so the in-cluster backend's OTLP traffic actually flows somewhere). Lean: no — keep profile coupling explicit; document in README that running the in-cluster backend without observability up leaves OTLP traffic dropped at the host edge.
