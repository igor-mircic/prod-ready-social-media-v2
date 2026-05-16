## Why

Slice 15 (`add-local-k3s-backend`) put a Spring Boot backend into the Lima-hosted k3s cluster alongside the postgres workload from slice 14, proving the application-in-k3s loop end-to-end. The cluster now hosts two of the three tier-1 workloads (postgres, backend) but not the third (frontend). Until the frontend has a path into k3s, the "what production looks like" picture remains incomplete in a load-bearing way: every same-origin assumption the FE relies on at runtime (cookie scope, `/api` routing, OTel trace propagation) only gets exercised in the dev-server flow, where Vite's proxy paves over the topology. The Hetzner deploy will *not* have a Vite proxy, and discovering that mid-deploy is the wrong time. This slice introduces the smallest end-to-end "frontend in k3s" loop — build the Vite bundle into a multistage Docker image, distribute it through the existing local OCI registry, and run it as a Deployment whose pod-local nginx reverse-proxies `/api/*` and `/actuator/*` to the in-cluster backend Service — while keeping the host `pnpm dev` loop and the `vite preview` e2e harness unchanged. The k3s frontend is a *side-channel* opt-in, not a replacement, so the slice is bounded and reversible.

## What Changes

- **New `frontend/Dockerfile`** — multistage build. Stage 1 (`node:22-alpine`, name `builder`) pins pnpm via `corepack enable`, runs `pnpm install --frozen-lockfile`, then `pnpm build`. Stage 2 (`nginxinc/nginx-unprivileged:1.27-alpine`) copies the builder's `dist/` into `/usr/share/nginx/html/` and copies the slice's nginx config into `/etc/nginx/conf.d/default.conf`. Final image listens on `:8080` (unprivileged-variant default), runs as uid `101`, and is Node-free at runtime (~40 MiB compressed). Build-time `ARG`s pass the baked-in Vite env defaults (`VITE_API_BASE_URL=`, `VITE_OTEL_ENABLED=true`, `VITE_OTEL_TRACES_ENDPOINT=http://localhost:4318`) into the build stage so the runtime image carries no Vite env file.
- **New `frontend/docker/nginx.conf`** — a single `server { listen 8080; ... }` block with three location blocks:
  - `location /api/`     → `proxy_pass http://backend.social.svc.cluster.local:8080;`
  - `location /actuator/` → `proxy_pass http://backend.social.svc.cluster.local:8080;`
  - `location /`         → `try_files $uri $uri/ /index.html;` (SPA fallback so client-side routes deep-link)
  - Sets `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, and `proxy_set_header X-Forwarded-Proto $scheme;` on the two `/api/` and `/actuator/` blocks. The upstream is a literal Service DNS name — no `resolver` directive, because the backend Service is a stable ClusterIP and nginx's start-time resolution is fine for a VIP that does not change. Document the trade-off in design.md.
- **New `infra/k8s/base/frontend/` Kustomize directory** containing:
  - `kustomization.yaml` listing the slice's resources (`./deployment.yaml`, `./service.yaml`), default labels (`app.kubernetes.io/name=frontend`), and a default image tag that the local overlay overrides as needed.
  - `deployment.yaml` declaring a single-replica `frontend` Deployment with one container `frontend` running `registry.local:5000/frontend:dev`. Resource requests `cpu=50m / memory=64Mi`; resource limits `cpu=200m / memory=128Mi`. Liveness probe HTTP GET `/` on port 8080 (`initialDelaySeconds: 5`, `periodSeconds: 10`, `failureThreshold: 3`); readiness probe HTTP GET `/` on port 8080 (`periodSeconds: 5`, `failureThreshold: 3`). No startupProbe — nginx is up in under a second; no cold-start grace is warranted.
  - `service.yaml` — ClusterIP Service named `frontend`, port 80 → targetPort 8080. No LoadBalancer, no NodePort, no Ingress. Access is via `kubectl port-forward`.
  - No `configmap.yaml` — every override fits in env vars or the baked bundle (mirrors slice 15's "drop empty configmap" decision).
- **`infra/k8s/base/kustomization.yaml` updated** to include `./frontend` after `./backend` in `resources:`.
- **`infra/k8s/overlays/local/kustomization.yaml` updated** with a strategic-merge patch setting `imagePullPolicy: Always` on the frontend Deployment so iterating on the `:dev` tag picks up new pushes without a digest swap (parallel to slice 15's backend patch).
- **`infra/k8s/overlays/hetzner/kustomization.yaml`** gains a commented stub block listing what the Hetzner frontend deploy will add: ghcr.io image reference (digest-pinned), `imagePullSecrets: [{ name: ghcr-pull }]`, tighter resource caps appropriate to the CAX21 envelope, replica count discussion, and the same TLS / DNS / Ingress notes the slice-15 stub left for the backend. No live resources.
- **`justfile` recipes added** for the frontend k3s loop:
  - `frontend-image` — boots the `registry` compose profile, runs `docker build -t 127.0.0.1:5000/frontend:dev frontend/`, then `docker push 127.0.0.1:5000/frontend:dev`. Prints the resulting digest.
  - `frontend-apply` — `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -` then `kubectl rollout status deploy/frontend -n social --timeout=120s`.
  - `frontend-logs` — `kubectl logs -n social deploy/frontend -f`.
  - `frontend-forward` — `kubectl port-forward -n social svc/frontend 13000:80`. Port `13000` is intentionally chosen so it does not collide with Vite dev on `:5173`, Vite preview on `:4173`, the backend port-forward on `:18080`, or any compose service.
  - `frontend-delete` — `kubectl delete deploy,svc -n social -l app.kubernetes.io/name=frontend --ignore-not-found`.
  - `frontend-rebuild` — one-shot `frontend-image` + `frontend-apply` (the 95% path; mirrors slice 15's `backend-rebuild`).
- **`README.md`** gains a new subsection under "Local k3s cluster" titled "Run the frontend in cluster (optional)" describing the build → push → apply → forward flow, the side-channel posture, and the explicit non-goal that this does NOT replace `pnpm dev` or the e2e `vite preview`. The non-goal is restated so a fresh reader does not infer that the host loop is deprecated. The subsection also documents the strict-pairing rule: in-k3s FE requires in-k3s BE because nginx's upstream resolves to the in-cluster backend Service.
- **`.dockerignore` at `frontend/.dockerignore`** — excludes `node_modules/`, `dist/`, `.git/`, `playwright-report/`, `test-results/`, anything matching `*.log`, and the `.env*` files so the build context stays small and reproducible.

Explicit non-goals:

- **No Ingress, no DNS, no TLS.** The Traefik-vs-ingress-nginx decision deferred in slice 14 and rolled forward in slice 15 stays deferred; the slice ships only a ClusterIP Service and a `kubectl port-forward` recipe. A future `add-cluster-ingress` slice owns that decision.
- **No removal of the host `pnpm dev` loop or the `vite preview` e2e harness.** `e2e/src/setup/frontend.ts` continues to spawn `vite preview` on port 4173. The IDE run configurations continue to work. The k3s frontend is opt-in.
- **No observability stack migration into k3s.** Prometheus, Grafana, Tempo, Loki, and the OTel collector all stay in docker-compose. The browser, served the bundle through `kubectl port-forward`, runs on macOS and reaches `localhost:4318` directly — the same transport the host loop uses today. No new observability surface.
- **No Hetzner overlay live resources for frontend.** A commented stub planted in `overlays/hetzner/` is the only output; the next slice fills it.
- **No CI job that exercises the k3s frontend deploy.** Existing CI continues to use `vite preview` for e2e; the k3s frontend is dev-only for now.
- **No runtime config injection (`/config.js` env-substitution).** Vite env vars are baked at build time; rebuilding for the Hetzner overlay produces a separate image with prod URLs. The `/config.js` pattern is captured as a follow-up spike in design.md.
- **No fallback in nginx upstream to `host.lima.internal:8080`.** The in-k3s FE strictly pairs with the in-k3s BE. If a developer applies the frontend overlay without also applying the backend overlay, nginx returns 502 on API calls. Documented in design.md.
- **No multi-replica.** Single replica is fine — the cluster is single-node and the workload is dev-only.
- **No image signing (cosign), no SBOM publication, no NetworkPolicy, no HPA, no PodDisruptionBudget.** Same posture as slice 15: each is a follow-up consideration; none is needed for the smallest end-to-end loop.

## Capabilities

### New Capabilities

(none — `kubernetes` (slice 14) and `frontend-scaffold` are the natural homes for the frontend Deployment requirements and the frontend image-shape requirements respectively.)

### Modified Capabilities

- `kubernetes` — adds requirements covering: (a) the frontend Deployment shape (image source, resource caps, probe configuration, ClusterIP exposure), (b) the same-origin reverse-proxy pattern in which nginx-in-pod forwards `/api/*` and `/actuator/*` to the backend Service at `backend.social.svc.cluster.local:8080`, (c) the strict-pairing rule between the frontend and backend Deployments, and (d) the frontend Kustomize base + local-overlay patch layout.
- `frontend-scaffold` — adds requirements for the production-shape container image: the multistage Dockerfile that builds with `node:22-alpine` + pnpm and serves with `nginxinc/nginx-unprivileged:1.27-alpine`, the baked-in Vite env defaults appropriate for the in-cluster topology (`VITE_API_BASE_URL=''`, `VITE_OTEL_ENABLED='true'`, `VITE_OTEL_TRACES_ENDPOINT='http://localhost:4318'`), and the nginx config that performs the same-origin reverse-proxy. The host `pnpm dev` and `vite preview` requirements from prior scaffolding slices are unchanged.
- `monorepo-layout` — extends the `frontend/` tree's documented contents with the new `Dockerfile`, `docker/nginx.conf`, and `.dockerignore`; extends the `infra/k8s/base/` sibling list with a new `frontend/` directory.

## Impact

- **Affected files / directories:**
  - `frontend/Dockerfile` (new) — multistage node-builder → nginx-unprivileged
  - `frontend/docker/nginx.conf` (new) — three-location-block server config
  - `frontend/.dockerignore` (new)
  - `infra/k8s/base/frontend/kustomization.yaml`, `deployment.yaml`, `service.yaml` (new)
  - `infra/k8s/base/kustomization.yaml` — appends `./frontend` to `resources:`
  - `infra/k8s/overlays/local/kustomization.yaml` — adds a strategic-merge patch for `imagePullPolicy: Always` on the frontend Deployment
  - `infra/k8s/overlays/hetzner/kustomization.yaml` — appends a commented stub block for the Hetzner frontend deploy
  - `justfile` — six new recipes (`frontend-image`, `frontend-apply`, `frontend-logs`, `frontend-forward`, `frontend-delete`, `frontend-rebuild`)
  - `README.md` — new "Run the frontend in cluster (optional)" subsection; existing "Local k3s cluster" non-goals updated
- **New tool dependencies:**
  - No new host dependencies. `docker` (already required for compose), `kubectl` and `kustomize` (already required for slice 14), `pnpm` (already vendored via corepack) cover everything.
  - Two new container base images: `node:22-alpine` (build-time only) and `nginxinc/nginx-unprivileged:1.27-alpine` (runtime). Pinned to explicit tags.
- **Dependencies on external services:**
  - Public Docker Hub for the two base images on first build (cached locally afterward).
  - The local registry, the `registries.yaml` mirror, and the Lima VM all continue to function as slice 15 left them — no changes.
- **CI:** no new CI jobs. The k3s frontend flow is dev-only; CI continues to use the existing `vite preview` for e2e. A future slice may add a CI job that exercises the cluster deploy once enough other slices use it.
- **Compatibility:** additive. Anyone who pulls this branch and never runs `just frontend-image` sees no behavior change to the host dev loop, the e2e harness, or any other surface. Running `docker compose up` without the `registry` profile leaves both the slice-15 backend image flow and the slice-16 frontend image flow dormant.
- **Rollback:** `git revert` the merge. The new Dockerfile, nginx config, k8s manifests, justfile recipes, and overlay patches disappear; the host loop, the e2e harness, slice 15's backend-in-k3s, and slice 14's postgres-in-k3s are untouched. The local registry's `frontend` repository entries can be left in place or cleaned up with `curl -X DELETE` against the registry API — both are no-ops once the manifests are gone.
