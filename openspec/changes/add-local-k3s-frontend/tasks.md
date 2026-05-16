## 1. Frontend Dockerfile and nginx config

- [ ] 1.1 Create `frontend/.dockerignore` excluding at minimum `node_modules`, `dist`, `.git`, `playwright-report`, `test-results`, `*.log`, and `.env*`. Verify with `du -sh frontend/` minus the ignored paths that the resulting build context is under ~10 MiB.
- [ ] 1.2 Create `frontend/Dockerfile` with the multistage shape from design.md Decision 1: a builder stage `FROM node:22-alpine AS builder` that enables corepack, installs deps with `pnpm install --frozen-lockfile` (using a BuildKit `--mount=type=cache` for the pnpm store), runs `pnpm build`; and a runtime stage `FROM nginxinc/nginx-unprivileged:1.27-alpine` that copies `dist/` to `/usr/share/nginx/html` and copies `docker/nginx.conf` to `/etc/nginx/conf.d/default.conf`.
- [ ] 1.3 In the builder stage, declare three `ARG` directives — `VITE_API_BASE_URL=""`, `VITE_OTEL_ENABLED="true"`, `VITE_OTEL_TRACES_ENDPOINT="http://localhost:4318"` — and export each as an `ENV` of the same name before `pnpm build` runs, so Vite resolves them at build time.
- [ ] 1.4 Create `frontend/docker/nginx.conf` with a single `server` block listening on `8080`. Add three `location` blocks: `/api/` and `/actuator/` each declaring `proxy_pass http://backend.social.svc.cluster.local:8080;` with the three `proxy_set_header` directives (`Host`, `X-Forwarded-For`, `X-Forwarded-Proto`); and `/` declaring `try_files $uri $uri/ /index.html;` for the SPA fallback.
- [ ] 1.5 Optionally enable gzip in the `server` block: `gzip on; gzip_types text/css application/javascript application/json;`. Lean: include it; confirm bundle size impact in task 6.7.
- [ ] 1.6 Run `docker build -t 127.0.0.1:5000/frontend:dev frontend/` locally and verify the build succeeds. Inspect the resulting image with `docker inspect` to confirm (a) the runtime base is `nginx-unprivileged`, (b) the image is `linux/arm64`, (c) `/usr/share/nginx/html/index.html` exists in the image, and (d) `/etc/nginx/conf.d/default.conf` matches `frontend/docker/nginx.conf`.

## 2. Kustomize frontend base

- [ ] 2.1 Create `infra/k8s/base/frontend/kustomization.yaml` declaring `resources: [./deployment.yaml, ./service.yaml]`, `labels:` setting `app.kubernetes.io/name: frontend` across all generated resources, and inheriting the namespace from `base/kustomization.yaml`.
- [ ] 2.2 Create `infra/k8s/base/frontend/service.yaml` declaring a `Service` of `type: ClusterIP`, selector `app.kubernetes.io/name: frontend`, port `80` → targetPort `8080`.
- [ ] 2.3 Create `infra/k8s/base/frontend/deployment.yaml` with: `spec.replicas: 1`; one container named `frontend`; `image: registry.local:5000/frontend:dev`; `ports: - containerPort: 8080 name: http`; resource requests `cpu: 50m / memory: 64Mi`; resource limits `cpu: 200m / memory: 128Mi`.
- [ ] 2.4 Wire the two probes on the frontend container per design.md Decision 10: liveness (`/` on port 8080, `initialDelaySeconds: 5`, `periodSeconds: 10`, `failureThreshold: 3`), readiness (`/` on port 8080, `periodSeconds: 5`, `failureThreshold: 3`). Do NOT add a startupProbe — nginx is up in <1s.
- [ ] 2.5 Update `infra/k8s/base/kustomization.yaml` to append `./frontend` after `./backend` in the `resources:` list. Verify `kustomize build --enable-helm infra/k8s/overlays/local` produces a valid manifest stream containing the frontend Deployment and Service.

## 3. Overlay wiring

- [ ] 3.1 Update `infra/k8s/overlays/local/kustomization.yaml` to declare a strategic-merge patch that sets the frontend container's `imagePullPolicy: Always`, parallel to the slice-15 backend patch. Confirm `kustomize build --enable-helm infra/k8s/overlays/local | grep -A2 'name: frontend' | grep imagePullPolicy` shows `Always` exactly once.
- [ ] 3.2 Update `infra/k8s/overlays/hetzner/kustomization.yaml` with the commented stub for the frontend Hetzner deploy (image source from `ghcr.io/<owner>/frontend:<digest>`, `imagePullSecrets`, possibly tighter resource caps, `imagePullPolicy: IfNotPresent`, build-time Vite env rebake for production URLs). Comments only — no live resources. Mirror the existing slice-15 backend stub block's structure.

## 4. justfile recipes

- [ ] 4.1 Add `frontend-image` recipe to `justfile`: `docker compose --profile registry up -d registry` then `docker build -t 127.0.0.1:5000/frontend:dev frontend/` then `docker push 127.0.0.1:5000/frontend:dev`. Print the resulting tag after the push.
- [ ] 4.2 Add `frontend-apply` recipe: `kustomize build --enable-helm {{LOCAL_OVERLAY}} | kubectl apply -f -` then `kubectl rollout status deploy/frontend -n {{PG_NAMESPACE}} --timeout=120s`.
- [ ] 4.3 Add `frontend-logs` recipe: `kubectl logs -n {{PG_NAMESPACE}} deploy/frontend -f`.
- [ ] 4.4 Add `frontend-forward` recipe: `kubectl port-forward -n {{PG_NAMESPACE}} svc/frontend 13000:80`. Document the 13000 port choice in a recipe comment (does not collide with Vite dev :5173, Vite preview :4173, or slice-15 backend :18080).
- [ ] 4.5 Add `frontend-delete` recipe: `kubectl delete deploy,svc -n {{PG_NAMESPACE}} -l app.kubernetes.io/name=frontend --ignore-not-found`.
- [ ] 4.6 Add `frontend-rebuild` one-shot recipe that invokes `frontend-image` then `frontend-apply`.
- [ ] 4.7 Run `just --list` and confirm all six new recipes appear alongside the slice-14 / slice-15 verbs with their inline descriptions.

## 5. Sanity checks before end-to-end verification

- [ ] 5.1 Run `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply --dry-run=client -f -` and confirm no validation errors. The output should mention `deployment.apps/frontend created (dry run)` and `service/frontend created (dry run)`.
- [ ] 5.2 Confirm the `host.lima.internal:5000` mirror entry from slice 15 still resolves correctly inside a k3s pod (a quick `kubectl run --rm -it --image=busybox:1.36 net-test -- wget -qO- http://host.lima.internal:5000/v2/`). Slice 15 verified this; the regression check is cheap.
- [ ] 5.3 Confirm the backend Service from slice 15 is up and Ready (`kubectl get svc backend -n social` returns a ClusterIP; `kubectl get endpoints backend -n social` returns at least one pod IP). nginx's upstream depends on this.

## 6. End-to-end verification on the Lima VM

- [ ] 6.1 From a clean checkout with the Lima VM up and slice-15 backend applied: `just frontend-image` succeeds; the image is visible at `http://127.0.0.1:5000/v2/frontend/tags/list` with `"dev"` in the tags array.
- [ ] 6.2 `just frontend-apply` succeeds; `kubectl get pods -n social -l app.kubernetes.io/name=frontend` shows the pod transitioning Pending → ContainerCreating → Running → Ready within 60 seconds; rollout-status returns 0.
- [ ] 6.3 `kubectl describe pod -n social -l app.kubernetes.io/name=frontend` shows the image was pulled from the mirrored endpoint, with no `ErrImagePull` or `ImagePullBackOff` events.
- [ ] 6.4 `just frontend-forward` (in a second terminal) succeeds; `curl -sf http://localhost:13000/` returns the index.html bundle (`grep -q '<div id="root"></div>'`).
- [ ] 6.5 `curl -sf http://localhost:13000/actuator/health` returns `{"status":"UP"}` — verifies the nginx reverse-proxy to the in-cluster backend Service works.
- [ ] 6.6 `curl -sf http://localhost:13000/api/v1/auth/signup -X POST -H 'Content-Type: application/json' -d '{"email":"k3s-fe-smoke@example.com","password":"correcthorsebatterystaple","handle":"k3sfe"}'` returns HTTP 200/201 (or whatever the slice-15 backend's signup contract is). If the backend Service has no endpoints (developer ran `just backend-delete` first), confirm the response is HTTP 502 — that is the strict-pairing rule from design.md Decision 5.
- [ ] 6.7 Open `http://localhost:13000/` in a browser. Confirm the SPA loads, the network panel shows `/api/*` calls returning 2xx (same-origin, no CORS preflight), and the browser console shows no errors. If gzip was enabled in task 1.5, confirm responses for `*.js` and `*.css` carry `content-encoding: gzip`.
- [ ] 6.8 SPA fallback smoke: navigate directly to a deep-link route (e.g., `http://localhost:13000/feed` or any route the app declares) and confirm the page loads (the nginx `try_files` fallback served `index.html` so the React router could pick it up).
- [ ] 6.9 With browser OTel on, scroll/click around the app and verify Tempo shows browser-originated traces (search by `service.name=frontend` or whatever resource attribute the browser tracer is configured with). Confirms the browser's OTLP transport to `http://localhost:4318` still works when the bundle was served by the in-k3s nginx.
- [ ] 6.10 `just frontend-delete` followed by `kubectl get all -n social -l app.kubernetes.io/name=frontend` returns "No resources found". The backend and postgres workloads are untouched.

## 7. README and documentation

- [ ] 7.1 Add a new subsection to `README.md` under "Local k3s cluster" titled "Run the frontend in cluster (optional)" explaining the four-recipe flow (`frontend-image` → `frontend-apply` → `frontend-forward` → `frontend-logs`) and the side-channel posture.
- [ ] 7.2 In the same subsection, restate the explicit non-goal that this does NOT replace `pnpm dev` or the e2e `vite preview`; e2e tests still target the host `vite preview` on `:4173`; IDE run configurations are unchanged.
- [ ] 7.3 Document the strict-pairing rule from design.md Decision 5: the in-k3s FE requires the in-k3s BE because nginx's upstream resolves to `backend.social.svc.cluster.local:8080`. If a developer applies the frontend overlay without the backend overlay, `/api/*` calls return HTTP 502. Include the diagnostic recipe (`kubectl get endpoints backend -n social`).
- [ ] 7.4 Document the same-origin reverse-proxy pattern and why it exists (cookie scope, no CORS, production-symmetry). Note that the browser reaches `http://localhost:13000/api/*` through the port-forward, and nginx-in-pod proxies to the in-cluster backend Service.
- [ ] 7.5 Document the build-time Vite env baking (`VITE_API_BASE_URL=''`, `VITE_OTEL_ENABLED='true'`, `VITE_OTEL_TRACES_ENDPOINT='http://localhost:4318'`) and call it out as a transitional choice the Hetzner overlay will revisit by rebuilding with production URLs. Reference the `/config.js` follow-up spike.
- [ ] 7.6 Document the registry hostname asymmetry inherited from slice 15 (`127.0.0.1:5000` for push, `registry.local:5000` in the manifest, `host.lima.internal:5000` from the VM via mirror rewrite) — pointer to slice-15's existing README section is fine.
- [ ] 7.7 Update the slice-14 "Local k3s cluster" section's non-goals list to remove "frontend not yet in k3s" (the slice closes that non-goal) while keeping "observability not yet in k3s" and adding "no Ingress; access via port-forward" (rolled forward to `add-cluster-ingress`).

## 8. Validation and archive prep

- [ ] 8.1 Run `openspec validate add-local-k3s-frontend --strict` and resolve any errors.
- [ ] 8.2 Run `openspec show add-local-k3s-frontend --type change --deltas-only` and skim for sanity: requirements added under `kubernetes` and `frontend-scaffold` should show as ADDED; the `kubernetes` namespace requirement and the `monorepo-layout` k8s-base requirement should show as MODIFIED.
- [ ] 8.3 Confirm `git status` is clean except for the slice's expected file set (proposal, design, tasks, three spec deltas under `specs/kubernetes/`, `specs/frontend-scaffold/`, `specs/monorepo-layout/`, plus the implementation touches once they land).
- [ ] 8.4 After implementation lands and CI passes, archive the change with `openspec archive add-local-k3s-frontend --yes` (per the OpenSpec apply-to-archive autonomous flow).
