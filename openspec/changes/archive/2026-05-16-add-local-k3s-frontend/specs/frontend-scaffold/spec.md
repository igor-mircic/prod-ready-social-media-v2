## ADDED Requirements

### Requirement: A multistage Dockerfile builds the production-shape frontend image

The repository SHALL contain a `frontend/Dockerfile` that builds a production-shape OCI image of the frontend in two stages. Stage 1 SHALL be based on `node:22-alpine`, enable pnpm via `corepack enable`, run `pnpm install --frozen-lockfile`, then run `pnpm build` to emit the static bundle. Stage 2 SHALL be based on `nginxinc/nginx-unprivileged:1.27-alpine` (the non-root variant), SHALL copy the builder stage's `dist/` directory to `/usr/share/nginx/html`, and SHALL copy the slice's nginx config to `/etc/nginx/conf.d/default.conf`. The final image SHALL listen on TCP port `8080` and SHALL NOT contain a Node runtime.

#### Scenario: Dockerfile declares two build stages with the documented bases
- **WHEN** a reader inspects `frontend/Dockerfile`
- **THEN** the file declares a builder stage `FROM node:22-alpine AS builder` (or the project's equivalent pinned tag)
- **AND** the file declares a runtime stage `FROM nginxinc/nginx-unprivileged:1.27-alpine` (or the project's equivalent pinned tag)
- **AND** the runtime stage carries no Node binary inherited from the builder

#### Scenario: Dockerfile uses pnpm with the frozen lockfile
- **WHEN** a reader inspects the builder stage in `frontend/Dockerfile`
- **THEN** the stage runs `corepack enable` (or an equivalent pnpm-version-locking mechanism)
- **AND** the stage runs `pnpm install --frozen-lockfile`
- **AND** the stage runs `pnpm build` after installing dependencies

#### Scenario: Runtime stage copies the bundle and the nginx config
- **WHEN** a reader inspects the runtime stage in `frontend/Dockerfile`
- **THEN** the stage contains `COPY --from=builder /app/dist /usr/share/nginx/html` (or an equivalent path mapping)
- **AND** the stage contains `COPY docker/nginx.conf /etc/nginx/conf.d/default.conf` (or an equivalent mapping that lands the slice's nginx config at the conf.d include path)

### Requirement: A `.dockerignore` keeps the frontend build context small

The repository SHALL contain a `frontend/.dockerignore` file that excludes at minimum `node_modules/`, `dist/`, `.git/`, `playwright-report/`, `test-results/`, `*.log`, and any `.env*` files. The exclusions SHALL keep the `docker build` context from accidentally copying multi-hundred-MiB host artifacts into the build daemon.

#### Scenario: `.dockerignore` exists and excludes the documented paths
- **WHEN** a reader inspects `frontend/.dockerignore`
- **THEN** the file excludes `node_modules`
- **AND** the file excludes `dist`
- **AND** the file excludes at least one of `.git` or `.git/`
- **AND** the file excludes `playwright-report` and `test-results`
- **AND** the file excludes `.env*` (or the project's equivalent glob covering all dotenv variants)

### Requirement: The production-shape image bakes the in-cluster Vite env defaults

The `frontend/Dockerfile` builder stage SHALL accept build-time arguments for the three Vite env vars the frontend reads at build time: `VITE_API_BASE_URL`, `VITE_OTEL_ENABLED`, and `VITE_OTEL_TRACES_ENDPOINT`. Their default values, when no `--build-arg` is supplied, SHALL be `''` (empty string), `'true'`, and `'http://localhost:4318'` respectively — the values appropriate for the in-cluster local-overlay topology. The builder stage SHALL expose these as `ENV` so Vite's build-time env resolution picks them up. The runtime image SHALL NOT itself read these env vars at container start (they are baked into the emitted JS bundle).

#### Scenario: Dockerfile declares the three build args with the documented defaults
- **WHEN** a reader inspects the builder stage in `frontend/Dockerfile`
- **THEN** an `ARG VITE_API_BASE_URL` directive exists with a default of `""` (empty string)
- **AND** an `ARG VITE_OTEL_ENABLED` directive exists with a default of `"true"`
- **AND** an `ARG VITE_OTEL_TRACES_ENDPOINT` directive exists with a default of `"http://localhost:4318"`
- **AND** each ARG is exported as an `ENV` of the same name in the builder stage so Vite resolves it during `pnpm build`

#### Scenario: Build with defaults produces an in-cluster-ready bundle
- **WHEN** a developer runs `just frontend-image` (which invokes `docker build -f frontend/Dockerfile -t 127.0.0.1:5000/frontend:dev .` from the repo root) with no `--build-arg` overrides
- **THEN** the resulting image's bundle uses relative URLs for API calls (no absolute origin baked into `/api/*` fetches)
- **AND** the bundle's OTel traces exporter points at `http://localhost:4318`

#### Scenario: Build context is the repo root, not `frontend/`
- **WHEN** a reader inspects the `frontend-image` recipe in `justfile`
- **THEN** the `docker build` invocation passes `-f frontend/Dockerfile` and uses `.` (the repo root) as the build context
- **AND** the rationale is documented (the `frontend/orval.config.ts` postinstall references `../openapi/openapi.json`, which sits at the repo root, so the build context must include both `frontend/` and `openapi/`)
- **AND** a repo-root `.dockerignore` exists that excludes the sibling top-level directories (`backend/`, `e2e/`, `infra/`, `openspec/`) and the usual node/git/log noise so the active build context stays small

### Requirement: A pod-local nginx config lives at `frontend/docker/nginx.conf`

The repository SHALL contain a `frontend/docker/nginx.conf` file declaring a single `server` block that:
- listens on TCP port 8080;
- serves static files from `/usr/share/nginx/html` with `try_files $uri $uri/ /index.html;` (the SPA fallback);
- reverse-proxies `/api/` to `http://backend.social.svc.cluster.local:8080`;
- reverse-proxies `/actuator/` to `http://backend.social.svc.cluster.local:8080`;
- sets the request-forwarding headers `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` on the two proxy blocks.

#### Scenario: Server block listens on 8080
- **WHEN** a reader inspects `frontend/docker/nginx.conf`
- **THEN** the `server` block declares `listen 8080;` (or `listen 8080 default_server;`)

#### Scenario: `/api/` proxy block is configured against the in-cluster backend Service FQDN
- **WHEN** a reader inspects `frontend/docker/nginx.conf`
- **THEN** a `location /api/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`

#### Scenario: `/actuator/` proxy block is configured against the in-cluster backend Service FQDN
- **WHEN** a reader inspects `frontend/docker/nginx.conf`
- **THEN** a `location /actuator/` block declares `proxy_pass http://backend.social.svc.cluster.local:8080;`

#### Scenario: SPA fallback serves index.html
- **WHEN** a reader inspects `frontend/docker/nginx.conf`
- **THEN** a `location /` block declares `try_files $uri $uri/ /index.html;`

#### Scenario: Proxy headers are set
- **WHEN** a reader inspects the `/api/` and `/actuator/` proxy blocks
- **THEN** both blocks declare `proxy_set_header Host $host;`
- **AND** both blocks declare `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
- **AND** both blocks declare `proxy_set_header X-Forwarded-Proto $scheme;`

### Requirement: The production-shape image is registry-pushable and pulls into k3s

The production-shape image SHALL be tagged with a hostname that the slice's `infra/provisioning/install-k3s.sh` registry mirror rewrites for the cluster. After `just frontend-image` (or its equivalent), the image SHALL be pushable to the local OCI registry, and a pod referencing the image by the mirrored hostname SHALL pull successfully from inside the Lima VM without an `ErrImagePull` or `ImagePullBackOff` event.

#### Scenario: Image push to the local registry succeeds
- **WHEN** a developer runs `just frontend-image` (or its underlying `docker push 127.0.0.1:5000/frontend:dev`) with the local registry up
- **THEN** the push exits 0
- **AND** `curl -s http://127.0.0.1:5000/v2/frontend/tags/list` returns a JSON body containing `"dev"` in the tags array

#### Scenario: Pod pulls the frontend image via the mirror
- **WHEN** the host has run `just frontend-image` and an operator applies the local overlay
- **THEN** the frontend pod transitions from `ImagePulling` to `Running` without an `ErrImagePull` or `ImagePullBackOff` event
- **AND** `kubectl describe pod` shows the image was pulled successfully from the mirrored endpoint
