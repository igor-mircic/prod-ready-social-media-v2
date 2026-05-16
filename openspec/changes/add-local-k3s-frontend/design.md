## Context

Slice 15 (`add-local-k3s-backend`) put a Spring Boot backend into the Lima-hosted k3s cluster, using a local OCI registry + `registries.yaml` mirror to distribute the image and a ClusterIP Service + `kubectl port-forward` to expose it. The slice deliberately deferred two cluster-level decisions to "the slice that needs them first": the ingress story (Traefik vs nginx-ingress) and the secrets-management story (plain Secret vs SOPS / Sealed Secrets / External Secrets). Frontend-in-k3s touches the first one (the frontend is the first plausible *user-facing* ingress consumer; the backend's ClusterIP-only access is debug-only) and does not touch the second one (the frontend reads no Secrets in this slice).

The frontend's current shape constrains the slice. It is a Vite + React + TypeScript project under `frontend/`, built with `pnpm build` to produce a static bundle in `frontend/dist/`. The bundle uses three Vite env vars at runtime (`VITE_API_BASE_URL`, `VITE_OTEL_ENABLED`, `VITE_OTEL_TRACES_ENDPOINT`) — Vite resolves them at build time, so the values are frozen into the emitted JS. The host dev loop is `pnpm dev` (Vite's dev server on `:5173`) and the e2e harness in `e2e/src/setup/frontend.ts` spawns `vite preview` on `:4173`. Both today rely on Vite's `server.proxy` / `preview.proxy` block to forward `/api/*` and `/actuator/*` to `http://localhost:8080` (the host Spring backend). In any k3s topology the Vite proxy is absent — whatever container serves the bundle must perform the same forwarding itself, or the browser has to learn a different origin for the API (and pay the CORS / cookie cost).

The Lima VM has a fixed envelope: 4 vCPU, 8 GiB RAM, 64 GiB disk, arm64. Postgres consumed ~1 GiB in slice 14; the in-cluster backend consumed ~400 MiB in slice 15. Frontend is the *cheap* pod in this trio — an nginx-serving-static-files pod idles at ~10 MiB resident — so resource caps are tight rather than generous. The CAX21 Hetzner box has the same 4 vCPU / 8 GiB envelope, so any resource decision transfers 1:1 to production.

The image-distribution question is already solved. Slice 15 stood up the `registry:2` compose service, the `registries.yaml` mirror, and the `host.lima.internal:5000` host-side endpoint. Slice 16 reuses every piece of that plumbing unchanged — only the image tag is new (`registry.local:5000/frontend:dev`).

## Goals / Non-Goals

**Goals:**

- Build the Vite + React frontend into an OCI image using a hand-written multistage Dockerfile, preserving the existing `pnpm build` invocation and bundling the production-shape nginx config into the runtime stage.
- Deploy the frontend into the `social` namespace as a Deployment + ClusterIP Service, with the pod's nginx reverse-proxying `/api/*` and `/actuator/*` to the in-cluster backend Service at `backend.social.svc.cluster.local:8080`.
- Reuse slice 15's image distribution path (local registry + `registries.yaml` mirror + `host.lima.internal:5000`) without modification.
- Provide a small `just` verb surface that wraps the build / push / apply / forward / logs / delete loop so a developer never has to remember the underlying `kubectl` / `docker` invocations. Mirror slice 15's recipe shape so the muscle memory transfers.
- Keep the host `pnpm dev` loop and the `vite preview` e2e harness unchanged so the slice is opt-in and easily reverted.
- Plant the Hetzner overlay seed (commented stub) so the next slice (Hetzner deploy) lands on a known-shaped surface for the frontend Deployment.

**Non-Goals:**

- Migrating the host dev loop into k3s. The k3s frontend is a side-channel, not a replacement. e2e tests continue to target the host `vite preview`; the IDE run configurations continue to work; the README's existing "Run the frontend" section is untouched.
- Adding an Ingress, DNS, or TLS termination to the frontend. Access is via `kubectl port-forward`. The Traefik-vs-nginx-ingress decision is rolled forward to a dedicated `add-cluster-ingress` slice.
- Migrating any observability stack component (Prometheus, Grafana, Tempo, Loki, OTel collector) into k3s. They stay in docker-compose; the browser still OTLPs to the host collector at `http://localhost:4318`.
- Provisioning the Hetzner box, or putting live resources into `overlays/hetzner/` for the frontend.
- Decoupling the bundle's baked-in Vite env vars from the image (runtime config injection / `/config.js` env-substitution at container start). Out of scope; revisit when per-environment rebuilds become painful.
- Adding image signing (cosign), SBOM publication, image scanning, registry authentication, NetworkPolicy, HPA, PodDisruptionBudget, or multi-replica.
- Supporting an in-k3s frontend that talks to a host-loop backend. The slice ships a single nginx config whose upstream is the in-cluster backend Service; running the FE pod without the BE pod yields HTTP 502 on API calls, by design.

## Decisions

### Decision 1 — Multistage Dockerfile, not buildpacks and not `vite preview` in a container

Spring Boot's Paketo buildpacks (slice 15's choice for the backend) do not apply to a Vite/React bundle: there is no Java entrypoint, no Spring-aware layering, no startup-class detection. Two alternatives exist for the frontend:

- **Hand-written multistage Dockerfile** — `node:22-alpine` builds with pnpm; `nginxinc/nginx-unprivileged:1.27-alpine` serves the static bundle. The build stage's `node_modules` and source never reach the runtime image.
- **Single-stage `vite preview` in a container** — base off `node:22-alpine`, copy the entire `frontend/` directory, run `pnpm install && pnpm preview`. Smaller-effort to write; ~600 MiB image; carries a full Node runtime that adds nothing in production.

The slice picks the multistage Dockerfile. The reasons mirror slice 15's "production-real, not dev-loop-ish" framing: the Hetzner deploy will not be running `vite preview`, and discovering that mid-deploy is the wrong time. nginx is also the canonical production frontend in this stack class, so we get the SPA fallback, the gzip, the static-file caching headers, and the same-origin reverse-proxy in one piece.

Concrete Dockerfile shape (final form decided at implementation time):

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder
ARG VITE_API_BASE_URL=""
ARG VITE_OTEL_ENABLED="true"
ARG VITE_OTEL_TRACES_ENDPOINT="http://localhost:4318"
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_OTEL_ENABLED=$VITE_OTEL_ENABLED \
    VITE_OTEL_TRACES_ENDPOINT=$VITE_OTEL_TRACES_ENDPOINT
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

The exact `ARG` ↔ `ENV` plumbing is settled at implementation time but the shape above is the contract. BuildKit's pnpm-store cache mount keeps warm builds fast.

Rejected:

- **Trunk-served bundle as a Node process (`serve -s dist`).** Smaller learning curve than nginx; bigger surface, less production-real, and no built-in reverse-proxy. nginx wins.
- **Static bundle served by Caddy.** A perfectly fine alternative that auto-handles TLS and is simpler to configure. nginx is the canonical Kubernetes frontend pattern in this stack class, and the team's prior exposure to nginx (slice 14's klipper / Traefik discussions assume nginx-shaped configs in production) makes nginx the lower-risk pick. Caddy stays available as a future swap.

### Decision 2 — `nginxinc/nginx-unprivileged:1.27-alpine`, not the upstream `nginx:1.27-alpine`

k3s pods default to running with `runAsNonRoot: true` enforced at the Pod Security Standard `restricted` level (the project does not yet enforce this admission-controller policy, but doing so eventually is a goal). The upstream `nginx` image runs as `root` and binds to port `:80` — which requires CAP_NET_BIND_SERVICE for non-root binds. The `nginxinc/nginx-unprivileged` variant ships an already-modified config that binds `:8080` and runs as uid `101`, eliminating both gripes in one swap.

The Service maps port 80 → targetPort 8080 so the *Service* address remains the boring `:80`; only pod-internal config knows about the 8080.

Rejected:

- **`nginx:1.27-alpine` + `securityContext.runAsUser: 0`.** Works today; flips when restricted PSS lands. Picking the unprivileged variant up front means the Hetzner overlay does not need to revisit this decision.
- **`nginx:1.27-alpine` + setcap on the binary in a derived layer.** Works; obscures the pod's security posture for marginal benefit.

### Decision 3 — Same-origin reverse-proxy in nginx, not Ingress

Slice 14's design.md called out Traefik-vs-nginx-ingress as a future decision triggered by "the first workload that needs an Ingress object". The frontend *could* be that workload, but it does not *have* to be — the slice's purpose is to land the application-in-k3s frontend loop, and adding an ingress object doubles the surface to get wrong while not making the slice any more useful (the host loop already serves on `localhost:4173` / `:5173`; the k3s frontend only needs to be reachable for debugging).

The slice ships:

- A `Service` of type `ClusterIP` on port 80 (→ targetPort 8080).
- A `just frontend-forward` recipe that runs `kubectl port-forward -n social svc/frontend 13000:80`.
- An nginx config inside the pod that performs the same-origin reverse-proxy: requests to `/api/*` and `/actuator/*` are proxied to `http://backend.social.svc.cluster.local:8080`.

Why same-origin reverse-proxy rather than just letting the browser hit the backend directly:

- **Cookie scope.** The auth flow uses cookies for session state. Same-origin means the cookie that the backend sets on `/api/v1/auth/login` is visible on `/api/v1/me` without any cross-site cookie attribute games.
- **No CORS.** The browser sees a single origin (`http://localhost:13000` via port-forward). No `Access-Control-Allow-*` headers need to be configured on the backend; no preflights fire.
- **Production-symmetry.** A Hetzner deploy that puts both pods behind a single Ingress will produce the same same-origin shape from the browser's view. The local overlay rehearses that exact topology.

The Traefik-vs-nginx-ingress decision is rolled forward to `add-cluster-ingress` or to whichever slice introduces the *external* same-origin path. Slice 16's pod-local nginx is a *reverse-proxy*, not an ingress controller — it terminates traffic for one pod only.

Rejected: a klipper-lb `LoadBalancer` Service on `:80` paired with a Lima portForward. That works but pollutes the host's `:80` port (which on macOS is typically free but conventionally reserved). Port-forward on `:13000` is opt-in and ephemeral.

### Decision 4 — Frontend stays opt-in; host `pnpm dev` and `vite preview` loops are unchanged

The k3s frontend is a *side-channel*. The host loop remains the canonical dev experience; the e2e harness target is unchanged. There are three reasons:

- The observability stack still lives in compose. The browser OTLPs to the host collector at `http://localhost:4318`; that transport works identically whether the bundle was served by Vite or by the in-cluster nginx.
- The e2e harness in `e2e/src/setup/frontend.ts` spawns Vite as a host process. Rewriting it to target a k3s Service would require port-forward orchestration, pod-readiness gating, and a separate teardown path. That is a slice of its own.
- The slice is reversible. Anyone who does not run `just frontend-image` sees zero behavior change to their normal dev experience.

Mechanism: every new entry point (justfile recipes, README section) is explicitly labelled "optional" / "side-channel" so the next contributor reading the docs cannot infer that the host loop is deprecated.

### Decision 5 — Strict pairing with the in-cluster backend; no `host.lima.internal:8080` fallback

nginx's upstream points at `backend.social.svc.cluster.local:8080` — the in-cluster Service introduced by slice 15. If a developer applies the frontend overlay without also applying the backend overlay, the backend Service has no endpoints and nginx returns HTTP 502 on `/api/*` and `/actuator/*` calls. By design.

The alternative — a local-overlay strategic-merge patch that swaps the upstream to `host.lima.internal:8080` so the in-k3s FE can talk to a host JVM backend — was considered and rejected:

- **Cognitive split.** Two different nginx configs (base = in-cluster, local = host) means a reader has to hold both shapes in their head and figure out which one is "really" running. The base config never sees production load if the local overlay's patch always wins.
- **New failure mode.** A developer who forgets to apply the patch silently talks to a different backend than the one they started. Worse, errors only surface when they hit a `/api/` route.
- **Slice posture.** Slice 15 framed in-cluster workloads as a side-channel opt-in. The natural pairing is "apply both, or apply neither." The strict-pairing rule encodes that intent.

If the flexible-upstream pattern turns out to be needed, it can be added as a future slice that introduces a small ConfigMap mounted at `/etc/nginx/conf.d/upstream.conf` with the upstream definition. Slice 16 deliberately does not preemptively build that mechanism.

### Decision 6 — Baked-in Vite env vars; one image per environment

Vite freezes env vars at build time. The slice picks the simplest possible posture: bake the in-cluster-appropriate values into the local image, document the rebuild requirement for Hetzner, and call out the `/config.js` runtime-injection pattern as a follow-up spike.

The baked-in defaults for the local image:

- `VITE_API_BASE_URL=''` — empty string. The browser hits the same origin it loaded the bundle from. Combined with nginx's reverse-proxy on `/api/*`, the call lands in the right place without any per-environment URL knowledge in the bundle.
- `VITE_OTEL_ENABLED='true'` — keeps browser OTel on. The slice does not remove or add observability; it preserves what slice 5 (frontend traces) and slice 6 (frontend RUM metrics) set up.
- `VITE_OTEL_TRACES_ENDPOINT='http://localhost:4318'` — the *browser* still runs on macOS and reaches the host collector directly on `localhost:4318`. The transport is identical to today's `pnpm dev` flow.

Rebuild-for-Hetzner is the trade-off: shipping the production image will require `docker build --build-arg VITE_API_BASE_URL=https://api.<host>` (or similar). That extra build step is captured in the Hetzner overlay's commented stub.

Rejected:

- **`/config.js` runtime injection.** nginx serves a non-fingerprinted `/config.js` whose contents are env-substituted at container start (`envsubst < config.js.tmpl > /usr/share/nginx/html/config.js && exec nginx -g 'daemon off;'`). The frontend reads `window.__config` instead of `import.meta.env.*`. One image, many environments. Strictly better long-term; meaningful refactor cost in the FE for a slice whose explicit goal is "smallest end-to-end loop." Captured as a future spike.
- **Sentinel-and-replace in the bundle.** Build with `VITE_API_BASE_URL='__VITE_API_BASE_URL__'`, then run `sed -i s/__VITE_API_BASE_URL__/.../` against the emitted JS at container start. Works; magical; brittle if Vite ever changes its minifier's quoting. Rejected.

### Decision 7 — nginx upstream resolution at start, not per-request

nginx by default resolves upstream hostnames *once* at config-load time and caches the result. If the upstream's IP changes, nginx keeps using the cached IP until reloaded. This is fine for a ClusterIP Service — the Service VIP is stable for the lifetime of the Service object; it does *not* change when the backing pods restart.

The alternative — using nginx's `resolver` directive to resolve at request time — is needed when the upstream resolves to pod IPs directly (`headless` Service) or to an external DNS record whose targets change. Neither applies here.

The trade-off: if a developer deletes and re-creates the backend Service (rather than just rolling its pods), the nginx upstream resolves to a stale VIP. Mitigation: the strict-pairing rule and `frontend-rebuild` recipe make this scenario "rebuild and re-apply both," which restarts nginx and re-resolves. Documented in design.

### Decision 8 — Hetzner overlay seed for frontend: commented stub, no live resources

Slice 14 planted an empty `overlays/hetzner/kustomization.yaml`. Slice 15 appended a commented stub block describing the backend Hetzner deploy. Slice 16 appends the parallel commented stub block for the frontend deploy:

- Real image reference: `ghcr.io/<owner>/frontend@sha256:<digest>` (digest-pinned for reproducible deploys).
- `imagePullSecrets: [{ name: ghcr-pull }]` (same Secret slice 15 set up, populated out-of-band).
- Resource caps tuned for the CAX21 envelope. nginx is cheap; the local caps are probably fine without changes.
- Tighter probe timings if measurement on the real box justifies them.
- The `imagePullPolicy: Always` patch from the local overlay is replaced with `IfNotPresent` (digest-pinned tags mean re-pulling adds nothing).
- The build-time Vite env vars rebake with production URLs (e.g., `VITE_API_BASE_URL=''` if same-origin Ingress, or `https://api.<host>` if split origins).

The point of the stub is not to ship configuration; it is to ship *intent* so the next slice knows exactly where the additions go. The same pattern slice 14 and slice 15 used.

### Decision 9 — `justfile` recipe surface and naming

The slice adds six recipes. Names match the slice-14 and slice-15 verb-first convention:

- `frontend-image` — wraps `docker compose --profile registry up -d registry` → `docker build -t 127.0.0.1:5000/frontend:dev frontend/` → `docker push 127.0.0.1:5000/frontend:dev` → optional confirmation print of pushed digest. The `--profile registry` ensures the registry comes up implicitly when a developer first runs the recipe; subsequent runs see it already running and the compose call is a no-op.
- `frontend-apply` — `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -` then `kubectl rollout status deploy/frontend -n social --timeout=120s` (rollout-status gates the recipe on the new pod becoming Ready, avoiding the "apply returned and the user immediately checks logs but the pod is still pulling" race; nginx-on-arm64 starts faster than the backend, so the 120s timeout is generous rather than tight).
- `frontend-logs` — `kubectl logs -n social deploy/frontend -f`.
- `frontend-forward` — `kubectl port-forward -n social svc/frontend 13000:80`.
- `frontend-delete` — `kubectl delete deploy,svc -n social -l app.kubernetes.io/name=frontend --ignore-not-found`. Scoped to label so any future per-frontend resource is swept by the same recipe.
- `frontend-rebuild` — one-shot `frontend-image` + `frontend-apply`. This is the recipe developers will use 95% of the time; the other recipes stay as primitives for debugging.

The `127.0.0.1:5000` push tag (not `localhost:5000`, not `registry.local:5000`) is deliberate — same as slice 15. macOS's AirPlay Receiver squats on `::1:5000` and steals IPv6 traffic to `localhost`, so the IPv4 form is the safe one. The pod sees the image as `registry.local:5000/frontend:dev` because the `registries.yaml` mirror rewrites that hostname inside the VM.

### Decision 10 — Probes, resource caps, and image-pull policy

Probes:

- `livenessProbe`: HTTP GET `/` on port 8080, `initialDelaySeconds: 5`, `periodSeconds: 10`, `failureThreshold: 3`. Kills a wedged nginx; the 5s initial delay is enough for `nginx -g 'daemon off;'` to bind the listener.
- `readinessProbe`: HTTP GET `/` on port 8080, `periodSeconds: 5`, `failureThreshold: 3`. Marks the pod ready as soon as nginx responds.
- No startupProbe. nginx is up in under one second; the liveness `initialDelaySeconds: 5` covers the cold start.

Why `/` (the root) and not a dedicated `/healthz`: nginx is the only thing in the pod, the root location returns `index.html` (200 OK), and that is a sufficient liveness signal. A dedicated `/healthz` location returning a static "OK" string is a fine refinement that the slice does not need; if the bundle path ever changes, the same nginx config that serves the bundle handles the probe too.

Resource caps (initial guess, refine at implementation time):

- `requests: cpu=50m, memory=64Mi`
- `limits: cpu=200m, memory=128Mi`

nginx idles at ~5 MiB resident with a handful of workers; the 128 MiB ceiling is comfortable. Numbers transfer 1:1 to the Hetzner overlay; tune up only if a real workload demands it (and at that point Hetzner would also be sized differently).

Image-pull policy:

- `local` overlay: `imagePullPolicy: Always` so iterating on the `:dev` tag picks up new pushes without a digest swap.
- `hetzner` overlay (future): `imagePullPolicy: IfNotPresent` with a digest-pinned tag, so deploys are idempotent and reproducible.

### Decision 11 — SPA fallback via `try_files $uri $uri/ /index.html;`

The frontend uses `react-router-dom@7` for client-side routing (e.g., `/feed`, `/profile/:handle`). A direct GET to one of those paths must serve `index.html` and let the client router take over; otherwise nginx returns 404. The standard SPA-server pattern handles this:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

This pattern is well-known and well-supported; the slice ships it.

Trade-off: a misspelled asset path (e.g., `/assets/typo.js`) also falls back to `index.html`, which the browser then tries to parse as JS. That manifests as a noisy error in the console; the developer fixes the typo. Acceptable for a side-channel dev image.

## Risks / Trade-offs

- **nginx upstream cached as ClusterIP VIP, no re-resolution.** If the backend Service is deleted-and-recreated (not just its pods), the VIP changes and nginx returns 502 until the FE pod restarts. → Mitigation: `frontend-rebuild` restarts nginx; documented as a known recovery step. The realistic case is a developer running `just k8s-apply` against unchanged manifests, which keeps the Service unchanged.

- **`host.docker.internal:4318` vs `host.lima.internal:4318` asymmetry.** The browser, running on macOS, hits `localhost:4318` directly — no Lima alias needed. But if the bundle is ever served *from inside* a containerized agent (e.g., a future "FE smoke test in CI"), the in-container browser would not see `localhost` the same way. → Out of scope for slice 16; flagged for a future CI-frontend-smoke slice.

- **Image size from the multistage build's intermediate cache.** BuildKit caches `node_modules` and the pnpm store; the cache directory on the host can grow to several hundred MiB over time. → Acceptable; documented in README as a `docker builder prune` opportunity if disk runs short.

- **No CORS on the backend means the strict-pairing rule actually matters.** A developer who points the in-k3s FE at a host backend (by abusing port-forwarding) would discover the backend never set up cross-origin headers. The slice's strict-pairing rule sidesteps this entirely — but documenting the rule is load-bearing because the failure mode is silent (the browser blocks the request, the developer sees a CORS error in the console). → Documented in README and in the recipe comments.

- **Frontend bundle baking the OTel endpoint as `http://localhost:4318` means the production bundle must be rebuilt to point elsewhere.** That is precisely the cost the `/config.js` spike is meant to remove; for slice 16 the rebuild is accepted. → Hetzner overlay's commented stub flags the rebuild requirement.

- **`kubectl port-forward` is a long-running foreground process.** Anyone running `just frontend-forward` discovers it does not background. → Documented; expected behavior; trivial wrapper if developers want backgrounding.

- **Build context size and `.dockerignore` hygiene.** Without `.dockerignore`, `docker build` copies `node_modules/`, `playwright-report/`, `test-results/`, and `dist/` into the build context — a multi-hundred-MiB tax on every iteration. → Slice ships a `.dockerignore` upfront; documented in the README.

- **nginx config divergence between local and hetzner overlays.** The nginx config lives in the *image*, not in a ConfigMap. If the Hetzner overlay ever needs a different nginx config (e.g., a different upstream because BE lives elsewhere), it has to be a different image. → Accepted for slice 16. A future slice that extracts nginx config to a ConfigMap is a clean refactor; not needed yet.

- **No automated check that the in-k3s FE actually talks to the in-k3s BE.** A developer can apply the frontend overlay alone, hit `/api/*`, get a 502, and reasonably wonder why. → Tasks.md adds a verification step that probes the API path through the port-forward; the strict-pairing rule is documented in README.

## Migration Plan

This slice is opt-in. There is no "migration" required of an existing developer; running `git pull` does not change behavior until the developer explicitly runs `just frontend-image`.

**For a developer who wants to try the k3s frontend:**

1. `git pull` to land the slice.
2. Ensure slice 14's Lima VM is running (`just vm-up` if not) and slice 15's backend is applied (`just backend-rebuild`).
3. `just frontend-image` — boots the local registry compose service (if not already up), builds the frontend image, pushes to the local registry.
4. `just frontend-apply` — applies the local overlay, waits for the pod to become Ready.
5. `just frontend-forward` — runs in a separate terminal; opens `http://localhost:13000/` to confirm.
6. Sign in, hit a route that performs an API call (e.g., the feed), confirm the network tab shows the call going to `http://localhost:13000/api/v1/...` (same-origin) and returning a 200.

**To stop using the k3s frontend** (without reverting the slice):

1. `just frontend-delete` — removes the Deployment and Service.
2. The host loop and the e2e harness are untouched and continue to work.

**Rollback (the slice itself):**

1. `git revert <merge-commit>`.
2. `just frontend-delete` (defensive; the deployment manifests have just disappeared but the cluster still has the resources).
3. The host loop, the e2e harness, slice 15's backend-in-k3s, slice 14's postgres-in-k3s, and the observability stack continue unchanged.

**CI:** no change. The slice does not touch CI workflows.

## Open Questions

- **Should `frontend-image` build natively for arm64 only or for `linux/arm64,linux/amd64` multi-arch?** Lean: arm64 only for slice 16, since both the Lima VM and the Hetzner CAX21 are arm64. Multi-arch costs extra build time and is captured as a follow-up spike if an x86 contributor ever joins. Confirm at implementation.

- **Pin pnpm version explicitly in the Dockerfile?** The `package.json` already pins `packageManager: pnpm@10.33.2`. corepack honors that pin automatically; the Dockerfile probably does not need a second pin. Verify at implementation.

- **Does the build benefit from `VITE_APP_VERSION` injection?** `vite.config.ts` already reads `version` from `package.json` at config-eval time. The Docker build copies `package.json` into the builder stage, so this Just Works without explicit env plumbing. Confirm.

- **Probe path: `/` vs `/index.html`?** `/` returns `index.html` via `try_files` — same content, same status. Lean: `/` for brevity. Verify nginx returns 200 (not 304) on the probe's HTTP/1.1 request without a If-Modified-Since header.

- **`pnpm install --frozen-lockfile` vs `pnpm install`?** Frozen lockfile is the right choice for reproducible builds. Confirmed.

- **Build-time `ARG`s vs build-time `--env` flags vs `.env.production` file?** Lean: `ARG` + `ENV` because the build flow is `docker build --build-arg ...` and the Dockerfile carries the contract. `.env.production` would couple the image build to a checked-in file the slice would otherwise not need. Confirmed.

- **Whether the `frontend-image` recipe should also bring up the existing `observability` profile** (so the browser's OTLP traffic actually flows somewhere). Lean: no — keep profile coupling explicit; document in README that running the in-cluster frontend without observability up leaves browser OTLP traffic dropped at the host edge. Symmetric with slice 15's posture.

- **gzip / `Content-Encoding` headers for static assets.** The unprivileged nginx image's stock config does not enable gzip. Adding `gzip on; gzip_types text/css application/javascript;` in the `server` block is a one-line win. Lean: include it; confirm size impact in tasks.md verification.

- **Whether the SPA fallback should match more narrowly** (e.g., only when the request Accepts `text/html`). The naive `try_files` falls back any unmatched path to `index.html`, including stale asset requests. Lean: ship the naive fallback for slice 16; refine if a real-world stale-asset error becomes noisy. Browser developer tools surface the issue quickly.
