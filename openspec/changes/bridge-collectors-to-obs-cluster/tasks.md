## 1. Layout — `infra/k8s-obs/base/collector/` directory

- [ ] 1.1 Create `infra/k8s-obs/base/collector/` directory. Add a header comment in the directory's `kustomization.yaml` (see task 1.2) naming the slice and pointing at the app cluster's collector (`infra/k8s/base/collector/`) as the configuration sibling whose pipeline shape mirrors here.
- [ ] 1.2 Create `infra/k8s-obs/base/collector/kustomization.yaml` listing `./configmap.yaml`, `./deployment.yaml`, `./service.yaml` under `resources:`. Declare default labels (`app.kubernetes.io/name=collector`, `app.kubernetes.io/part-of=observability`). Pin the image tag in one place via the `images:` Kustomize directive (`name: otel/opentelemetry-collector-contrib`, `newTag: 0.111.0`) so a future bump touches one line. The chosen tag MUST match the app cluster collector's and the compose collector's pin — grep both to confirm before committing.
- [ ] 1.3 Update `infra/k8s-obs/base/kustomization.yaml` to append `./collector` to its `resources:` block. Place it after the existing `./prometheus`, `./loki`, `./tempo`, `./grafana`, `./alertmanager` entries.

## 2. Obs collector Service

- [ ] 2.1 Create `infra/k8s-obs/base/collector/service.yaml` declaring a `Service` named `collector` in the `observability` namespace with `type: LoadBalancer` and selector `app.kubernetes.io/name=collector`.
- [ ] 2.2 Declare two ports: `name: otlp-grpc, port: 4317, targetPort: otlp-grpc, protocol: TCP` and `name: otlp-http, port: 4318, targetPort: otlp-http, protocol: TCP`. Do NOT add a NodePort override — klipper-lb assigns the VM IP.
- [ ] 2.3 Add a header comment in `service.yaml` explaining (a) why LoadBalancer (matches slice 14 postgres precedent; off-cluster reachability via Lima portForwards), and (b) the fate-separation carve-out from slice-17 `observability-cluster` spec — the OTLP receiver is the one ingress path the obs cluster legitimately exposes toward the app cluster.

## 3. Obs collector ConfigMap

- [ ] 3.1 Create `infra/k8s-obs/base/collector/configmap.yaml` declaring a `ConfigMap` named `collector-config` in the `observability` namespace, with a single data key `config.yaml` containing the obs collector pipeline declared in 3.2–3.7.
- [ ] 3.2 Receivers block: enable `otlp` with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`. Do NOT add a `cors:` block — only the app cluster collector dials this receiver.
- [ ] 3.3 Processors block: declare `batch: {}` and `transform/redact-path-ids:` with the EXACT SAME OTTL `trace_statements` as `infra/k8s/base/collector/configmap.yaml`. Add a header comment naming the app collector's config as the source-of-truth sibling and warning that the OTTL statements MUST stay in sync across all three collectors (compose, app, obs) until slice 22 retires the compose path.
- [ ] 3.4 Extensions block: declare `health_check: {}` and add `extensions: [health_check]` under `service:`.
- [ ] 3.5 Exporters block: declare exactly one exporter `otlp/tempo:` with `endpoint: tempo.observability.svc.cluster.local:4317` and `tls.insecure: true`. Add a comment naming this as the in-cluster hop (loopback-equivalent — both pods are in the same k3s); slice 19 introduces the cross-cluster TLS material on the *receiver* side (`otlp.protocols.grpc.tls:`), NOT this in-cluster exporter.
- [ ] 3.6 Service block: declare one pipeline `traces` with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/tempo]`. Do NOT declare `metrics`, `logs/backend`, or `logs/frontend` pipelines — slices 20 and 21 own those.
- [ ] 3.7 Verify the ConfigMap renders by `kustomize build --enable-helm infra/k8s-obs/overlays/local | yq 'select(.kind == "ConfigMap" and .metadata.name == "collector-config").data."config.yaml"'`. Optionally pipe through `otelcol-contrib validate --config=/dev/stdin` if installed.

## 4. Obs collector Deployment

- [ ] 4.1 Create `infra/k8s-obs/base/collector/deployment.yaml` declaring a `Deployment` named `collector` in the `observability` namespace, with `replicas: 1`, selector `app.kubernetes.io/name=collector`, and the same label on the pod template.
- [ ] 4.2 Container `collector` uses image `otel/opentelemetry-collector-contrib:0.111.0` (the `images:` directive in 1.2 resolves this). Args `["--config=/etc/otelcol-contrib/config.yaml"]`.
- [ ] 4.3 Declare named containerPorts: `otlp-grpc=4317`, `otlp-http=4318`, `healthcheck=13133`.
- [ ] 4.4 Mount the `collector-config` ConfigMap at `/etc/otelcol-contrib/` read-only via `volumes:` + `volumeMounts:`.
- [ ] 4.5 Declare probes: `livenessProbe.httpGet` at `path: /, port: healthcheck` with `initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 3`; `readinessProbe.httpGet` at the same path/port with `periodSeconds: 5, failureThreshold: 3`. No startupProbe.
- [ ] 4.6 Declare `resources.requests: cpu=50m, memory=128Mi` and `resources.limits: cpu=500m, memory=512Mi`. Note the higher memory limit (`512Mi` vs the app collector's `256Mi`) — this is the cross-cluster aggregation point and headroom matters more here.
- [ ] 4.7 Declare `securityContext.runAsNonRoot: true`, `securityContext.runAsUser: 10001`, `readOnlyRootFilesystem: true` — same posture as the app collector.

## 5. Obs Lima VM portForwards

- [ ] 5.1 Edit `infra/lima/obs.yaml`: in the `portForwards:` block, add two new entries BEFORE the catch-all `guestPortRange: [1, 65535], ignore: true` rule:
  - `- guestPort: 4317, hostPort: 14317`
  - `- guestPort: 4318, hostPort: 14318`
  Header comment update: name the +10000 offset rule (symmetric with apiserver `:16443`/`:16444`) and explain that compose collector owns `:4317`/`:4318` on the host.
- [ ] 5.2 Verify the YAML lints by `limactl validate infra/lima/obs.yaml`. If `validate` is not available, parse as YAML via `yq` (`yq '.portForwards' infra/lima/obs.yaml`) and visually confirm.
- [ ] 5.3 Note for execution: Lima only re-reads `portForwards` on VM start. After this edit, `limactl stop social-obs && just obs-up` is the operator step that picks up the new forwards. This is called out in the README addition (task 11.2).

## 6. App collector ConfigMap — add the `otlp/obs-cluster` exporter

- [ ] 6.1 Edit `infra/k8s/base/collector/configmap.yaml`: add a new exporter `otlp/obs-cluster:` with `endpoint: host.lima.internal:14317` and `tls.insecure: true`. Add a header comment naming this as the slice-18b cross-cluster path, the local mirror of the Hetzner private-network IP, and noting that slice 19 introduces mTLS on the *receiver* side without touching this exporter's address.
- [ ] 6.2 In the same file, edit the `service.pipelines.traces.exporters:` list from `[otlp/compose-relay]` to `[otlp/compose-relay, otlp/obs-cluster]`. Order is not significant; alphabetize for stable diffs.
- [ ] 6.3 Update the file-header comment to reflect that the collector now dual-writes. Reference the slice-17 "build the new house before tearing down the old one" sequencing and name slice 22 as the slice that collapses dual-write back to single-exporter.
- [ ] 6.4 Verify by `kustomize build --enable-helm infra/k8s/overlays/local | yq 'select(.kind == "ConfigMap" and .metadata.name == "collector-config").data."config.yaml"'` and confirm both exporters and the dual-exporter pipeline appear.

## 7. App cluster Hetzner overlay stub — one-line addition

- [ ] 7.1 Edit `infra/k8s/overlays/hetzner/kustomization.yaml`: append a commented narrative line to the existing collector stub naming that (a) the production analogue of `host.lima.internal:14317` is the obs box's tailscale/private-network IP, and (b) dual-write to the compose collector is local-only and MUST NOT be inherited by Hetzner — slice 22 collapses dual-write before any prod cutover.

## 8. Obs Hetzner overlay stub — new commented block

- [ ] 8.1 Edit `infra/k8s-obs/overlays/hetzner/kustomization.yaml`: append a commented block naming what the Hetzner-deploy slice will add for the obs collector: production resource caps, real TLS material (cert-manager-issued client/server certs that slice 19 introduces), an Ingress or LoadBalancer that terminates inbound OTLP on the obs box's public/private IP, tighter probe timings, and storage / retention sizing for the obs box. Comments only — no live resources.

## 9. Grafana datasource provisioning

- [ ] 9.1 Edit `infra/k8s-obs/base/grafana/values.yaml`: add a `datasources:` configuration block (the grafana chart's standard `datasources.datasources\.yaml.datasources:` shape) declaring four entries: `Tempo`, `Prometheus`, `Loki`, `Alertmanager`.
- [ ] 9.2 Tempo datasource: `type: tempo`, `url: http://tempo.observability.svc.cluster.local:3200`, `access: proxy`. Enable service-graph in `jsonData` (mirroring the compose-side tempo datasource's stance from the `frontend-traces` slice). Mark `editable: false`.
- [ ] 9.3 Prometheus datasource: `type: prometheus`, `url: http://prometheus-server.observability.svc.cluster.local`, `access: proxy`, `editable: false`. Add a comment noting this datasource will render "no data" until slice 21 lands the cluster-metrics pipeline.
- [ ] 9.4 Loki datasource: `type: loki`, `url: http://loki.observability.svc.cluster.local:3100`, `access: proxy`, `editable: false`. Add a comment noting this datasource will render "no data" until slice 20 lands the pod log shipper.
- [ ] 9.5 Alertmanager datasource: `type: alertmanager`, `url: http://alertmanager.observability.svc.cluster.local:9093`, `access: proxy`, `editable: false`. Add a comment noting alertmanager UI is consumable now (it shows the chart-default empty state) but alerting rules are owned by a future slice.
- [ ] 9.6 Verify the chart renders by `kustomize build --enable-helm infra/k8s-obs/overlays/local | yq 'select(.kind == "ConfigMap" and (.metadata.name | test("grafana"))).data'`. Confirm the datasources sidecar / ConfigMap contains all four entries.

## 10. justfile recipes

- [ ] 10.1 Edit the repo-root `justfile`: add `obs-collector-logs` recipe — `kubectl --context social-obs logs -n observability deploy/collector -f`. Mirror the existing `collector-logs` recipe's docstring shape.
- [ ] 10.2 Add `obs-collector-rollout` recipe — `kubectl --context social-obs rollout restart deploy/collector -n observability && kubectl --context social-obs rollout status deploy/collector -n observability`. Mirror the existing `collector-rollout` recipe.
- [ ] 10.3 Run `just --list` and confirm both recipes appear with their docstrings.

## 11. README

- [ ] 11.1 Update the "Local observability" section of `README.md`: add a "Bridging to the obs cluster" subsection describing the dual-write topology (BE → app collector → BOTH compose collector AND obs collector → respective tempos → respective grafanas), the `host.lima.internal:14317` hop, the four datasources provisioned in obs grafana, the expectation that compose and obs grafanas show identical backend trace data, and the explicit non-goal that the obs cluster has no auth on its OTLP receiver yet (slice 19).
- [ ] 11.2 In the same subsection, document the operator step "after pulling this slice, run `limactl stop social-obs && just obs-up` once so Lima picks up the new portForwards." Once that's done, `just backend-apply` and `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs apply -f -` complete the cutover.
- [ ] 11.3 Add a short troubleshooting block: if the app collector logs `otlp/obs-cluster` connection errors, check (a) `kubectl --context social-obs -n observability get svc collector -o wide` for `EXTERNAL-IP: <pending>` (klipper-lb issue), (b) `lsof -i :14317` on the host (port collision), (c) `limactl list` shows `social-obs` in `Running` state.

## 12. Apply, verify, and end-to-end check

- [ ] 12.1 Bring both VMs up if not already (`just up && just obs-up`). Confirm both contexts: `kubectl --context lima-social get nodes` and `kubectl --context social-obs get nodes` both show `Ready`.
- [ ] 12.2 Restart the obs VM to pick up the new portForwards: `limactl stop social-obs && just obs-up`.
- [ ] 12.3 Apply the obs cluster manifests: `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs apply -f -`. Watch `kubectl --context social-obs -n observability get pods -w` until the new `collector` Deployment reaches Ready.
- [ ] 12.4 Confirm the obs collector LoadBalancer Service has an external IP: `kubectl --context social-obs -n observability get svc collector -o wide`. `EXTERNAL-IP` should be the obs VM's IP (NOT `<pending>`).
- [ ] 12.5 Apply the app cluster updates: `just backend-apply` (this picks up the app collector ConfigMap change and rollout-restarts the collector). Confirm the app collector pod reaches Ready: `kubectl --context lima-social -n social get deploy collector`.
- [ ] 12.6 Tail both collectors: `just collector-logs` and `just obs-collector-logs` in two terminals.
- [ ] 12.7 Generate traffic: open the frontend at its usual local URL, create a post, refresh the feed. Confirm the app collector logs report non-zero accepted spans and no `otlp/obs-cluster` exporter errors. Confirm the obs collector logs report non-zero accepted spans.
- [ ] 12.8 Open compose grafana → Explore → Tempo → query `service.name=backend` over the last 5 min. Confirm traces appear with the recent traffic.
- [ ] 12.9 Open obs grafana via `just obs-grafana` → log in → Explore → Tempo → same query. Confirm THE SAME traces appear (matching trace IDs).
- [ ] 12.10 Open obs grafana → Configuration → Data sources. Confirm all four datasources are listed (Tempo, Prometheus, Loki, Alertmanager). Click each; confirm Tempo is `OK` and the others are `OK` connection-wise (they will render no data downstream, but the URL test should succeed against their in-cluster Services).
- [ ] 12.11 Redaction smoke check: generate a request whose path includes a UUID (e.g. open `/users/<some-uuid>/profile` via the frontend if any such route exists, or `curl` the BE directly). In obs grafana's Tempo, open the resulting trace and confirm `attributes.http.url` shows `{id}` in place of the UUID. Repeat in compose grafana; confirm the same redaction.

## 13. Degraded-mode check — obs VM down

- [ ] 13.1 Stop the obs VM: `limactl stop social-obs`. The compose collector and app cluster keep running.
- [ ] 13.2 Generate traffic against the app cluster.
- [ ] 13.3 Confirm in `just collector-logs` that the app collector logs `otlp/obs-cluster` exporter errors (connection refused / dial timeout) BUT continues to deliver to `otlp/compose-relay`. The collector pod does NOT restart, does NOT crash.
- [ ] 13.4 Confirm compose grafana → Tempo continues to show the recent traffic's traces (the dual-write degraded-mode requirement from the observability spec).
- [ ] 13.5 Bring obs back up (`just obs-up`); confirm the exporter recovers (no manual restart of the app collector needed; the OTLP exporter retries on its own).

## 14. Spec / change validation and commit

- [ ] 14.1 Run `openspec validate bridge-collectors-to-obs-cluster --strict`. Address any errors.
- [ ] 14.2 Run `openspec diff bridge-collectors-to-obs-cluster` and visually inspect that the three spec deltas (observability, kubernetes, observability-cluster) are coherent and complete.
- [ ] 14.3 Commit the change artifacts and the implementation in a feature branch named after the change ID (`bridge-collectors-to-obs-cluster`). Reference the slice 18a proposal in the commit message for the carve-up rationale.
- [ ] 14.4 Open a PR and watch CI. CI continues compose-only (no k3s in CI), so the existing test suites should pass unmodified. The CI signal is "did anything I touched in the app cluster manifests break the existing test surface" — i.e. the answer is "nothing did, this slice is dev-only."
- [ ] 14.5 Archive the change after merge: `openspec archive bridge-collectors-to-obs-cluster --yes`.
