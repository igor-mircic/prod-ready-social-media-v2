## Why

Slice 18a (`add-k3s-app-collector`) introduced an in-cluster otel-collector in the app cluster, but its exporter still points at the host-side compose collector via `host.lima.internal:4317`. Telemetry has not yet crossed the cluster boundary the slice-17 design built the second Lima VM to exercise. This is the second of three sub-slices carved out of the original "slice 18" (see the slice 18a proposal's preamble for the carve-up rationale): the app collector now also ships traces to a new collector tier inside the obs cluster, and obs grafana finally has datasources to render them.

This slice deliberately keeps the compose path alive in parallel. The app collector's traces pipeline grows a second exporter so traces fan out to BOTH the compose collector AND the obs cluster's collector. This mirrors the slice-17 "build the new house before tearing down the old one" sequencing — compose grafana keeps showing exactly what it shows today (no observability regression for the operator), obs grafana grows the same view alongside it, and slice 22 (`retire-compose-observability`) is the one that finally cuts the dual-write down to obs-only.

The browser still ships traces directly to the compose collector cross-origin — `route-browser-otlp-through-nginx` (18c) is the slice that flips that. No mTLS yet (slice 19). No pod log shipping yet (slice 20). No cluster metrics pipeline yet (slice 21). The FE→BE trace-propagation gap memorialized after slice 16 is a separate frontend instrumentation defect and is not addressed here.

End state: an operator runs `just up && just obs-up && just backend-apply`, opens compose grafana and obs grafana side-by-side, and sees identical backend traces in both. A `kubectl logs -n observability deploy/collector` on the obs cluster shows the same OTLP volume the app cluster's collector is emitting. The cross-cluster transport decision is exercised end-to-end; only the security envelope (mTLS) and the remaining data planes (logs, metrics) remain for later slices.

## What Changes

- **New `infra/k8s-obs/base/collector/` Kustomize directory** containing the obs cluster's collector tier:
  - `kustomization.yaml` listing this slice's resources, default labels (`app.kubernetes.io/name=collector`), and the image pin (same `otel/opentelemetry-collector-contrib:0.111.0` as compose and app cluster — three users, one pin).
  - `deployment.yaml` — single-replica `collector` Deployment in the `observability` namespace. Same probe / resource / port surface as the app cluster's collector (slice 18a). Args `--config=/etc/otelcol-contrib/config.yaml`. The ConfigMap is mounted read-only at `/etc/otelcol-contrib/`. Liveness/readiness against `:13133/`. Resource requests `cpu=50m / memory=128Mi`; limits `cpu=500m / memory=512Mi` (slightly higher memory limit than the app collector because this one is the aggregation point for cross-cluster traffic).
  - `service.yaml` — type `LoadBalancer` (klipper-lb assigns the obs VM's IP), exposing port `4317` (otlp-grpc) → targetPort `otlp-grpc` and port `4318` (otlp-http) → targetPort `otlp-http`. LoadBalancer (not ClusterIP) because the receiver is intentionally reachable from off-cluster — the app cluster dials in via the obs VM's host-published ports. The slice-17 design's fate-separation invariant explicitly carves out OTLP receivers as the one legitimate ingress path the obs cluster exposes toward the app cluster.
  - `configmap.yaml` — declares the collector pipeline. Receivers `otlp` (gRPC `:4317`, HTTP `:4318`, NO CORS — only the app-cluster collector dials this). Processors `batch` and `transform/redact-path-ids` (same OTTL statements as the app collector and the compose collector — every hop in the path applies the redaction in case upstream regresses). One exporter `otlp/tempo` pointing at the in-cluster tempo OTLP receiver (`tempo.observability.svc.cluster.local:4317`, `tls.insecure: true` since this hop stays inside the obs cluster). One traces pipeline. **No metrics pipeline** (slice 21 owns cluster metrics; no upstream feeds this collector metrics yet). **No logs pipeline** (slice 20 owns pod log shipping).
- **`infra/k8s-obs/base/kustomization.yaml` updated** to include `./collector` alongside the existing `./prometheus`, `./loki`, `./tempo`, `./grafana`, `./alertmanager`.
- **`infra/k8s-obs/base/grafana/values.yaml` updated** to provision four datasources via the chart's `datasources:` block, each pointing at an in-cluster Service:
  - `Tempo` → `http://tempo.observability.svc.cluster.local:3200` (tempo's HTTP query endpoint, not the OTLP receiver).
  - `Prometheus` → `http://prometheus-server.observability.svc.cluster.local` (chart-default Service name and port 80).
  - `Loki` → `http://loki.observability.svc.cluster.local:3100`.
  - `Alertmanager` → `http://alertmanager.observability.svc.cluster.local:9093`.
  All four are provisioned now even though only Tempo has data this slice; the others render "no data" until slices 20 (loki) and 21 (prometheus) bring data online. The cost of pre-staging is three YAML stanzas; the alternative — churning grafana values across three slices — has higher total churn and worse readability.
- **`infra/lima/obs.yaml` `portForwards` updated** to publish the obs collector's OTLP listeners on the macOS host:
  - guestPort `4317` → hostPort `14317` (otlp-grpc).
  - guestPort `4318` → hostPort `14318` (otlp-http).
  The host-side ports are deliberately `:14317` / `:14318`, not `:4317` / `:4318`, to avoid collision with the compose collector's already-published ports (symmetric with the apiserver disambiguation that landed in slice 17: app `:16443`, obs `:16444`). The pattern is "obs gets the same number plus 10000."
- **`infra/k8s/base/collector/configmap.yaml` (app cluster) updated** to grow a second exporter:
  - `otlp/compose-relay` — unchanged from slice 18a, still points at `host.lima.internal:4317` (compose collector). Kept because the browser still ships there until 18c, and operators verify the migration by reading both grafanas in parallel.
  - NEW `otlp/obs-cluster` — points at `host.lima.internal:14317` with `tls.insecure: true`. From the app collector pod's perspective, `host.lima.internal` resolves to the macOS host's gateway IP exactly as it does for the BE pod; the host's `:14317` is then port-forwarded by Lima into the obs VM, where klipper-lb terminates the LoadBalancer Service and routes to the obs-cluster collector pod.
  - The single `traces` pipeline's `exporters:` list grows from `[otlp/compose-relay]` to `[otlp/compose-relay, otlp/obs-cluster]`. The collector fans out the same batch to both destinations; failure of either does not block the other.
- **`infra/k8s/overlays/hetzner/kustomization.yaml`** — the existing commented stub for the app collector gains a one-line note that the Hetzner equivalent of `host.lima.internal:14317` is "the obs box's tailscale/private-network IP, terminated with mTLS"; nothing structural changes. The obs-cluster `infra/k8s-obs/overlays/hetzner/kustomization.yaml` gains a commented stub for the obs collector (production resource caps, LoadBalancer → real ingress, TLS material reference). Comments only.
- **`justfile`** gains recipes mirroring the app cluster's `collector-*` pair, scoped to the obs context:
  - `obs-collector-logs` — `kubectl --context social-obs logs -n observability deploy/collector -f`.
  - `obs-collector-rollout` — `kubectl --context social-obs rollout restart deploy/collector -n observability`.
- **`README.md`** "Local observability" section gains a "Bridging to the obs cluster" subsection describing the dual-write topology, the `host.lima.internal:14317` hop, the four datasources provisioned in obs grafana, the expectation that compose grafana and obs grafana show identical backend trace data (browser data only lands in compose until 18c), and the explicit non-goal that the obs cluster has no auth on its OTLP receiver yet.

Explicit non-goals:

- **No retirement of the compose path.** The compose collector keeps running, the app collector keeps shipping to it, the compose grafana keeps rendering. Dual-write is the entire point of the transition window. Slice 22 (`retire-compose-observability`) is the one that takes down the compose path; before then, "both grafanas show the same thing" is a load-bearing operator confidence signal.
- **No browser OTLP path change.** The FE bundle still bakes `VITE_OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces`; the browser still POSTs cross-origin to the compose collector. The CORS allowlist on the compose collector (slice 16) is unchanged. The obs collector's OTLP receiver is intentionally CORS-locked — only the app cluster's collector dials it. Slice 18c (`route-browser-otlp-through-nginx`) flips the browser path.
- **No mTLS / auth on the cross-cluster OTLP hop.** Slice 19 (`add-cross-cluster-mtls`) owns this. The obs collector's receiver accepts cleartext OTLP from anything that reaches it on `host.lima.internal:14317`. On the Lima loopback this is fine (no off-host reachability); the Hetzner overlay stub flags that the same posture is NOT acceptable in prod and that slice 19 must land before any cross-network deploy.
- **No FE→BE trace propagation fix.** The W3C `traceparent` header injection gap memorialized after slice 16 is a frontend instrumentation defect that affects what spans link to what regardless of which collector or which grafana stores them. Out of scope; tracked separately.
- **No backend log path change.** BE-in-k3s pod logs still live on stdout / `kubectl logs`. Slice 20 (`add-k3s-pod-log-shipping`) introduces the DaemonSet.
- **No backend metrics path change.** BE metrics continue to be Prometheus pull against `/actuator/prometheus`. Compose prometheus still does not reach in-cluster pods (slice-15 inheritance); slice 21 fixes it via the obs collector growing a prometheus receiver.
- **No removal of the obs grafana "stands up with no datasources" requirement's *intent*.** The intent — that slice 17 stand up an EMPTY obs cluster — is preserved as a slice-17-historical fact; slice 18b's modification simply updates the obs-cluster spec to reflect that 18b is now the slice that flips that requirement.
- **No autoscaling, HPA, PDB, or NetworkPolicy on the obs collector.** Single replica, same posture as every other slice in the arc. The fate-separation invariant lives at the *cluster* boundary, not at NetworkPolicy granularity, while we are still single-node.
- **No image signing, no SBOM publication.** Same posture as slices 15, 16, 17, 18a.
- **No CI job exercising the cross-cluster path.** CI continues to be compose-only. A future Lima-based smoke check may land once the arc is further along.

## Capabilities

### Modified Capabilities

- `observability` — modifies the slice 18a requirement "in-cluster app collector relays traces to the compose collector via `host.lima.internal:4317`" to its dual-write successor: the in-cluster app collector SHALL fan traces out to BOTH the compose collector (unchanged target) AND the obs cluster's collector via `host.lima.internal:14317`, with failure of either exporter independent of the other. The slice 18a requirement's existence foreshadowed exactly this revision.
- `observability-cluster` — modifies two slice 17 requirements:
  - "Grafana stands up with no datasources configured" → "Grafana provisions four datasources (tempo, prometheus, loki, alertmanager) pointing at in-cluster Services; tempo carries real backend trace data this slice, the others render no-data until their respective data-plane slices land."
  - The implicit slice-17 stance that the obs VM publishes only the apiserver port — updated to also publish `:14317` and `:14318` for the obs collector's OTLP receivers (the design Decision 6 "OTLP receivers are the one legitimate ingress" carve-out, finally exercised).
  Adds new requirements covering: (a) the obs-cluster collector Deployment shape (image, ports, resources, probes), (b) the obs-cluster collector ConfigMap pipeline (OTLP receiver → batch → redact-path-ids → otlp/tempo exporter to the in-cluster tempo Service), (c) the obs-cluster collector LoadBalancer Service (klipper-lb on the obs VM IP, exposing OTLP gRPC and HTTP), and (d) the obs Hetzner overlay's commented stub for the collector.
- `kubernetes` — modifies the slice 18a requirement covering the app collector ConfigMap pipeline. The traces pipeline's `exporters:` list grows from one entry (`otlp/compose-relay`) to two (`otlp/compose-relay`, `otlp/obs-cluster`); the second exporter points at `host.lima.internal:14317`. The receiver, processor, and pipeline shapes are otherwise unchanged.

### New Capabilities

(none — every change lands in `observability`, `observability-cluster`, or `kubernetes`. The cross-cluster transport is not a new capability; it is the materialization of the cross-cluster ingress carve-out the slice-17 `observability-cluster` spec already names.)

## Impact

- **Affected files / directories:**
  - `infra/k8s-obs/base/collector/kustomization.yaml`, `deployment.yaml`, `service.yaml`, `configmap.yaml` (new)
  - `infra/k8s-obs/base/kustomization.yaml` — appends `./collector` to `resources:`
  - `infra/k8s-obs/base/grafana/values.yaml` — adds four provisioned datasources
  - `infra/k8s-obs/overlays/hetzner/kustomization.yaml` — appends a commented stub for the collector
  - `infra/lima/obs.yaml` — adds two `portForwards` entries (14317, 14318) before the catch-all ignore rule
  - `infra/k8s/base/collector/configmap.yaml` — adds the `otlp/obs-cluster` exporter, extends the traces pipeline's `exporters:` list
  - `infra/k8s/overlays/hetzner/kustomization.yaml` — one-line note appended to the existing app-collector stub
  - `justfile` — two new recipes (`obs-collector-logs`, `obs-collector-rollout`)
  - `README.md` — new subsection; backend-in-k3s and observability narratives refreshed
- **New tool dependencies:**
  - No new host dependencies. `kubectl`, `kustomize`, `helm`, `limactl`, `docker` cover everything.
  - One new container image consumed by the obs cluster: `otel/opentelemetry-collector-contrib:0.111.0`. Same image already in use by compose and the app cluster — three users, one pin.
- **Dependencies on external services:**
  - The obs VM's host-published ports `:14317` / `:14318` MUST be reachable from inside the app VM via `host.lima.internal`. This relies on the same `host.lima.internal` → macOS gateway path that the slice 18a app collector already uses for compose `:4317`; the new claim is only that Lima's host-side port-forward layer routes those ports back into the obs VM where klipper-lb terminates the LoadBalancer Service.
  - The obs VM MUST be running for the app collector's `otlp/obs-cluster` exporter to succeed. When the obs VM is down, the app collector's dual-write degrades to "compose only" — the collector logs an export error every batch interval but continues delivering to `otlp/compose-relay`. Operators who do not run `just obs-up` see no functional regression vs slice 18a, just log noise.
- **CI:** no new CI jobs. The k3s flow remains dev-only.
- **Compatibility:** additive at the topology level. Anyone who pulls this branch and runs only `just up && just backend-apply` (no obs VM) gets a backend whose traces still reach compose grafana exactly as before; the new `otlp/obs-cluster` exporter logs failures but does not break the compose path. Anyone who also runs `just obs-up && kustomize build infra/k8s-obs/overlays/local | kubectl --context social-obs apply -f -` gets the bridge end-to-end. A reader who only runs `./gradlew bootRun` (host loop) sees no behavior change.
- **Rollback:** `git revert` the merge. Reverting drops the obs `./collector` subdirectory, the four datasource entries from grafana values, the two obs portForwards, the second exporter from the app collector's pipeline, and the justfile recipes. The app collector falls back to single-exporter (compose-only) — identical to post-18a state. The obs cluster's `kubectl apply` step also removes the obs collector Deployment, Service, and ConfigMap. If a partial rollback is needed (e.g. the obs collector misbehaves), a one-line edit to the app collector's traces pipeline (remove `otlp/obs-cluster` from `exporters:`, `kubectl rollout restart deploy/collector -n social`) restores the slice-18a path immediately; the obs-side resources can be deleted independently afterwards.
