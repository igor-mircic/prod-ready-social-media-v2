# prod-ready-social-media-v2

An enterprise-realistic social media platform built with Java/Spring, React, and Playwright.

## Monorepo layout

This repo is a flat monorepo. Each top-level directory is owned by one component:

| Directory   | Status      | Component                                         |
| ----------- | ----------- | ------------------------------------------------- |
| `backend/`  | exists      | Java 21 / Spring Boot 4 service (Gradle, Postgres) |
| `frontend/` | exists      | React web client (Vite, TypeScript, pnpm)         |
| `e2e/`      | exists      | Playwright end-to-end harness (Testcontainers Postgres + JAR backend + vite preview) |
| `infra/`    | reserved    | Infrastructure-as-code (added by a future scaffold change) |
| `openspec/` | exists      | OpenSpec change/spec workflow                     |

Reserved directories are not pre-created — each is added by its own scaffold change so the repo
never contains empty placeholder folders.

## Local development

The backend's dev loop talks to Postgres on `localhost:5432`. As of slice
`add-local-k3s-postgres`, that Postgres runs inside a local single-node
[k3s](https://k3s.io/) cluster hosted in a [Lima](https://lima-vm.io/) VM
(see [Local k3s cluster](#local-k3s-cluster) below). The opt-in
observability stack still ships via `docker-compose`.

```sh
# One-time: install the host-side tools (see Local k3s cluster below).
brew install lima just kubectl helm libpq

# Bring up the local cluster + apply the postgres workload.
just vm-up
just k8s-apply
```

See `backend/README.md` for backend-specific run and test instructions,
`frontend/README.md` for the frontend dev loop, and `e2e/README.md` for the
Playwright end-to-end harness.

## Local k3s cluster

Postgres has moved from `docker-compose` into a single-node k3s cluster
running inside a Lima VM whose shape (4 vCPU, 8 GiB RAM, arm64, Ubuntu 24.04)
matches the project's eventual Hetzner CAX21 deploy target 1:1. The same
provision script that installs k3s in the Lima VM will install k3s on
Hetzner; the same Kustomize manifests will deploy the same workloads. The
laptop cluster is the dev cluster, not a play-area.

### Prerequisites

```sh
brew install lima just kubectl helm libpq
```

`libpq` provides the host-side `psql` client `just psql` uses; follow brew's
PATH hint after install (or install the full `postgresql` formula instead).
Lima starts containerd-shaped Linux VMs on macOS; on Apple Silicon the arm64
VM runs natively, on Intel Macs Lima falls back to QEMU emulation (functional
but slower).

### Verb surface

| Recipe                 | What it does                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| `just vm-up`           | Boot the Lima VM (first boot installs k3s). Idempotent.                     |
| `just vm-down`         | Stop the VM. On-disk state preserved.                                       |
| `just vm-shell`        | Open an interactive shell inside the VM.                                    |
| `just k8s-apply`       | Render `infra/k8s/overlays/local` and apply. Waits for postgres pod Ready.  |
| `just k8s-diff`        | Show the cluster-vs-manifest delta.                                         |
| `just k8s-delete`      | Tear down every rendered resource in the `social` namespace.                |
| `just psql`            | Open `psql` against the in-cluster postgres via `localhost:5432`.           |
| `just backend-image`   | Build + push the backend image to the local OCI registry.                   |
| `just backend-apply`   | Apply the local overlay; block on backend rollout.                          |
| `just backend-rebuild` | One-shot: `backend-image` then `backend-apply` (95% path).                  |
| `just backend-forward` | `kubectl port-forward svc/backend 18080:8080`.                              |
| `just backend-logs`    | Tail pod logs (`kubectl logs -f`).                                          |
| `just backend-delete`  | Tear down only the backend (label-scoped).                                  |
| `just db-forward-hetzner` | Placeholder; landed by the next slice.                                   |

### Dev loop

```sh
just vm-up         # boots Lima + provisions k3s (first run only — ~2 minutes)
just k8s-apply     # renders the local overlay + applies; blocks until pod Ready
just psql          # connect via localhost:5432; SELECT 1 confirms the loop
./gradlew :backend:bootRun  # backend talks to localhost:5432 unchanged
just vm-down       # at end of day, optional
```

If Lima is down or the host has rebooted, `just vm-up` brings the VM back
from its preserved state and `just k8s-apply` re-asserts the manifests. No
data loss across stop/start; the postgres PVC lives on the VM's disk via
local-path-provisioner.

### Host kubeconfig

The provision step writes a host-friendly kubeconfig at
`~/.lima/lima-social/copied-from-guest/kubeconfig.yaml` with context name
`lima-social`. Point `KUBECONFIG` at it directly, or merge it into
`~/.kube/config`:

```sh
KUBECONFIG=~/.kube/config:~/.lima/lima-social/copied-from-guest/kubeconfig.yaml \
  kubectl config view --flatten > ~/.kube/config.merged && mv ~/.kube/config.merged ~/.kube/config
kubectl config use-context lima-social
```

The apiserver is forwarded to host `:16443` (not `:6443`) so it does not
collide with Docker Desktop's bundled Kubernetes if you have that enabled.

### Run the backend in cluster (optional)

Slice `add-local-k3s-backend` adds a **side-channel** path for running the
backend inside the local k3s cluster as a Deployment. This is purely opt-in:
the canonical dev loop is still `./gradlew :backend:bootRun` against
`localhost:5432`. The e2e harness still spawns the host JVM. IDE run
configurations are unchanged. Nothing in CI exercises the k3s deploy.

The four-recipe flow:

```sh
just backend-image     # build + push: `./gradlew bootBuildImage -Ppublish=true`
just backend-apply     # apply local overlay, block on rollout-status
just backend-forward   # port-forward svc/backend 18080:8080 (separate terminal)
just backend-logs      # tail pod logs (separate terminal)
```

`just backend-rebuild` chains `backend-image` + `backend-apply` for the 95%
iteration path. `just backend-delete` tears down Deployment + Service by the
`app.kubernetes.io/name=backend` label (postgres and registry untouched).

**Registry hostname asymmetry — by design.** Three names refer to the same
local OCI registry, each chosen for the side that uses it:

- **`127.0.0.1:5000`** — what `docker push` targets from the macOS host.
  Plain `localhost:5000` would resolve to `::1` first on macOS, and AirPlay
  Receiver squats on `::1:5000` with a 403, so the IPv4 form is the safe
  choice. The Gradle bake step retags the buildpack output as
  `127.0.0.1:5000/backend:dev` for the push.
- **`registry.local:5000`** — the hostname pods reference in their `image:`
  field. It does NOT resolve on the macOS host (deliberately); it only ever
  appears in pod manifests, where k3s' containerd reads
  `/etc/rancher/k3s/registries.yaml` and finds a mirror entry rewriting it.
- **`host.lima.internal:5000`** — the actual VM-routed address. The
  `registries.yaml` `mirrors:` block rewrites `registry.local:5000` → 
  `http://host.lima.internal:5000` (Lima's host-resolver alias, verified to
  resolve from a pod). This is also marked `insecure_skip_verify: true`
  because the local registry is HTTP-only and unauthenticated.

The asymmetry is documented because it costs each reader once: after that
the layering is obvious (push hostname, manifest hostname, in-VM hostname
are three different concerns and using one name for all three would couple
them).

**OTLP transport — now in-cluster (slice 18a).** The in-cluster backend's
`OTEL_EXPORTER_OTLP_ENDPOINT` points at the in-cluster OTel Collector
Service: `http://collector.social.svc.cluster.local:4318`. The collector
pod (`infra/k8s/base/collector/`) lives in the same `social` namespace and
relays traces to the compose collector via `host.lima.internal:4317`, so
compose Grafana on `:3000` still shows in-cluster backend traces — same
trace count, same redaction outcome, same dashboards. The one difference
versus the slice-15 topology is a single extra hop *inside* the cluster.

The obs cluster (`social-obs`) is NOT yet wired in — its Grafana on `:3001`
remains empty. Slice 18b (`bridge-collectors-to-obs-cluster`) replaces the
collector's `host.lima.internal:4317` exporter target with the obs cluster's
OTLP receiver; slice 22 (`retire-compose-observability`) retires the
compose stack once the obs cluster has absorbed everything. The host
backend's `localhost:4318` default is unchanged — `./gradlew bootRun` still
ships direct to the compose collector.

Rollback shortcut: a one-line edit on `infra/k8s/base/backend/deployment.yaml`
swapping `OTEL_EXPORTER_OTLP_ENDPOINT` back to `http://host.lima.internal:4318`
restores the pre-slice-18a topology immediately; the in-cluster collector
Deployment can then be deleted independently with `kubectl delete deploy,svc,cm
-n social -l app.kubernetes.io/name=collector`.

### Collector relay (in-cluster)

`infra/k8s/base/collector/` declares an `otel/opentelemetry-collector-contrib:0.111.0`
Deployment (single replica) fronted by a ClusterIP Service named `collector`.
The pipeline is one traces pipeline (`otlp` receiver → `batch` +
`transform/redact-path-ids` → `otlp/compose-relay` exporter at
`host.lima.internal:4317`). No CORS on the OTLP/HTTP receiver — only
in-cluster pods talk to it. No metrics or logs pipeline — the Java agent
has `OTEL_METRICS_EXPORTER=none` and `OTEL_LOGS_EXPORTER=none`, and pod
log shipping lives in a future slice.

```sh
just collector-logs     # tail collector pod logs (follow)
just collector-rollout  # rollout-restart the Deployment + wait for Ready
```

`collector-rollout` is the path to pick up ConfigMap edits — the kubelet
does NOT auto-restart pods when a mounted ConfigMap changes. There is no
`collector-image` recipe (the contrib image is a public Docker Hub pin)
and no `collector-forward` (only in-cluster pods dial the OTLP receivers).

**Redaction lives in two places during the transition.** The
`transform/redact-path-ids` OTTL block in `infra/k8s/base/collector/configmap.yaml`
is duplicated verbatim from `infra/observability/collector/collector-config.yaml`
(the compose collector's config). Both files carry a header comment
naming the sibling and warning about drift; slice 22 collapses the two
into one. If you edit one set of OTTL patterns, you MUST edit the other
in the same commit or BE-in-k3s and BE-on-host get asymmetric redaction.

The k3s backend Service is `ClusterIP` only — no Ingress, no LoadBalancer.
The Traefik-vs-ingress-nginx decision deferred in slice 14 stays deferred;
a future `add-cluster-ingress` slice lands it. For now `kubectl port-forward`
to `:18080` is enough — the deliberate non-collision with the host backend's
`:8080` lets both run side-by-side.

### Run the frontend in cluster (optional)

Slice `add-local-k3s-frontend` adds a **side-channel** path for running the
Vite + React frontend inside the local k3s cluster as a Deployment. This is
purely opt-in: the canonical dev loop is still `pnpm dev` (Vite's dev server
on `:5173`), and the e2e Playwright harness still targets the host
`vite preview` on `:4173`. IDE run configurations are unchanged. Nothing in
CI exercises the k3s deploy.

The four-recipe flow:

```sh
just frontend-image     # build + push: docker build → docker push 127.0.0.1:5000/frontend:dev
just frontend-apply     # apply local overlay, block on rollout-status
just frontend-forward   # port-forward svc/frontend 13000:80 (separate terminal)
just frontend-logs      # tail pod logs (separate terminal)
```

`just frontend-rebuild` chains `frontend-image` + `frontend-apply` for the
95% iteration path. `just frontend-delete` tears down Deployment + Service
by the `app.kubernetes.io/name=frontend` label (backend, postgres, and
registry untouched).

Open `http://localhost:13000/` once the port-forward is up. Same-origin
`/api/*` calls hit the in-cluster backend through the pod-local nginx
reverse-proxy (no CORS preflight, no cookie-scope games).

**Same-origin reverse-proxy — by design.** The pod runs `nginx-unprivileged`
on `:8080`. A single `server` block ships three location rules:

- `/api/`      → `proxy_pass http://backend.social.svc.cluster.local:8080;`
- `/actuator/` → same upstream
- `/`          → `try_files $uri $uri/ /index.html;` (SPA fallback so deep-links work)

The browser sees a single origin (`http://localhost:13000` via the
port-forward); nginx-in-pod proxies API calls to the in-cluster backend
Service. The result: cookies set by `/api/v1/auth/login` are visible on
`/api/v1/me` without `SameSite=None` workarounds, and there are no
`Access-Control-Allow-*` headers to configure. The Hetzner overlay aims for
the same shape via Ingress + DNS, so the local overlay is a faithful
rehearsal.

**Strict pairing with the in-k3s backend.** nginx's upstream resolves to the
in-cluster backend Service. If you apply the frontend without the backend,
`/api/*` and `/actuator/*` calls return HTTP 502 because the backend Service
has no endpoints — by design, not a bug. Diagnose with:

```sh
kubectl get endpoints backend -n social
# Empty ENDPOINTS column → run `just backend-apply` first.
```

There is no host-loop fallback (no `host.lima.internal:8080` swap in the
local overlay). The reasons live in `openspec/changes/add-local-k3s-frontend/design.md`
Decision 5.

**Build-time Vite env baking — transitional choice.** The image freezes
three Vite env vars at build time:

- `VITE_API_BASE_URL=''` — empty so the browser hits same-origin (`/api/*`
  resolves to whatever loaded the bundle).
- `VITE_OTEL_ENABLED='true'` — browser OTel stays on.
- `VITE_OTEL_TRACES_ENDPOINT='http://localhost:4318'` — the *browser* runs
  on macOS and reaches the host's OTel Collector directly. Identical to the
  `pnpm dev` transport.

Each environment that needs different URLs gets its own image build (the
Hetzner overlay rebuilds with production values via `--build-arg`). The
`/config.js` runtime-injection pattern that would remove this rebuild step
is captured as a follow-up spike in design.md "Open Questions".

**Build context is the repo root.** `frontend/orval.config.ts` references
`../openapi/openapi.json` for client generation, so `just frontend-image`
runs `docker build -f frontend/Dockerfile -t 127.0.0.1:5000/frontend:dev .`
from the repo root. `frontend/.dockerignore` exists for `frontend/`-scoped
context users; the active ignore file is the repo-root `.dockerignore`.

**Registry hostname asymmetry.** The frontend reuses slice 15's three-name
plumbing unchanged (`127.0.0.1:5000` push, `registry.local:5000` in manifests,
`host.lima.internal:5000` from the VM via mirror rewrite). See "Run the
backend in cluster (optional)" above for the full explanation; no new
asymmetry is introduced here.

### Non-goals (in this slice)

- **No Ingress; access is via `kubectl port-forward`.** The Traefik-vs-
  ingress-nginx decision stays deferred and is rolled forward to a dedicated
  `add-cluster-ingress` slice.
- **The observability stack is NOT yet in k3s.** Prometheus, Grafana, Tempo,
  Loki, the OTel Collector, Alertmanager, the webhook sink, `postgres-exporter`,
  and cAdvisor continue to run under `docker-compose --profile observability`.
- **No production-grade secrets handling.** The local Secret is committed in
  plaintext-equivalent base64; the real-secrets decision happens in the
  Hetzner slice.
- **No production-grade postgres operator.** Bitnami's chart is the entry
  point; see future spikes below.
- **No CI job that brings up the cluster.** Dev-only for now.

### Future spikes (captured here so they're not lost)

- **DIY postgres as Kustomize manifests.** Replace the Bitnami chart install
  with hand-written StatefulSet / headless Service / volumeClaimTemplate /
  PodDisruptionBudget / Secret. Goal: internalise the k8s primitives. The
  spike *replaces* the Bitnami install rather than running alongside it.
- **CloudNativePG migration.** Move postgres to the CNPG operator for
  production-grade backup-to-S3, point-in-time recovery, rolling minor-
  version upgrades, and optional `instances: 3` HA. Sized as its own slice.
- **Swap Traefik for ingress-nginx.** k3s ships Traefik; ingress-nginx is the
  more commonly seen ingress in real-world clusters. The swap is one
  provision-script flag (`--disable traefik`) plus a `helm install`. Trigger:
  the first workload that needs an `Ingress` (likely the backend in k3s).
- **Hetzner provisioning + Hetzner overlay.** `infra/k8s/overlays/hetzner/`
  already exists as a placeholder; the next slice fills it in alongside the
  Hetzner box provisioning script.

## Local observability cluster

Slice `add-local-k3s-obs-cluster` adds a **second** Lima VM
(`social-obs`) running its own single-node k3s cluster, dedicated to
the LGTM observability stack (Prometheus, Loki, Tempo, Grafana,
Alertmanager). It is the local mirror of the project's eventual
production target: two Hetzner boxes, one for app workloads, one for
observability — the cluster you are observing is the cluster most
likely to break, and observability that dies with the workload it
instruments is observability you can't trust during an outage. The
local two-VM shape exercises the cross-cluster primitives (separate
kubeconfig contexts, separate apiservers, separate PKI roots,
push-only data flow) that the production layout needs.

Slice 17 was **pure layout**: the second cluster stood up, the stack
reported Ready, Grafana loaded with an empty data sources list. Data
started flowing in slice 18a (app cluster collector relays to compose)
and slice 18b (app cluster collector dual-writes to BOTH compose AND
the obs cluster collector; obs Grafana grows four provisioned
datasources). See the [Bridging to the obs cluster](#bridging-to-the-obs-cluster)
subsection below for the current dual-write topology.

### Prerequisites

Same as [Local k3s cluster](#local-k3s-cluster) above
(`brew install lima just kubectl helm`). No new packages.

### Verb surface

| Recipe            | What it does                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `just obs-up`     | Boot the obs Lima VM (first boot installs k3s). Idempotent.               |
| `just obs-down`   | Stop the obs VM. On-disk state (PVC contents) preserved.                  |
| `just obs-status` | One-shot summary: `limactl list`, node, pods/pvc/svc in `observability`.  |
| `just obs-apply`  | Render `infra/k8s-obs/overlays/local` and apply. Waits for all pods Ready.|
| `just obs-diff`   | Show the cluster-vs-manifest delta for the obs overlay.                   |
| `just obs-delete` | Tear down every resource the obs local overlay renders.                   |
| `just obs-grafana`| `kubectl port-forward svc/grafana 3001:80` (separate terminal).           |

### Dev loop

```sh
just obs-up        # boots second Lima VM + k3s (first run only — ~2 minutes)
just obs-apply     # renders the local overlay + applies; waits for all pods Ready
just obs-grafana   # port-forward svc/grafana 3001:80 (separate terminal)
# open http://localhost:3001 — log in (admin / obs-local-dev)
# Configuration → Data sources should be EMPTY — that's the expected
# slice-17 end state. Data flows in starting from slice 18.
just obs-down      # at end of day, optional — pair with `just vm-down` to stop both
```

Default grafana admin credentials (local-dev only):

```
user:     admin
password: obs-local-dev
```

The Secret is committed at `infra/k8s-obs/base/grafana/secret.yaml`
and is labeled `social.io/credential-scope: local-dev` so a grep makes
it obvious. The Hetzner overlay
(`infra/k8s-obs/overlays/hetzner/kustomization.yaml`) MUST NOT reuse
this credential — the placeholder there spells the substitution out.

### Host kubeconfig

The obs cluster's kubeconfig lands at
`~/.lima/social-obs/copied-from-guest/kubeconfig.yaml` with context
name `social-obs`. The host-side apiserver port is `16444` (not
`6443`, which is Docker Desktop's k8s; not `16443`, which is the app
cluster's; not `6444`, which lima-social already auto-forwards from
its in-VM kube-scheduler). Merge into `~/.kube/config` the same way
as the app cluster:

```sh
KUBECONFIG=~/.kube/config:~/.lima/social-obs/copied-from-guest/kubeconfig.yaml \
  kubectl config view --flatten > ~/.kube/config.merged && mv ~/.kube/config.merged ~/.kube/config
# Both contexts coexist; switch with --context or `kubectl config use-context`.
kubectl --context social-obs get nodes
kubectl --context lima-social get nodes  # the app cluster, unchanged
```

### Non-goals (in the slice-17 layout work)

- ~~**No data flow.** Nothing in the app cluster talks to the obs
  cluster yet.~~ **Superseded by slice 18b.** The app cluster
  collector now dual-writes backend traces to the obs cluster
  collector via `host.lima.internal:14317` (Lima portForward ->
  klipper-lb -> obs collector pod). Obs Grafana renders the same
  backend traces compose Grafana renders, with four provisioned
  datasources (Tempo, Prometheus, Loki, Alertmanager — only Tempo
  has data today; Loki / Prometheus / Alertmanager render "no
  data" until slices 20 / 21 / future). See the
  [Bridging to the obs cluster](#bridging-to-the-obs-cluster)
  subsection below.
- **No cross-cluster mTLS.** The obs cluster's OTLP receiver
  (introduced in slice 18b) starts with no auth. mTLS is its own
  slice (slice 19, `add-cross-cluster-mtls`).
- **No retirement of the host docker-compose observability stack.**
  Compose continues to receive app telemetry on `:4318` throughout
  this slice. Retirement happens in slice 22
  (`retire-compose-observability`) after the obs cluster has
  demonstrably absorbed everything compose was doing.
- **No Prometheus Operator / kube-prometheus-stack.** Each LGTM
  component is a separately-pinned Helm chart deliberately — the
  Operator's ~30 CRDs hide too much for the learning intent of this
  project. See
  `openspec/changes/add-local-k3s-obs-cluster/design.md` Decision 3.
- **No CI integration.** The obs cluster is local-only for now.
- **No Ingress.** Grafana, Prometheus, etc. are reached via
  `kubectl port-forward`. The `add-cluster-ingress` slice (if it
  lands before Hetzner deploy) settles Traefik-vs-ingress-nginx.

### Forward arc (the next six slices)

`add-local-k3s-obs-cluster` is the first of a 7-slice arc that moves
observability from compose-on-host to a two-cluster-on-Hetzner
production deploy. The arc is sequenced so each slice is
independently revertable and the visibility-into-the-app-cluster
property is never broken.

1. **slice 17** `add-local-k3s-obs-cluster` — second Lima VM + k3s
   + empty LGTM stack. (this slice)
2. **slice 18** `add-k3s-app-collector` — otel-collector in the app
   cluster; backend OTLP target flips to the obs cluster; grafana
   gets datasources. App traces visible in obs-cluster grafana.
3. **slice 19** `add-cross-cluster-mtls` — self-signed CA + TLS
   certs in both clusters; cross-cluster OTLP becomes mTLS only.
4. **slice 20** `add-k3s-pod-log-shipping` — DaemonSet ships pod
   logs over OTLP to the obs cluster's loki. (done)
5. **slice 21** `add-k3s-cluster-metrics` — kubeletstats + hostmetrics
   + k8s_cluster receivers on per-node DaemonSet and singleton
   Deployment agents; cluster-overview dashboard in obs grafana. (done)
6. **slice 22** `retire-compose-observability` — delete compose
   prometheus/grafana/tempo/loki/alertmanager/collector; migrate
   any remaining dashboards/rules; obs lives only in the obs cluster.
7. **slice 23** `add-hetzner-deploy` — overlays/hetzner for app
   cluster + overlays/hetzner for obs cluster; cert-manager + Let's
   Encrypt; real two-box prod deploy.

See
`openspec/changes/add-local-k3s-obs-cluster/design.md` "Future
Slices in This Arc" for the full sequencing rationale.

### Cost of the two-VM shape

Running both VMs concurrently commits ~16 GiB RAM (8 per VM) and
~128 GiB disk allocation (64 per VM). On a typical 16–32 GiB
developer machine, the obs VM is opt-in: `just obs-up` when working
on observability, `just obs-down` when not. The app cluster runs
independently — stopping the obs VM has zero impact on
`./gradlew :backend:bootRun`, the e2e harness, or compose. The cost
is the honest price of an honest local mirror; a namespace-split
shortcut would not exercise the cross-cluster auth / network /
discovery primitives the production deploy needs (design.md
Decision 1).

### Bridging to the obs cluster

Slice `bridge-collectors-to-obs-cluster` (slice 18b) closes the
data-plane gap that slice 17 left open. After this slice, the in-
cluster app collector **dual-writes** backend traces: every batch
goes to BOTH the compose collector (slice 18a's existing path) AND
to a new collector tier inside the obs cluster. Compose Grafana on
`:3000` and obs Grafana on `:3001` show the same backend trace
data side-by-side — that side-by-side rendering is the operator
confidence signal for the obs-cluster migration. Slice 22
(`retire-compose-observability`) is the slice that finally
collapses dual-write back to obs-only.

Topology of the trace path (slice 19 wraps the obs-cluster leg in mTLS;
compose-relay leg stays plaintext, retires in slice 22):

```
backend pod
  └── OTLP/HTTP -> collector.social.svc.cluster.local:4318
                       (app cluster collector — single-pod Deployment)
                       │
                       ├── otlp/compose-relay -> host.lima.internal:4317        [plaintext]
                       │                            (compose collector
                       │                             -> compose Tempo
                       │                             -> compose Grafana :3000)
                       │
                       └── otlp/obs-cluster   -> host.lima.internal:14317       [mTLS, slice 19]
                                                    (TLS terminates on the obs collector's
                                                     OTLP receiver; client cert presented
                                                     from /etc/otelcol-contrib/certs/client.crt,
                                                     server cert verified against
                                                     /etc/otelcol-contrib/certs/ca.crt)
                                                    (obs VM :4317 via Lima portForward — L4,
                                                     TLS bytes flow through transparently
                                                     -> klipper-lb -> obs collector pod
                                                     -> in-cluster otlp/tempo (plaintext, same cluster)
                                                     -> tempo.observability.svc.cluster.local:4317
                                                     -> obs Grafana :3001)
```

`host.lima.internal:14317` is the local mirror of the Hetzner
reality (the obs box's tailscale / private-network IP terminated
with mTLS); the `+10000` offset on the host-side port avoids
collision with the compose collector's already-published `:4317`
and is symmetric with the apiserver disambiguation (app `:16443`,
obs `:16444`). The obs-cluster leg becomes authenticated +
encrypted in slice 19 (`add-cross-cluster-mtls`) — see
[Cross-cluster mTLS](#cross-cluster-mtls) below for the cert
layout, the regeneration recipe, and the trust-model continuity
with slice 23's Hetzner deploy.

Obs Grafana grows four provisioned datasources in this slice:
**Tempo**, **Prometheus**, **Loki**, **Alertmanager** — each
pointing at the corresponding in-cluster Service in the
`observability` namespace. Only Tempo carries real data today;
the others render *"no data"* until their data-plane slices
land (slice 20 for Loki via pod log shipping, slice 21 for
Prometheus via cluster metrics, future alerting slice for
Alertmanager). All four are pre-staged now so later slices add
data, not datasource-configuration churn.

**Non-goal (this slice):** there is no auth on the obs cluster's
OTLP receiver yet. The receiver accepts cleartext OTLP from
anything that reaches it on `host.lima.internal:14317`. On the
Lima loopback this is fine (no off-host reachability); on Hetzner
it is NOT. Slice 19 (`add-cross-cluster-mtls`) introduces the
cert material on the receiver before any cross-network deploy.

#### Operator cutover after pulling this slice

```sh
# 1. Pick up the new Lima portForwards on the EXISTING obs VM.
#    Lima snapshots the source yaml at instance creation, so a
#    plain `limactl start` reads the stale persisted copy — and
#    `just obs-up` errors with "instance already exists". Patch
#    the persisted yaml in-place with `limactl edit --set`,
#    then stop+start. (If you don't have a `social-obs` VM yet,
#    `just obs-up` reads `infra/lima/obs.yaml` directly and
#    this step is unnecessary — skip to step 2.)
limactl edit social-obs --set '
  .portForwards = [
    .portForwards[0],
    {"guestIP": "0.0.0.0", "guestPort": 4317, "hostPort": 14317},
    {"guestIP": "0.0.0.0", "guestPort": 4318, "hostPort": 14318},
    .portForwards[1]
  ]'
limactl stop social-obs && limactl start social-obs

# 2. Apply the obs cluster manifests (new collector, four
#    datasources in grafana).
kustomize build --enable-helm infra/k8s-obs/overlays/local \
  | kubectl --context social-obs apply -f -

# 3. Apply the app cluster updates (dual-write traces pipeline)
#    and roll the app collector so kubelet remounts the new
#    ConfigMap.
just backend-apply
just collector-rollout
```

Then, in two terminals, tail both collectors:

```sh
just collector-logs      # app cluster collector
just obs-collector-logs  # obs cluster collector
```

Generate traffic against the app (open the frontend, post
something). The app collector logs report non-zero accepted spans
and no `otlp/obs-cluster` exporter errors; the obs collector
logs report non-zero accepted spans. Open `http://localhost:3000`
(compose Grafana) and `http://localhost:3001` (`just obs-grafana`,
obs Grafana) and query `service.name=backend` in Tempo — same
traces in both, matching trace IDs.

#### Degraded mode — obs VM down

The dual-exporter design is independent-failure by construction.
Stopping the obs VM with `limactl stop social-obs` does NOT block
the compose path: the app collector logs `otlp/obs-cluster`
exporter errors every batch interval (connection refused / dial
timeout) but continues to deliver to `otlp/compose-relay`, and
compose Grafana keeps rendering recent traces. Bringing the obs
VM back up with `just obs-up` recovers the exporter automatically
— no app-collector restart required.

#### Troubleshooting

If `just collector-logs` shows `otlp/obs-cluster` connection
errors, check in order:

- `kubectl --context social-obs -n observability get svc collector -o wide`
  — `EXTERNAL-IP` should be the obs VM's primary IP (e.g.
  `192.168.5.15`), NOT `<pending>`. `<pending>` means klipper-lb
  has not yet assigned an IP; usually a fresh `obs-up` resolves
  it.
- `lsof -nP -iTCP:14317 -sTCP:LISTEN` on the host — should show
  `limactl` listening on `127.0.0.1:14317`. If the listener is
  absent, the Lima portForward did not take effect; see the next
  bullet. If the listener is on `127.0.0.1:4317` instead,
  Lima's auto-forwarder fell back to the default port mapping
  — the `guestIP: 0.0.0.0` portForward rule is missing.
- `limactl list` — `social-obs` must be in `Running` state. A
  stopped VM has no portForwards.
- **An existing `social-obs` VM does NOT pick up edits to
  `infra/lima/obs.yaml`.** Lima snapshots the source yaml at
  instance creation; subsequent `limactl start` calls use the
  per-instance persisted yaml at
  `~/.lima/social-obs/lima.yaml`. After pulling a slice that
  edits `obs.yaml` (e.g. slice 18b adding the OTLP forwards),
  the operator MUST do ONE of:
  - `limactl edit social-obs --set '<yq expr>'` — preserves
    k3s state, surgical mutation. For slice 18b:
    ```sh
    limactl edit social-obs --set '
      .portForwards = [
        .portForwards[0],
        {"guestIP": "0.0.0.0", "guestPort": 4317, "hostPort": 14317},
        {"guestIP": "0.0.0.0", "guestPort": 4318, "hostPort": 14318},
        .portForwards[1]
      ]'
    limactl stop social-obs && limactl start social-obs
    ```
  - `limactl delete social-obs && just obs-up` — destructive
    (drops the obs cluster's PVCs and k3s state), but the
    repeatable green-field path.

  A bare `limactl stop social-obs && just obs-up` does NOT help
  for an existing instance — `just obs-up` invokes
  `limactl start --name=social-obs infra/lima/obs.yaml` which
  errors with *"instance already exists"* on an existing
  instance, and a plain `limactl start social-obs` reads the
  stale persisted yaml.

## Logging in locally

Once Postgres, the backend, and the frontend dev server are running:

1. Visit `http://localhost:5173/signup` and create an account (`POST /api/v1/auth/signup`).
2. Visit `http://localhost:5173/login` and sign in with the same email/password
   (`POST /api/v1/auth/login`). The response sets a refresh-token `HttpOnly` cookie
   scoped to `/api/v1/auth/refresh`; the access token lives in memory only.
3. The SPA lands on `/home`, which calls `GET /api/v1/auth/me` to render the
   current user, and offers a Logout button (`POST /api/v1/auth/logout`).

Default token TTLs (overridable via `app.auth.access-token-ttl` and
`app.auth.refresh-token-ttl` in `application.yaml`):

- access token: 15 minutes (`PT15M`)
- refresh token: 30 days (`P30D`)

## Posting locally

After logging in (see above), the `/home` page also renders the posts feature
for the signed-in user:

1. A "New post" composer accepts a non-empty body up to 500 characters. The
   `Post` button stays disabled while the body is empty or whitespace-only.
2. Submitting posts to `POST /api/v1/posts`. On success the list below the
   composer refetches and the new post appears at the top.
3. The list is cursor-paginated (`GET /api/v1/users/{userId}/posts`). When the
   server returns a `nextCursor`, a "Load more" button fetches the next page.
4. Each post you authored renders a Delete control that soft-deletes the post
   via `DELETE /api/v1/posts/{id}` and refetches the list.

The per-endpoint contract lives in `openapi/openapi.json`; the generated
TanStack Query hooks under `frontend/src/api/generated/queries/posts-controller/`
are the source of truth for how the SPA calls those endpoints.

## Local observability

The backend exposes Prometheus-format metrics at `/actuator/prometheus`; an
opt-in compose profile brings up a local Prometheus + Grafana to scrape and
visualise them. As of slice `add-local-k3s-postgres`, `postgres-exporter`'s
`DATA_SOURCE_URI` has been retargeted from the now-deleted in-compose
`postgres` service to `host.docker.internal:5432` — the same Lima-forwarded
port the backend talks to. See [Local k3s cluster](#local-k3s-cluster) for
the workload that now lives behind that port.

**Two parallel observability stacks — transitional state.** As of slice
`add-local-k3s-obs-cluster`, a second LGTM stack runs inside a dedicated
Lima VM / k3s cluster — see
[Local observability cluster](#local-observability-cluster) above. The
compose stack documented in *this* section is still primary and still
receives app telemetry on `:4318` (from the browser SDK and from the host
backend) plus `:4317` (from the in-cluster collector's relay). As of
slice `bridge-collectors-to-obs-cluster` (18b) the app cluster collector
ALSO dual-writes traces to the obs cluster collector on
`host.lima.internal:14317`; slice `add-cross-cluster-mtls` (19) wraps that
cross-VM leg in mutual TLS against a shared self-signed CA (see
[Cross-cluster mTLS](#cross-cluster-mtls) below). **Both** compose Grafana
(`:3000`) and obs Grafana (`:3001`) now show the same backend trace data
side-by-side. The
browser still posts spans cross-origin to the compose collector
exclusively until slice 18c flips that path. **Today** (slices 17, 18a,
18b), use compose Grafana on `:3000` for the full picture (BE + FE
traces) and obs Grafana on `:3001` to verify the obs cluster has
absorbed the BE traces. **Tomorrow** (post-slice-22), the in-cluster
Grafana on `:3001` will be the only target — at which point this
section will move to the obs cluster cross-link entirely and the
compose stack will be retired.

**BE-in-k3s telemetry path (slice 18a).** When the backend runs inside the
local k3s cluster (`just backend-apply`), its OTel Java agent no longer
dials `host.lima.internal:4318` directly. Instead it ships OTLP/HTTP to
the in-cluster collector Service at `collector.social.svc.cluster.local:4318`;
the collector then relays the spans to the compose collector via
`host.lima.internal:4317` (OTLP/gRPC). Compose Grafana still shows in-cluster
backend traces unchanged — just with one extra in-cluster hop on the way.
The host backend (`./gradlew bootRun`) is unaffected; it continues to ship
direct to `localhost:4318`. See
[Run the backend in cluster (optional)](#run-the-backend-in-cluster-optional)
for the recipe surface and the rollback shortcut.

**Browser OTLP path (slice 18c).** Browser telemetry no longer ships
cross-origin direct to the compose collector. Three signals (traces, logs,
metrics) leave the browser as same-origin POSTs to relative paths
`/v1/traces`, `/v1/logs`, `/v1/metrics`. Two reverse-proxy surfaces resolve
those relative URLs:

- **In-k3s (production-shape):** the frontend pod's nginx (`frontend/docker/nginx.conf`)
  carries a `location /v1/` block that `proxy_pass`es to the in-cluster
  collector Service at `collector.social.svc.cluster.local:4318`. Browser
  origin and collector origin are the same (`:13000` via
  `just frontend-forward`), so no CORS preflight is involved.
- **Dev loop (`pnpm dev` on `:5173`, `pnpm preview` on `:4173`):**
  `frontend/vite.config.ts` declares `/v1/{traces,logs,metrics}` proxy
  entries under both `server.proxy` and `preview.proxy`, targeting
  `http://localhost:4318` (the compose collector). The browser sees
  same-origin URLs; the vite dev server forwards them to the compose
  collector. **Running `pnpm dev` therefore requires
  `docker compose --profile observability up -d` so the vite proxy has a
  target** — otherwise the `/v1/*` POSTs return 502 from vite.

The OTel browser SDK exporters' fetch transport wraps the configured URL in
`new URL(url)` before posting, which rejects path-only strings without a
base. `frontend/src/observability/endpoint.ts` provides a small
`resolveEndpointUrl` shim that prefixes `globalThis.location.origin` for
relative paths; absolute URLs pass through unchanged. Both
`tracer.ts`/`errors.ts`/`meter.ts`'s `DEFAULT_ENDPOINT` and the Dockerfile's
`VITE_OTEL_*_ENDPOINT` build args are the relative `/v1/*` paths.

No CORS allowlist exists anywhere in the chain: the compose collector's
`receivers.otlp.protocols.http.cors` block was deleted in this slice, and
the obs k3s collector never carried one. From the app k3s collector
onward, browser-emitted signals fan out symmetrically with backend traces
— logs and metrics dual-write to both the compose collector
(`host.lima.internal:4318`) and the obs k3s collector
(`host.lima.internal:14318`) so compose Grafana and obs Grafana stay
side-by-side comparable until slice 22 retires the compose path.

```sh
docker-compose --profile observability up -d
```

- Grafana: `http://localhost:3000` (anonymous viewer access; lands directly on
  the provisioned `Backend overview` dashboard).
- Prometheus: `http://localhost:9090`.
- Tempo: `http://localhost:3200` (queried via the Grafana `Tempo` datasource,
  no standalone UI).

Anonymous viewer access is for local development only — production would gate
the dashboard behind OIDC or basic auth.

### Cross-cluster mTLS

Slice `add-cross-cluster-mtls` (slice 19) wraps the app-cluster → obs-cluster
OTLP path in mutual TLS. Before this slice, the three `*obs-cluster*` exporters
on the app collector (`otlp/obs-cluster`, `otlphttp/obs-cluster-logs`,
`otlphttp/obs-cluster-metrics`) shipped plaintext OTLP over
`host.lima.internal:14317/14318`; after this slice, every cross-VM byte is
encrypted and authenticated against a shared self-signed CA. The compose-relay
leg of the dual-write keeps shipping plaintext to the in-host compose collector
(it dies in slice 22 — layering mTLS on a doomed path is churn for zero
benefit).

**Trust anchor.** One self-signed CA lives at
`infra/observability/certs/ca.crt` (public, committed). Its private key
(`ca.key`) is gitignored and regenerated by the recipe. The same CA cert is
copied into both per-cluster directories so each side can verify the other's
leaf at handshake time.

**Cert layout.**

```
infra/observability/certs/
  ca.crt              public, committed (10-year self-signed CA)
  ca.key              private, gitignored
  openssl.cnf         committed (subject DNs + extension blocks)
  .gitignore          excludes *.key
infra/k8s-obs/base/collector/certs/
  server.crt          public, committed (1-year obs receiver cert,
                      SANs: host.lima.internal / localhost /
                      collector.observability.svc.cluster.local)
  server.key          private, gitignored
  ca.crt              copy of the CA cert
  .gitignore          excludes *.key
infra/k8s/base/collector/certs/
  client.crt          public, committed (1-year app exporter cert,
                      subject CN: app-collector)
  client.key          private, gitignored
  ca.crt              copy of the CA cert
  .gitignore          excludes *.key
```

The cert material is mounted into each collector pod via a Kustomize
`secretGenerator` in the per-cluster collector `kustomization.yaml`. The
generator hashes contents into the Secret name suffix, so re-running
`just obs-certs` (which re-keys every leaf) produces a new Secret name and the
next `kubectl apply -k …` rolls the pod automatically — rotation is one
command, no `kubectl rollout restart` ceremony.

**(Re-)generate.** `just obs-certs` drives openssl end-to-end (CA → server
leaf → client leaf, copies of `ca.crt` distributed to both per-cluster
directories). The recipe is idempotent — re-running regenerates every artifact.
`just obs-up` invokes `obs-certs` automatically if `ca.crt` is missing, so a
fresh clone is a single `just obs-up && just k8s-apply` away.

```sh
just obs-certs   # generate or rotate
openssl verify -CAfile infra/observability/certs/ca.crt \
  infra/k8s-obs/base/collector/certs/server.crt \
  infra/k8s/base/collector/certs/client.crt
```

**Loud failure if certs are missing.** No silent plaintext fallback (that's
exactly what mTLS exists to prevent). If `ca.crt` is missing when `obs-up`
runs, the recipe regenerates the whole tree. If a leaf cert is missing or
corrupt, the app collector logs `tls: handshake error` against every
`*obs-cluster*` exporter and the obs collector logs `bad certificate`
rejections — the recovery is `just obs-certs` followed by
`kubectl apply -k infra/k8s/overlays/local` (or the equivalent for the obs
overlay). The compose-relay leg of the dual-write is independent and keeps
delivering, so compose Grafana on `:3000` is still useful as a diagnostic
during a misconfigured-cert window.

**otelcol-contrib v0.111.0 receiver-side quirk.** The base `images:` pin is
`otel/opentelemetry-collector-contrib:0.111.0`. In that release, configtls's
`ServerConfig` has no `require_client_cert` toggle (added in v0.112.0+); setting
`client_ca_file` alone implicitly forces `tls.RequireAndVerifyClientCert` on
the gRPC and HTTP servers, which is the same end behavior. The obs collector's
`configmap.yaml` carries a comment naming the divergence so the next image bump
can flip on the explicit `require_client_cert: true` for self-documentation
without changing runtime behavior.

**Non-goals (this slice).** The `*compose-relay*` exporters stay plaintext —
the compose-collector leg of the dual-write retires in slice 22, layering mTLS
on it would be wasted work. cert-manager + ACME / Let's Encrypt and automated
rotation defer to slice 23 (`add-hetzner-deploy`): the slice-19 trust model
(shared self-signed CA) carries forward unchanged; only the cert *distribution*
mechanism (recipe vs cert-manager-managed `Certificate` CRs backed by a
self-signed `ClusterIssuer`) changes. mTLS on intra-cluster traffic (backend
pod → app collector ClusterIP, frontend nginx → app collector ClusterIP)
remains a separate concern.

### Structured logs

The backend emits one Elastic Common Schema (ECS) JSON object per log event on
stdout (Spring Boot's native `logging.structured.format.console: ecs`), so a
local `bootRun` already produces the same shape a log shipper would index in
production. Every line carries `@timestamp`, `log.level`, `service.name`,
`service.environment`, `process.thread.name`, `log.logger`, `message`, and
`ecs.version`; per-request lines additionally carry `request.id` (and
`user.id` once Spring Security has authenticated the caller).

Each HTTP request emits exactly one access-log line on `event.dataset=backend.access`
summarising method, route template, status, and duration:

```json
{"@timestamp":"2026-05-13T14:00:00Z","log":{"level":"INFO","logger":"backend.access"},
 "service":{"name":"backend","environment":"local"},"process":{"thread":{"name":"http-nio-8080-exec-1"}},
 "event":{"dataset":"backend.access","duration":3241000},"http":{"request":{"method":"GET"},
 "response":{"status_code":200}},"url":{"path":"/api/v1/auth/me"},"duration_ms":3,
 "request":{"id":"7d7c2e8e-1b1a-4d2f-8a4f-9bb6f9c1c0a1"},"user":{"id":"…"},
 "message":"","ecs":{"version":"8.11"}}
```

`/actuator/health` and `/actuator/prometheus` are deliberately skipped so the
per-15-second Prometheus scrape does not flood the log.

Each response carries the correlation id back to the client as `X-Request-Id`,
and the filter honours an inbound `X-Request-Id` header verbatim if the caller
already issued one (so an upstream proxy's id wins):

```sh
curl -i -H 'X-Request-Id: my-correlation-id' http://localhost:8080/api/v1/auth/me
# < HTTP/1.1 401
# < X-Request-Id: my-correlation-id
```

Grep one request's lifetime out of `bootRun` stdout with `jq`:

```sh
./gradlew :backend:bootRun 2>&1 | jq -c 'select(.request.id == "my-correlation-id")'
```

### Distributed tracing

The backend attaches the [OpenTelemetry Java agent](https://opentelemetry.io/docs/zero-code/java/agent/)
to every JVM entry point (`bootRun`, the `bootJar` launcher used by the e2e
harness, and the integration-test JVM). The agent auto-instruments Spring MVC,
HikariCP, JDBC, the slice-1 `@Timed` business methods, and any future outbound
HTTP, emitting one span per call. The same compose profile that brings up
Prometheus and Grafana now also brings up [Tempo](https://grafana.com/oss/tempo/)
as the local span store:

```sh
docker-compose --profile observability up -d
```

Spans flow from the agent to Tempo at `http://localhost:4318` over OTLP/HTTP
(no separate OpenTelemetry Collector — the agent ships direct for now;
slice 4 introduces the collector alongside Loki for log shipping).

Every request log line now carries populated `trace.id` and `span.id` ECS
fields. The MDC keys the agent populates (Logstash-style `trace_id`,
`span_id`, `trace_flags`) are remapped to ECS-canonical nested keys by
`EcsTraceFieldsCustomizer` so each line uses exactly one naming convention:

```json
{"@timestamp":"2026-05-13T14:00:00Z","log":{"level":"INFO","logger":"backend.access"},
 "service":{"name":"backend","environment":"local"},"process":{"thread":{"name":"http-nio-8080-exec-1"}},
 "event":{"dataset":"backend.access","duration":3241000},"http":{"request":{"method":"GET"},
 "response":{"status_code":200}},"url":{"path":"/api/v1/auth/me"},"duration_ms":3,
 "request":{"id":"7d7c2e8e-1b1a-4d2f-8a4f-9bb6f9c1c0a1"},"user":{"id":"…"},
 "trace":{"id":"a3c1f4e2b7d8c9106e5a4b3c2d1e0f9a","flags":"01"},
 "span":{"id":"b2c3d4e5f6071829"},
 "message":"","ecs":{"version":"8.11"}}
```

Manual log-to-trace correlation works as a copy-paste:

1. `jq -c 'select(.url.path == "/api/v1/auth/me")'` over `bootRun` stdout to
   find the request's access-log line.
2. Copy the value of `trace.id`.
3. Open Grafana at `http://localhost:3000`, switch the explore datasource to
   `Tempo`, paste the trace id into the search box, hit run — the span tree
   for that request renders.

The one-click `tracesToLogs` and `logsToTraces` pivots (no copy-paste) are
wired by the `### Log shipping` subsection below.

### Log shipping

The same compose profile that brings up Prometheus, Grafana, and Tempo also
brings up an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
and [Loki](https://grafana.com/oss/loki/):

```sh
docker-compose --profile observability up -d
```

The Collector replaces Tempo as the listener on host ports `4317` and
`4318`. The OTel agent's `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
is unchanged — only the container behind the port differs. Tempo's
`http://localhost:3200` HTTP API binding stays for direct curl debugging;
Tempo's OTLP host port bindings are retired in favour of the Collector
(Tempo is now reachable only as `tempo:4317` inside the docker network).

To enable the file appender the Collector tails, export `LOG_FILE_PATH`
before starting the backend:

```sh
export LOG_FILE_PATH=./infra/observability/logs/backend.json
./gradlew :backend:bootRun
```

With `LOG_FILE_PATH` set, the backend writes the same ECS JSON to that file
alongside its stdout output. The Collector's `filelog` receiver tails the
host directory (bind-mounted into the Collector container) and ships each
line to Loki. Without `LOG_FILE_PATH` set, the file appender does not
engage and the dev loop is byte-identical to the slice 2 / slice 3 default.

In Grafana:

- **`logsToTraces`** (Loki → Tempo): a `trace.id` value in any Loki log
  line renders as a clickable link; clicking it opens the matching Tempo
  span tree.
- **`tracesToLogs`** (Tempo → Loki): from a Tempo span view, the "Logs for
  this span" link opens the matching Loki log lines, scoped by `trace.id`.
- The slice-3 manual workflow ("copy `trace.id` and paste into Tempo
  search") still works, but is no longer necessary.

The host directory (`./infra/observability/logs/`) is committed (with a
`.gitkeep` placeholder) so the Collector's bind-mount target exists on a
fresh clone; the `*.json` content in that directory is gitignored.

### k3s pod log shipping

Slice 20 (`add-k3s-pod-log-shipping`) closes the second of three signal
gaps on the obs cluster — backend pod logs join the cross-cluster
transport spine alongside browser FE error logs (slice 18c) and backend
traces (slices 18a/b). A new `log-agent` DaemonSet under
`infra/k8s/base/log-agent/` runs one OpenTelemetry Collector pod per
node, tails `/var/log/pods/social_*/*/*.log` (the kubelet's CRI log
directory, scoped to the `social` namespace), JSON-parses backend stdout
at the agent, enriches every record with k8s attributes
(`k8s.namespace.name`, `k8s.pod.name`, `k8s.container.name`,
`k8s.node.name`, plus the workload-level `app.kubernetes.io/name`
label), and ships the result OTLP/gRPC plaintext to the in-cluster
gateway collector. The gateway then carries it through the slice-19
mTLS envelope to the obs cluster's Loki — single cross-cluster security
boundary, single redaction pass.

```
  ┌───────────────────────────────────────────────────┐
  │ app cluster (lima-social)                         │
  │                                                   │
  │  /var/log/pods/social_backend-*/backend/0.log     │
  │            │                                      │
  │            ▼                                      │
  │   ┌──────────────────┐                            │
  │   │ log-agent        │  filelog → CRI strip       │
  │   │ DaemonSet        │  → router (JSON vs text)   │
  │   │                  │  → json_parser → severity  │
  │   │                  │  → k8sattributes → batch   │
  │   └────────┬─────────┘                            │
  │            │ OTLP/gRPC :4317 (plaintext, in-cluster)
  │            ▼                                      │
  │   ┌──────────────────┐                            │
  │   │ gateway          │  batch → redact-path-ids   │
  │   │ collector        │  → filter/exclude-obs-self │
  │   │ (logs pipeline)  │  → dual-write              │
  │   └────────┬─────────┘                            │
  │            │ mTLS (slice 19)                      │
  └────────────┼──────────────────────────────────────┘
               ▼
       host.lima.internal:14318 → obs cluster Loki → obs grafana
```

Apply behavior — the DaemonSet ships with the base overlay, so
`just k8s-apply` rolls it out the same way it rolls out the backend,
frontend, postgres, and gateway collector. No separate verb needed.

End-to-end loop on the local mirror:

```sh
just vm-up           # app cluster (no-op if running)
just obs-up          # obs cluster (no-op if running)
just k8s-apply       # rolls out log-agent + the renamed gateway filter
just backend-forward # in a side terminal; port-forward backend :8080 -> :18080
curl http://localhost:18080/actuator/health   # generates an INFO log line
just obs-grafana     # in a side terminal; obs grafana on :3001
# In obs grafana → Explore → Loki, query:
#   {k8s_namespace_name="social", k8s_container_name="backend"}
# The line from `kubectl logs deploy/backend -n social --tail=1` appears
# within ~30 seconds, carrying trace_id / span_id / k8s_pod_name /
# k8s_node_name as label dimensions.
```

Trace-to-logs correlation lights up automatically: any Loki entry with
a `trace_id` field renders a "View trace" link that navigates to the
matching Tempo span tree. The MDC normalization happens at the agent
(dotted `trace.id` / `span.id` → underscored `trace_id` / `span_id`)
because Grafana's correlation expects the underscored form.

Daily verbs:

- `just log-agent-logs` — tail the DaemonSet's pods (label-scoped, so
  it picks up every replica on future multi-node clusters; follows).
- `just log-agent-rollout` — rolling restart against the DaemonSet after
  a ConfigMap edit; blocks on rollout-status (kubelet does NOT auto-
  restart pods when a mounted ConfigMap's data changes).

**Non-goals (slice 20 deliberately does not ship):**

- Tailing logs from `kube-system` or `default` namespaces — the
  filelog `include:` glob is `social_*` only. Widening blows up the
  local Loki PVC (5Gi chart default) on sustained local-dev sessions
  and is gated on a retention / PVC sizing review the Hetzner slice
  will weigh.
- Audit logs, container runtime logs, kernel logs — application pod
  logs only.
- Log-based alerting — defaults from the slice-17 Loki chart values
  stand; alerting is a future slice's concern.
- Retention or index-cardinality tuning — chart defaults stand.

### Cluster metrics

Slice 21 (`add-k3s-cluster-metrics`) closes the last of three signal
gaps on the obs cluster — node, pod, and cluster-state metrics join
the cross-cluster transport spine alongside backend traces
(slices 18a/b), FE error logs + web vitals (slice 18c), and backend
pod logs (slice 20). Two new workloads under
`infra/k8s/base/`:

- `metrics-agent/` — a DaemonSet running one OpenTelemetry Collector
  pod per node. Its `kubeletstats` receiver scrapes the local
  kubelet at `https://${NODE_NAME}:10250` every 15s (per-node CPU /
  memory, per-pod CPU / memory, per-container, per-volume); its
  `hostmetrics` receiver reads `/proc` and `/sys` through a
  read-only hostPath mount (node CPU / memory / load / disk /
  filesystem / network / paging / processes).
- `metrics-cluster-agent/` — a singleton Deployment running the
  `k8s_cluster` receiver against the apiserver every 15s
  (deployment desired / available, replicaset / statefulset /
  daemonset state, pod phase, container restart counts, PVC phase,
  node conditions).

Both ship OTLP/gRPC plaintext to the in-cluster gateway collector
(`collector.social.svc.cluster.local:4317`). The gateway then
carries them through the slice-19 mTLS envelope to the obs
cluster's prometheus via the slice-18c `prometheusremotewrite/in-cluster`
exporter. Same agent/gateway pattern slice 20 established — the
agents have no cert material, the single security boundary lives
on the gateway.

The OTel-receiver-side approach was chosen over enabling the
prometheus chart's bundled `kube-state-metrics` / `prometheus-node-exporter`
subcharts and default scrape jobs because:

- One direction of cross-cluster flow (app → obs, always). A
  chart-side scrape would invert the flow (this prom pulling
  from the app cluster's kubelet / apiserver) and demand a
  second auth model on top of the slice-19 mTLS envelope.
- One security envelope at the gateway.
- One image pin (`otel/opentelemetry-collector-contrib:0.111.0`)
  shared across all four collector pods — gateway, log-agent,
  metrics-agent, metrics-cluster-agent.

```
  ┌───────────────────────────────────────────────────┐
  │ app cluster (lima-social)                         │
  │                                                   │
  │  kubelet :10250 ── kubeletstats ───┐              │
  │  /proc, /sys   ── hostmetrics ───┐ │              │
  │                                  │ │              │
  │   ┌──────────────────┐           │ │              │
  │   │ metrics-agent    │ ◄─────────┘ │              │
  │   │ DaemonSet        │             │              │
  │   │ (per node)       │ ◄───────────┘              │
  │   └────────┬─────────┘                            │
  │            │                                      │
  │  apiserver ─── k8s_cluster ──┐                    │
  │            │                 │                    │
  │   ┌──────────────────┐       │                    │
  │   │ metrics-cluster- │ ◄─────┘                    │
  │   │ agent Deployment │                            │
  │   │ (singleton)      │                            │
  │   └────────┬─────────┘                            │
  │            │ OTLP/gRPC :4317 (plaintext, in-cluster)
  │            ▼                                      │
  │   ┌──────────────────┐                            │
  │   │ gateway          │  metrics pipeline:         │
  │   │ collector        │  batch → dual-write        │
  │   │                  │  → obs-cluster (mTLS)      │
  │   │                  │  → compose-relay (local)   │
  │   └────────┬─────────┘                            │
  │            │ mTLS (slice 19)                      │
  └────────────┼──────────────────────────────────────┘
               ▼
       obs collector → prometheus remote-write → obs prometheus → obs grafana
```

Apply behavior — both workloads ship with the base overlay, so
`just k8s-apply` rolls them out the same way it rolls out the
backend, frontend, postgres, gateway collector, and log-agent.
No separate verb needed.

End-to-end loop on the local mirror:

```sh
just vm-up           # app cluster (no-op if running)
just obs-up          # obs cluster (no-op if running)
just k8s-apply       # rolls out metrics-agent + metrics-cluster-agent
# Wait one scrape interval (15s) plus prometheus WAL flush (~15s).
just obs-grafana     # in a side terminal; obs grafana on :3001
# In obs grafana → Dashboards → Browse, open "Cluster overview".
# Every panel renders within ~30 seconds of the agents reaching Ready.
# In Explore → Prometheus, sanity queries (names carry the
# OpenMetrics-conformant unit suffixes prometheusremotewrite
# appends — `_ratio` for ratios, `_bytes` for byte gauges):
#   k8s_node_cpu_utilization_ratio          # per-node CPU, kubeletstats
#   system_memory_usage_bytes{state="used"} # per-node memory, hostmetrics
#   k8s_deployment_available                # cluster state, k8s_cluster
```

Daily verbs:

- `just metrics-agent-logs` — tail the DaemonSet's pods (label-scoped;
  follows).
- `just metrics-agent-rollout` — rolling restart against the DaemonSet
  after a ConfigMap edit; blocks on rollout-status.
- `just metrics-cluster-agent-logs` — tail the singleton Deployment's
  pod (follows).
- `just metrics-cluster-agent-rollout` — rolling restart against the
  Deployment after a ConfigMap edit; blocks on rollout-status.

**Non-goals (slice 21 deliberately does not ship):**

- A Prometheus Operator install. The README design constraint stands —
  every LGTM chart is deployed bare, CRD-based stacks are out of scope.
- Control-plane metrics (kube-scheduler / kube-controller-manager / etcd).
  k3s embeds these in the supervisor process and does not expose
  separate `/metrics` endpoints without server flags — a future slice
  can wire them.
- Alerting rules on cluster metrics. A future alerting slice decides
  which thresholds page.
- Cardinality engineering / metric filtering / retention tuning. Chart
  defaults stand for this slice; the Hetzner overlay stub flags PVC
  and retention re-sizing for production.
- A compose-side `cluster-overview` dashboard. Compose dies in slice
  22; building the dashboard now would be churn. Side-by-side
  comparability during the slice 21 → 22 window runs as ad-hoc PromQL
  in compose grafana's Explore tab.

### Frontend tracing

The frontend ships an opt-in OpenTelemetry Web SDK that boots before
React renders. With telemetry enabled, every user click and form submit
becomes a span, and every outbound fetch to the backend carries a W3C
`traceparent` header so the Tempo trace tree starts in the browser and
continues seamlessly into the backend's controller and JDBC spans —
one `trace.id`, one trace, two `service.name` values (`frontend` and
`backend`).

Opt in by exporting `VITE_OTEL_ENABLED=true` before starting the dev
server (the default `pnpm dev` invocation stays unchanged):

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

On boot, the devtools console writes exactly one confirmation line:

```
OTel telemetry enabled: traces → http://localhost:4318/v1/traces
```

The default exporter URL points at the OTel Collector's OTLP/HTTP
receiver published from the observability profile; override it with
`VITE_OTEL_TRACES_ENDPOINT` if you front the Collector with a different
host. The Collector's `:4318` receiver carries a `cors` block that
allowlists the Vite dev (`http://localhost:5173`) and preview
(`http://localhost:4173`) origins, so the browser POST succeeds
without a proxy.

Click-to-trace, in Grafana → Explore → Tempo:

1. Click the post composer's `Post` button (or any UI button that
   fires a `useMutation`).
2. In Tempo search, filter by `{ resource.service.name = "frontend" }`
   and find the most recent trace. Its root span is the
   `UserInteractionInstrumentation`-emitted click; the next span is
   `FetchInstrumentation`'s `POST /api/v1/posts`; the children below
   are the backend's controller, `@Timed`, and JDBC spans
   (`{ resource.service.name = "backend" }`).
3. From the same trace, click the `Logs for this span` data link on
   any backend span — Loki returns the ECS log line that carries the
   same `trace.id`.
4. Switch Tempo's view to `Service Graph` (provisioned in
   `infra/observability/grafana/provisioning/datasources/tempo.yaml`
   via the `serviceMap` block) to see the `frontend → backend` edge
   after a few requests have flowed through.

`traceparent` propagation is **scoped to the backend origin** —
`http://localhost:8080` in dev and any URL whose origin matches
`VITE_API_BASE_URL` at build time. The browser SDK does **not** send
`traceparent` or `tracestate` to third-party hosts (CDNs, fonts,
analytics). The Collector's `transform/redact-path-ids` processor
rewrites high-cardinality path segments (UUIDs, opaque hex, numeric
ids) to the literal `{id}` on both FE and BE spans before they reach
Tempo.

Frontend RUM metrics (Web Vitals: LCP, INP, CLS) and frontend errors
(window errors, unhandled rejections, React error boundary events)
are the natural follow-up slices — they will layer on top of the
trace propagation this slice establishes.

### Frontend RUM metrics

The frontend ships an opt-in OpenTelemetry browser metrics SDK that
boots alongside the slice-5 tracer. With metrics enabled, the
[`web-vitals`](https://github.com/GoogleChrome/web-vitals) library
reports finalised LCP / CLS / INP / FCP / TTFB into OTel histograms
named `web_vitals_*`; a React Router `<RouteTimingObserver />`
records SPA route-transition durations into
`route_change_duration_ms` (labelled by route template, never by
resolved id); a `PerformanceObserver({type: 'longtask'})` records
main-thread blocks into `long_task_duration_ms`.

Opt in by exporting `VITE_OTEL_ENABLED=true` before starting the dev
server (the same gate that enables slice-5 traces — flipping it on
opts into both):

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

On boot, the devtools console writes one confirmation line per
telemetry surface:

```
OTel telemetry enabled: traces → http://localhost:4318/v1/traces
OTel telemetry enabled: metrics → http://localhost:4318/v1/metrics
```

Wire path:

1. The browser SDK POSTs OTLP/HTTP metrics to
   `http://localhost:4318/v1/metrics` (the OTel Collector's HTTP
   receiver, the same listener slice 5 uses for traces — its CORS
   allowlist already covers the metrics endpoint).
2. The Collector's slice-6 `metrics` pipeline runs FE data points
   through a `filter/drop_high_cardinality` processor (defence-in-
   depth against any future code path that forgets the route-template
   label) and re-emits them as Prometheus text-exposition on
   `http://localhost:8889/metrics`.
3. Prometheus's `collector` scrape job (added in
   `infra/observability/prometheus/prometheus.yml`) reads
   `:8889/metrics` every 15 s into the same Prometheus instance the
   Backend overview already uses.
4. Grafana provisions the new dashboard at
   `http://localhost:3000/d/frontend-overview` (also reachable via
   Grafana search for `Frontend overview`). Four rows: Web Vitals
   (LCP / CLS / INP / FCP / TTFB p75), route-timing percentiles
   keyed by route, long-task rate and mean duration, and a
   browser-request-volume proxy.

Override the metrics endpoint with `VITE_OTEL_METRICS_ENDPOINT` if
the Collector is fronted by a different host; tighten the export
cadence with `VITE_OTEL_METRICS_EXPORT_INTERVAL_MS` (default 15 s,
matched to Prometheus's `scrape_interval`).

Empty panels are expected on a fresh stack: until a browser session
loads the app with the gate enabled there are no FE samples to
display, and even with the gate on individual Web Vitals only
finalise after specific user actions — LCP after the first paint,
INP after the first event handler completes, CLS at page hide.
Open the app in a tab, click around for a few seconds, and the
Frontend overview dashboard's panels start filling in within one
export + scrape cycle (≤ 30 s).

Frontend errors are covered in the next subsection. FE-plus-BE
alerting / SLO definitions are the natural follow-up slice — it
layers on top of this metrics path, the slice-5 trace path, and
the slice-7 error path.

**Frontend SLOs (LCP, INP).** Four multi-window multi-burn-rate
alerts ride on top of the Web Vitals histograms above:
`LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`,
`InpSloSlowBurn`. They evaluate two SLO targets — LCP `95%` of page
loads `< 2500` ms, INP `95%` of interactions `< 200` ms, both over
a 30 d window — using the same burn-rate constants as the backend
latency SLOs (fast-page 14.4× over 1h+5m, slow-page 6× over
6h+30m). Each alert carries `severity=page`, `slo=lcp|inp`, and
`service=frontend` labels. The Frontend overview dashboard's
`SLO` row surfaces the same SLOs at a glance: error budget
headroom (last 6 h), current 1 h burn rate per SLO, and p75 vs
SLO threshold for LCP and INP. The recording rules backing the
alerts read the `le="2500"` (LCP) and `le="200"` (INP) buckets,
which `frontend/src/observability/meter.ts` pins via per-instrument
`advice.explicitBucketBoundaries`. The Prometheus rule files
(`fe-slo-recording.yml`, `fe-slo-alerting.yml`,
`fe-slo-tests.yml`) live alongside the backend ones in
`infra/observability/prometheus/rules/`. Reminder: Prometheus must
be restarted (`docker-compose --profile observability restart
prometheus`) for `rule_files:` changes to take effect — same caveat
as the slice-8 Alerting subsection below.

### Frontend errors

The frontend captures every uncaught browser exception across four
canonical surfaces and fans each one out to three observability
sinks via the same OTel Collector slice 5 and 6 already use:

- **React error boundary** — a top-level `<FrontendErrorBoundary>`
  wraps `<App />` in `main.tsx`; render-time exceptions are caught
  via `componentDidCatch` and recorded with `kind="boundary"`.
- **`window.error`** — synchronous uncaught JS exceptions and
  resource-load failures (`kind="error"`).
- **`window.unhandledrejection`** — fire-and-forget promise
  rejections (`kind="rejection"`).
- **`window.securitypolicyviolation`** — CSP violation events,
  future-proofing for when a CSP is configured (`kind="csp"`).

Each captured error fans out to three sinks:

- a `span.recordException` event on the active OTel span (Tempo);
- a structured OTel log record with ECS attributes emitted via
  `@opentelemetry/sdk-logs` to the Collector and routed to Loki
  under `event.dataset=frontend.error`;
- a `frontend_errors_total{kind, route}` counter increment
  (Prometheus via the slice-6 metrics pipeline).

Opt in with the same gate as slices 5 and 6:

```sh
cd frontend && VITE_OTEL_ENABLED=true pnpm dev
```

A fourth confirmation line lands on the devtools console at boot:

```
OTel telemetry enabled: logs → http://localhost:4318/v1/logs
```

Wire path:

1. The browser SDK POSTs OTLP/HTTP log records to
   `http://localhost:4318/v1/logs` (the same Collector receiver as
   slice 5/6).
2. The Collector's `logs/frontend` pipeline filters to
   `resource.service.name=frontend` (defence-in-depth against a
   future BE-via-OTLP migration), runs the `transform/pii_scrub`
   processor — a regex backstop redacting JWT, email, and bearer-
   token-shaped substrings to `[REDACTED]` — and promotes
   `event.dataset` + `service.name` to Loki labels.
3. Loki ingests under `{event_dataset="frontend.error",
   service_name="frontend"}` alongside the BE access log under
   `{event_dataset="backend.access"}`.
4. Grafana's Frontend overview dashboard gains an Errors row at
   `http://localhost:3000/d/frontend-overview` — three panels:
   error rate by `kind`, top fingerprints (Loki), and CSP
   violations.

**Dedup + rate cap (SDK-side):** a render-loop pathology can fire
the same exception thousands of times per minute. The SDK
fingerprints each captured error as
`<type>:<first stackframe path>:<line>` and suppresses the
event-shaped sinks (span event, log record) for any fingerprint
that fired within the last **5 s** (`VITE_FE_ERROR_DEDUP_WINDOW_MS`
override), or any further events after **30 per rolling 60 s**
(`VITE_FE_ERROR_RATE_LIMIT` override). The
`frontend_errors_total` counter is **never** gated — aggregate
counts stay accurate even when example surfaces drop.

**PII (defence-in-depth):** the SDK strips JWT, email, and bearer-
token-shaped substrings from `error.message` and
`error.stack_trace` before export. The Collector's
`transform/pii_scrub` processor re-applies the same three regexes
over `attributes.error.message`, `attributes.error.stack_trace`,
and `body` — a last-line guard for any third-party library
exception the SDK regex missed. The patterns live in
`frontend/src/observability/error-sink.ts` (`PII_REGEXES`) and
`infra/observability/collector/collector-config.yaml`
(`transform/pii_scrub`); they must move together.

**Source-map symbolication:** explicitly **out of scope** for
this slice. Built bundles produce munged stack frames; in local
dev Vite serves unminified bundles so frames are already
readable. A dedicated symbolication slice (build-pipeline upload
+ symbol store + Grafana plugin) is queued before any real-server
deploy — see `project_source_maps_pre_deploy.md` in the
auto-memory and the **Open Follow-ups** section of
`openspec/changes/add-frontend-errors/design.md`.

### Alerting

The same observability profile also brings up [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/)
and loads the slice-8 SLO recording + multi-window multi-burn-rate alerting
rules into Prometheus:

```sh
docker-compose --profile observability up -d
```

Three SLOs are evaluated continuously against the backend's existing metrics:

- **API availability** — 5xx ratio on `/api/v1/*`, target `99.5%` over 30d.
  Fast-page (1h × 5m), slow-page (6h × 30m), and ticket (3d × 6h) burn-rate
  alerts fire from the same error budget.
- **Feed read latency** — fraction of `feed.read.duration` requests slower
  than 200ms, target `95%` over 30d. Fast-page and slow-page alerts.
- **Post create latency** — fraction of `posts.create.duration` requests
  slower than 500ms, target `95%` over 30d. Fast-page and slow-page alerts.

Plus a non-SLO operational alert: `BackendDown` fires when Prometheus has
been unable to scrape `up{job="backend"}` for 2 minutes — necessary because
burn-rate alerts can't fire when the target is offline (no samples to divide).

**Where active alerts surface:**

- Alertmanager UI: `http://localhost:9093` (full alert list, silences, status).
- Grafana → Alerting (left-nav) — reads the same alerts via the provisioned
  Alertmanager datasource. No copy-paste from Prometheus needed.
- Raw HTTP: `curl http://localhost:9093/api/v2/alerts` for scripting.

**Webhook sink (local-dev receiver).** Alertmanager's stub `null` receiver
is replaced by a real local-dev webhook sink under
`infra/observability/webhook-sink/` — a small Node + Express container that
records every routed firing in a bounded in-memory ring. Severity-based
routing dispatches each alert to one of two endpoints:

- `severity=page` → `POST http://webhook-sink:8080/page` (page-webhook receiver).
- `severity=ticket` → `POST http://webhook-sink:8080/ticket` (ticket-webhook receiver).

Inspect what the sink has received:

```sh
curl http://localhost:8081/received | jq
docker compose logs webhook-sink
```

The sink also exposes `GET /healthz` (used by the e2e spec's readiness
probe) and accepts `?after=<unix-millis>` on `/received` to filter the
ring to payloads received after a given timestamp.

A real production receiver (PagerDuty / Opsgenie / Slack) is a one-line
config swap in `alertmanager.yml` — replace the webhook URL with the
production target's incoming-webhook URL and the rest of the routing
tree stays as-is.

**Runbook annotations.** Every alert in the rule files carries a
`runbook_url` annotation pointing at a Markdown stub under
`infra/observability/runbooks/`. The stubs are intentionally minimal —
each has `Symptoms` / `Impact` / `Triage` / `Mitigation` / `Escalation`
sections seeded with the basics, and real incident learnings are
expected to fill them in over time. The contract is "every alert has a
runbook"; the content matures as the team operates the service.

**Inhibition.** `BackendDown` firing suppresses every alert carrying any
`slo` label (Alertmanager `inhibit_rules:` block in `alertmanager.yml`).
When the backend is down, burn-rate ratios can't produce meaningful
values and the operator already knows the root cause — inhibition keeps
the page noise-free.

**Run the alerting-rule unit tests locally** with `promtool test rules`:

```sh
docker run --rm --entrypoint promtool \
  -v "$PWD/infra/observability/prometheus/rules:/rules:ro" \
  prom/prometheus:v2.55.1 \
  test rules /rules/slo-tests.yml
```

The fixture at `infra/observability/prometheus/rules/slo-tests.yml` is the
executable spec for the alerting rules — each scenario in
`openspec/changes/add-backend-alerting-slos/specs/observability/spec.md`
corresponds to a test stanza. The same one-liner runs in CI as a gate.

**Editing rule files** (`slo-recording.yml`, `slo-alerting.yml`) requires a
Prometheus restart for the changes to take effect; Prometheus reads the rule
files only at startup under this compose setup:

```sh
docker-compose --profile observability restart prometheus
```

(The Grafana datasource provisioning has the same restart requirement — see
the prior subsection's notes on the slice-4 / slice-5 datasource files.)

### Exemplars (metric → trace one-click pivot)

The same observability profile lights up Prometheus exemplar storage and a
Grafana panel-to-Tempo pivot, so a high-latency bucket on the
`http_server_requests_seconds_bucket` histogram is one click away from the
trace that produced it:

```sh
docker-compose --profile observability up -d
```

What's wired:

- The backend's `/actuator/prometheus` endpoint serves OpenMetrics on
  `Accept: application/openmetrics-text`. Each histogram bucket recorded
  while an OTel span was active carries an exemplar suffix
  (`# {trace_id="…",span_id="…"} <value> <ts>`). The bridge to the OTel
  Java agent's active span is the `OpenTelemetryAgentSpanContext` bean in
  `ExemplarsConfig`.
- Prometheus runs with `--enable-feature=exemplar-storage`, so the
  scraped exemplars survive ingestion and surface via
  `/api/v1/query_exemplars`.
- The Grafana Prometheus datasource has `exemplarTraceIdDestinations`
  pointing at the Tempo datasource (UID `tempo`), so any panel with the
  exemplars query option enabled renders diamond markers that open the
  matching trace in Tempo on click.

Click-path: `Backend overview → "p50 / p95 / p99 latency by URI" → click
an exemplar diamond → Tempo trace view`. Exemplars only appear once the
panel's time range covers a sample taken under an active span; drive a
few requests against the running backend, wait one scrape interval
(15 s), and the diamonds fill in.

**Datasource provisioning restart caveat:** Grafana reads provisioning
files only at container start. After editing
`infra/observability/grafana/provisioning/datasources/prometheus.yaml`,
restart Grafana so the new `jsonData.exemplarTraceIdDestinations` (or
any other datasource change) takes effect:

```sh
docker-compose --profile observability restart grafana
```

**Frontend exemplars are deferred:** the OTel Collector's `prometheus`
exporter does not synthesize exemplars from FE OTLP histograms in this
slice, so the Frontend overview dashboard's panels do not yet carry the
metric→trace pivot.

### Database internals

The same observability profile also brings up
[`postgres-exporter`](https://github.com/prometheus-community/postgres_exporter)
so the local Postgres is observable as an engine, not just as a target of
backend-side timers (HikariCP, JDBC spans, request latency). Connection
pressure against `max_connections`, transactions per second, cache hit
ratio, deadlocks, and the top-N slow queries from `pg_stat_statements`
are surfaced through Prometheus and Grafana alongside the existing
backend / frontend dashboards:

```sh
docker-compose --profile observability up -d
```

What's wired:

- The `postgres` service in `docker-compose.yml` runs with
  `shared_preload_libraries=pg_stat_statements`, and a first-boot init
  script (`infra/observability/postgres/init/01-pg-stat-statements.sql`)
  creates the extension on the `social` database — so per-statement
  counters are real signal, not placeholders.
- A new `postgres-exporter` service (pinned `quay.io/prometheuscommunity/postgres-exporter`
  image, port `9187`) authenticates to Postgres via `DATA_SOURCE_URI` and
  emits the standard `pg_stat_database` / `pg_settings` / `pg_database_size_bytes`
  series. A custom-queries projection at
  `infra/observability/postgres-exporter/queries.yaml` adds
  `pg_stat_statements_*` series for the top-100 statements by total
  execution time, with the `query` text truncated to 200 characters to
  keep label cardinality bounded.
- Prometheus picks up the exporter as a new `postgres-exporter` scrape
  job (`infra/observability/prometheus/prometheus.yml`); the target's
  health is on `http://localhost:9090/targets`.
- Grafana auto-provisions a new `Database overview` dashboard at
  `http://localhost:3000/d/database-overview` (also reachable via
  Dashboards → Browse → "Database overview"): connection saturation
  gauge, connection-count time series, transactions/sec, cache hit
  ratio, tuples affected, deadlock rate, database size, and a top-N
  slow-query table sourced from `pg_stat_statements`.
- Two database-tier alerts ride the slice-11 severity routing:
  `PostgresConnectionSaturation` (`severity=page`, fires when
  `numbackends / max_connections > 0.8` for 5 m) and `PostgresDeadlocks`
  (`severity=ticket`, fires on any deadlock counter increment in the
  last 5 m). Both carry the same `runbook_url` annotation contract as
  the slice-11 alerts; stubs live at
  `infra/observability/runbooks/PostgresConnectionSaturation.md` and
  `…/PostgresDeadlocks.md`. No Alertmanager config change is needed —
  the existing severity tree dispatches them to the same webhook sink.
- The `promtool test rules` step gains
  `infra/observability/prometheus/rules/database-tests.yml`, which
  exercises both alerts against synthetic series and pins the exact
  metric names emitted by the exporter (no `_total` suffix on
  `pg_stat_database_*` counters in v0.17.x).

**One-time volume rebuild for `pg_stat_statements`.** The
`shared_preload_libraries` flag loads the library at server start, but
the matching `CREATE EXTENSION` step only fires on a fresh data
directory — Postgres's `/docker-entrypoint-initdb.d/` scripts run during
`initdb`, not on every boot. If you already have a `postgres-data`
volume from before this slice, the library is loaded but the extension
isn't registered, so the exporter's pg_stat_statements query returns
`ERROR: relation "pg_stat_statements" does not exist`. Two paths:

```sh
# (a) recreate the volume — fastest, loses any local dev data:
docker compose down -v
docker compose --profile observability up -d

# (b) create the extension against the live volume — keeps local data:
docker compose exec postgres \
  psql -U social -d social -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
```

After either path, `curl -s http://localhost:9187/metrics | grep pg_stat_statements`
returns at least one line and the Database overview dashboard's slow-query
table fills in after a few minutes of traffic.

**Slow-query log shipping is deferred.** `pg_stat_statements` covers the
"which statement is slow" question for now. Streaming Postgres's CSV
log through the OTel Collector into Loki (so individual slow-query
events become per-line log records with their bind parameters) is a
follow-up slice; the current dashboard panels and alerts are sufficient
for diagnosis at the local-dev scale.

### Container infrastructure

The same observability profile also brings up
[cAdvisor](https://github.com/google/cadvisor) so each container in the
stack is observable as a resource consumer (USE — Utilization,
Saturation, Errors), not just as a target of backend-side timers or
database-internal counters. Per-container CPU usage and CFS throttling,
memory working set vs. limit, network I/O, restart count, and OOM-kill
events are surfaced through Prometheus and Grafana alongside the
existing backend, frontend, and database dashboards:

```sh
docker-compose --profile observability up -d
```

What's wired:

- A new `cadvisor` service (pinned `gcr.io/cadvisor/cadvisor:v0.49.1`)
  publishes its `/metrics` endpoint on host port `8085` (the container
  serves on `:8080`; the publish avoids colliding with the backend's
  host `:8080`). Prometheus picks it up as a new `cadvisor` scrape job
  on `cadvisor:8080`; verify on
  `http://localhost:9090/targets` that the target shows
  `health: up` after the profile is running.
- Grafana auto-provisions an `Infrastructure overview` dashboard at
  `http://localhost:3000/d/infrastructure-overview` (also reachable
  via Dashboards → Browse → "Infrastructure overview"): per-container
  CPU usage, CPU throttling ratio, memory working-set vs. limit (bar
  gauge + time series with limit overlay), network receive / transmit
  bytes, container restart count over the last hour, and OOM events
  over the last hour. Every PromQL expression filters with `name!=""`
  to drop cAdvisor's cgroup-hierarchy series.
- Three container-tier alerts ride the slice-11 severity routing
  without any Alertmanager change:
  - `ContainerCpuThrottling` (`severity=ticket`) — fires when a
    container is throttled for >25% of CFS periods sustained over 10 m.
  - `ContainerMemoryNearLimit` (`severity=ticket`) — fires when a
    container's working set crosses 90% of its declared `mem_limit`
    sustained for 5 m.
  - `ContainerOomKilled` (`severity=page`) — fires once per OOM-kill
    event recorded in the last 15 m.
  All three carry the same `runbook_url` annotation contract as the
  slice-11 alerts; stubs live at
  `infra/observability/runbooks/ContainerCpuThrottling.md`,
  `…/ContainerMemoryNearLimit.md`, and `…/ContainerOomKilled.md`.
- The `promtool test rules` step gains
  `infra/observability/prometheus/rules/container-tests.yml`, exercising
  each alert against synthetic series (firing case, steady-state
  non-firing case, and — for `ContainerMemoryNearLimit` — the
  un-limited-container edge case where `container_spec_memory_limit_bytes`
  is `0`).

**Resource limits on every existing compose service.** Slice 13 also
declares an explicit `mem_limit` and `cpus` cap on every service in
`docker-compose.yml` (`postgres`, `prometheus`, `grafana`, `tempo`,
`loki`, `collector`, `alertmanager`, `webhook-sink`,
`postgres-exporter`, and `cadvisor` itself). Without these limits the
cAdvisor saturation alerts cannot fire: `container_spec_memory_limit_bytes`
is unbounded, CFS throttling never engages, and the OOM killer only
triggers when the laptop's host memory runs out. Caps are sized
comfortably above local-dev steady state (total ceiling ~4.4 GiB / ~9
vCPU) and the inline comment block at the top of `docker-compose.yml`
records the rationale. `postgres`'s cap applies under the default
compose invocation too (not just `observability`), which is fine — the
cap is set well above what local dev needs.

**Explicit non-goals.**

- **`node_exporter` / host-level metrics** are *not* added. The backend
  runs on the host (not in a container), so container-tier metrics
  structurally can't cover it; in production a Kubernetes DaemonSet
  would add `node_exporter` per node. On macOS Docker Desktop a
  containerised `node_exporter` would measure the Linux VM, not the
  laptop, which would be misleading. Deferred until the backend is
  itself containerised.
- **`process-exporter` for the host JVM** is *not* added because
  Micrometer (slice 1) already exposes JVM internals (heap, GC, threads,
  CPU) on `/actuator/prometheus`. The Vite dev server is uninteresting
  in prod.
- **The backend is not containerised in this slice.** That is a larger
  architectural change; this slice is constrained to additive
  container-tier visibility for what already runs in compose.

**macOS Docker Desktop caveat.** cAdvisor's Docker factory depends on a
specific layout of the daemon's layer store (`/var/lib/docker/image/overlayfs/layerdb/mounts/<id>/mount-id`).
Docker Desktop's Linux VM uses a different storage backend, so cAdvisor
on macOS falls back to its Raw factory: the `container_*` metric
families are still emitted, but with only an `id="/docker/<hash>"`
label — the `name=` label every dashboard panel and alert keys on is
absent. Production Linux deployments (and Linux dev hosts) do not have
this limitation. The backend's `CadvisorIT` integration test
acknowledges this by gating itself behind
`-Dobservability.integration=true`; run it on a Linux host (or CI
runner) to verify the cAdvisor pipeline end-to-end:

```sh
./backend/gradlew -p backend test \
  --tests com.prodready.social.observability.CadvisorIT \
  -Dobservability.integration=true
```

## Prerequisites

- Java 21
- Node (version pinned in `frontend/.nvmrc`) and pnpm (for the frontend)
- Docker (for Postgres and Testcontainers)
