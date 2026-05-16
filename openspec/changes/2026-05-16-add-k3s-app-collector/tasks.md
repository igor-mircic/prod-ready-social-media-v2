## 1. Layout — `infra/k8s/base/collector/` directory

- [x] 1.1 Create `infra/k8s/base/collector/` directory. Add a header comment in the directory's `kustomization.yaml` (see task 1.2) naming the slice and pointing at the sibling compose collector config (`infra/observability/collector/collector-config.yaml`) for context.
- [x] 1.2 Create `infra/k8s/base/collector/kustomization.yaml` listing `./configmap.yaml`, `./deployment.yaml`, `./service.yaml` under `resources:`. Declare default labels (`app.kubernetes.io/name=collector`, `app.kubernetes.io/part-of=social`). Pin the image tag in one place via the `images:` kustomize directive (`name: otel/opentelemetry-collector-contrib`, `newTag: 0.111.0`) so a future bump touches one line.
- [x] 1.3 Update `infra/k8s/base/kustomization.yaml` to append `./collector` to its `resources:` block, after the existing `./postgres`, `./backend`, `./frontend` entries.

## 2. Collector Service

- [x] 2.1 Create `infra/k8s/base/collector/service.yaml` declaring a `Service` named `collector` in the `social` namespace with `type: ClusterIP` and selector `app.kubernetes.io/name=collector`.
- [x] 2.2 Declare two ports: `name: otlp-grpc, port: 4317, targetPort: otlp-grpc, protocol: TCP` and `name: otlp-http, port: 4318, targetPort: otlp-http, protocol: TCP`. Do NOT publish a NodePort or LoadBalancer — only in-cluster traffic reaches this Service.
- [x] 2.3 Verify the Service FQDN renders to `collector.social.svc.cluster.local` by running `kustomize build --enable-helm infra/k8s/overlays/local | yq 'select(.kind == "Service" and .metadata.name == "collector").metadata.namespace'` and confirming `social`.

## 3. Collector ConfigMap

- [x] 3.1 Create `infra/k8s/base/collector/configmap.yaml` declaring a `ConfigMap` named `collector-config` in the `social` namespace, with a single data key `config.yaml` containing the collector configuration described in 3.2–3.6.
- [x] 3.2 Receivers block: enable `otlp` with `protocols.grpc.endpoint: 0.0.0.0:4317` and `protocols.http.endpoint: 0.0.0.0:4318`. Do NOT add a `cors:` block (per design Decision 4 — only in-cluster pods reach this collector).
- [x] 3.3 Processors block: declare `batch: {}` and `transform/redact-path-ids:` with the EXACT SAME OTTL `trace_statements` as `infra/observability/collector/collector-config.yaml` (the UUID, opaque-hex >= 8, and numeric >= 4 patterns over `span.name`, `attributes.http.url`, `attributes.http.target`, `attributes.url.full`). Add a header comment naming the sibling compose collector config and warning that the OTTL statements must stay in sync until slice 22 retires the compose collector. Do NOT add `filter/drop_high_cardinality`, `filter/frontend_only`, `transform/pii_scrub`, or `attributes/loki_labels` — those processors govern metrics and logs pipelines that this slice does not have.
- [x] 3.4 Extensions block: declare `health_check: {}` so the collector exposes `:13133/` for kubelet probes (per design Decision 5). Add `extensions: [health_check]` under the `service:` block.
- [x] 3.5 Exporters block: declare one exporter `otlp/compose-relay:` with `endpoint: host.lima.internal:4317` and `tls.insecure: true`. Add a header comment naming this as the slice-15 host alias bridge, transitional, replaced by slice 18b.
- [x] 3.6 Service block: declare one pipeline `traces` with `receivers: [otlp]`, `processors: [batch, transform/redact-path-ids]`, `exporters: [otlp/compose-relay]`. Do NOT declare `metrics`, `logs/backend`, or `logs/frontend` pipelines (per design Decision and Open Question 4 — no producer exists in this slice).
- [x] 3.7 Verify the ConfigMap renders by `kustomize build --enable-helm infra/k8s/overlays/local | yq 'select(.kind == "ConfigMap" and .metadata.name == "collector-config").data."config.yaml"'`. Pipe the output through `otelcol-contrib validate --config=/dev/stdin` (if installed locally) to catch typos. If not installed, deferring to the runtime probe in task 8.

## 4. Collector Deployment

- [x] 4.1 Create `infra/k8s/base/collector/deployment.yaml` declaring a `Deployment` named `collector` in the `social` namespace, with `replicas: 1`, selector `app.kubernetes.io/name=collector`, and the same label on the pod template.
- [x] 4.2 Container `collector` uses image `otel/opentelemetry-collector-contrib:0.111.0` (the `images:` directive in 1.2 resolves this). Args `["--config=/etc/otelcol-contrib/config.yaml"]`.
- [x] 4.3 Declare named containerPorts: `otlp-grpc=4317`, `otlp-http=4318`, `healthcheck=13133`. (The healthcheck port does NOT need to be on the Service — it is for probes only.)
- [x] 4.4 Mount the `collector-config` ConfigMap at `/etc/otelcol-contrib/` read-only. Use `volumes:` + `volumeMounts:`; the key `config.yaml` projects to a file at the mount path.
- [x] 4.5 Declare probes: `livenessProbe.httpGet` at `path: /, port: healthcheck` with `initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 3`; `readinessProbe.httpGet` at the same path/port with `periodSeconds: 5, failureThreshold: 3`. No startupProbe.
- [x] 4.6 Declare `resources.requests: cpu=50m, memory=128Mi` and `resources.limits: cpu=500m, memory=256Mi`.
- [x] 4.7 Declare `securityContext.runAsNonRoot: true` and `securityContext.runAsUser: 10001` (the contrib image's bundled nonroot user). `readOnlyRootFilesystem: true` is allowed because the collector only reads from the mounted ConfigMap and writes to stdout.

## 5. Backend Deployment env flip

- [x] 5.1 Edit `infra/k8s/base/backend/deployment.yaml` to change `OTEL_EXPORTER_OTLP_ENDPOINT` from `http://host.lima.internal:4318` to `http://collector.social.svc.cluster.local:4318`. Update the surrounding comment to reflect the new in-cluster target (and note that the host alias was the slice-15 transitional shim, now retired for in-cluster backends).
- [x] 5.2 Confirm no other `host.lima.internal:4318` reference remains in `infra/k8s/base/backend/`. Grep and remove any stale doc comment lines that still describe the old target.
- [x] 5.3 Run `kustomize build --enable-helm infra/k8s/overlays/local | yq 'select(.kind == "Deployment" and .metadata.name == "backend").spec.template.spec.containers[0].env'` and verify the new value is present.

## 6. Hetzner overlay stub

- [x] 6.1 Edit `infra/k8s/overlays/hetzner/kustomization.yaml` to append a commented stub block naming what the Hetzner deploy slice will add for the collector: production resource caps, the cross-cluster exporter endpoint (eventual obs-cluster Service or its production DNS), TLS / mTLS material reference, tighter probe timings, and any anti-affinity considerations. Comments only; no live resources.
- [x] 6.2 Verify the Hetzner overlay still builds with `kustomize build --enable-helm infra/k8s/overlays/hetzner` after the edit. The build SHOULD produce the same set of resources as before (the comments do not change the rendered output).

## 7. justfile recipes

- [x] 7.1 Add a `collector-logs` recipe: `kubectl logs -n social deploy/collector -f`. Single-line doc comment in the recipe matching the style of `backend-logs`.
- [x] 7.2 Add a `collector-rollout` recipe: `kubectl rollout restart deploy/collector -n social && kubectl rollout status deploy/collector -n social --timeout=60s`. Doc comment names the use case (picking up ConfigMap edits, since Kubernetes does not auto-restart pods on ConfigMap change).
- [x] 7.3 Verify both recipes appear in `just --list` with the doc comments.

## 8. End-to-end verification

- [x] 8.1 With both `lima.yaml` (app VM) and `obs.yaml` (obs VM) UP and the `observability` compose profile running, apply the new overlay: `just backend-apply` (which calls `kustomize build --enable-helm infra/k8s/overlays/local | kubectl apply -f -`).
- [x] 8.2 Confirm `kubectl -n social get pods` shows `collector-*` Running and Ready.
- [x] 8.3 Confirm `kubectl -n social rollout status deploy/backend --timeout=120s` succeeds (the rolled backend pod uses the new env).
- [x] 8.4 Generate traffic against the in-cluster backend (e.g. `just backend-forward` + `curl http://localhost:18080/actuator/health` a few times, or run the e2e harness against the in-cluster path).
- [x] 8.5 In compose grafana (`http://localhost:3000`), open the Tempo datasource, search for the backend `service.name=backend` and confirm spans appear. The trace path should now traverse the in-cluster collector first; verify by `kubectl -n social logs deploy/collector --tail=50` and confirming the collector reports non-zero `otelcol_receiver_accepted_spans` over its internal metrics, OR by greping the collector logs for `TracesExporter` debug lines (if enabled).
- [x] 8.6 Verify the redaction policy still applies: hit `http://localhost:18080/api/v1/users/c0ffee00-1234-5678-9abc-deadbeef0000/profile` (or similar) and confirm Tempo shows the path as `/api/v1/users/{id}/profile`.
- [x] 8.7 Verify rollback: temporarily edit `infra/k8s/base/backend/deployment.yaml` back to `host.lima.internal:4318`, `kubectl apply`, rollout, hit traffic, confirm spans still arrive in compose grafana via the direct path. Re-apply the in-cluster target before committing.

## 9. Docs

- [x] 9.1 Update `README.md`'s "Run the backend in cluster (optional)" subsection: explain that the backend pod's OTLP target is now an in-cluster Service (`collector.social.svc.cluster.local:4318`); explain that the collector pod relays to compose at `host.lima.internal:4317`; restate the non-goal that the obs cluster is NOT yet wired in.
- [x] 9.2 Update `README.md`'s "Local observability" section's BE-in-k3s narrative to match (BE no longer dials `host.lima.internal:4318` directly).
- [x] 9.3 Add a "Collector relay (in-cluster)" subsection naming the two `just` recipes (`collector-logs`, `collector-rollout`) and the rollback shortcut (one-line env edit on the backend Deployment).
