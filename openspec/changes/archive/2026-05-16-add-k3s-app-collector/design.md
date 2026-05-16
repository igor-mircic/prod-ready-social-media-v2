## Context

After slices 14–17 the app cluster runs postgres, backend, and frontend; a second Lima VM runs an empty obs cluster (LGTM stack stood up, no data flowing in). The backend's OTel Java agent ships OTLP to `host.lima.internal:4318` — a transitional shim with no Hetzner analogue that slice 15's spec explicitly marked for replacement.

The original `add-k3s-app-collector` slice envisioned in slice 17's design doc packed four large moves into one: stand up an in-cluster collector, flip the backend OTLP target, bridge data across to the obs cluster, and provision grafana datasources. Reading the on-disk reality of the collector config (`infra/observability/collector/collector-config.yaml` has 5 pipelines, 6 processors, 3 exporters), the FE bundle bake-ins (`VITE_OTEL_*_ENDPOINT` is build-time), the FE pod's nginx (no proxy entries for OTLP), and the cross-VM networking question (the obs VM is on a different Lima network, no NodePort or LoadBalancer is yet exposed for OTLP receivers) reveals the original slice as three architecturally independent moves bundled together.

This slice is the first of three splits. It does the data-plane work only — collector pod in app cluster, backend flips, relay to compose — and explicitly defers the cross-cluster bridge to a sibling slice and the browser flip to a third. The remaining slices in the arc (19+) are unchanged from slice 17's design doc.

A separate concern surfaced on slice 16's manual verification: browser clicks and backend spans appear as separate traces in tempo (the FE→BE trace-propagation gap recorded in memory). That gap is *not* this slice's scope, but the split creates a clean diagnostic window: after this slice lands, BE telemetry traverses a new in-cluster hop while compose grafana keeps showing the unified picture, which is exactly the topology to A/B against pnpm dev / vite preview while running the diagnostic.

## Goals / Non-Goals

**Goals:**

- Stand up an `otel/opentelemetry-collector-contrib:0.111.0` Deployment in the app cluster's `social` namespace, fronted by a ClusterIP Service named `collector`.
- Flip the backend Deployment's `OTEL_EXPORTER_OTLP_ENDPOINT` from `http://host.lima.internal:4318` to `http://collector.social.svc.cluster.local:4318`.
- The in-cluster collector SHALL apply `batch` and `transform/redact-path-ids` processors on traces and SHALL relay the resulting spans to the compose collector at `host.lima.internal:4317` (OTLP/gRPC, TLS insecure) for tempo ingestion.
- End state: compose grafana shows in-cluster backend traces exactly as it does today — same trace count, same redaction outcome, same dashboard panels. The only difference is one extra hop inside the app cluster.
- Rollback path: one-line edit to the backend Deployment's `OTEL_EXPORTER_OTLP_ENDPOINT` (back to `host.lima.internal:4318`) restores the prior topology before the rest of the slice is reverted; the in-cluster collector Deployment can be deleted independently.
- `just collector-logs` and `just collector-rollout` recipes mirror the `backend-*` / `frontend-*` shape.
- README documents the new hop and the transitional `host.lima.internal:4317` exporter target.

**Non-Goals:**

- Standing up the obs cluster's collector receiver. The cross-VM transport decision (NodePort / LoadBalancer / lima alias) is the next slice's problem.
- Provisioning datasources in obs grafana. Lands with the cross-cluster bridge.
- Changing the FE bundle's OTLP endpoint baking. Browser still goes to compose collector cross-origin.
- Changing the FE pod's nginx config. Browser path is untouched.
- Solving the FE→BE trace propagation gap. That investigation is parallel work that benefits from this slice's topology but does not require it.
- Shipping BE pod logs to compose loki (or anywhere else). BE-in-k3s logs continue to live on stdout only — same as today. Slice 20 owns this.
- Scraping in-cluster backend metrics from compose Prometheus. Same gap as today; slice 21 owns it.
- Adding a metrics or logs pipeline to the in-cluster collector. The Java agent has `OTEL_METRICS_EXPORTER=none` and `OTEL_LOGS_EXPORTER=none` (per the observability spec); a metrics or logs pipeline in this slice would have no producer.
- Removing the compose collector. The slice ends with the compose collector receiving traces from the in-cluster collector instead of from the backend directly; compose collector still has the other four pipelines (browser FE traces, browser FE metrics, browser FE logs, host-BE filelog logs). Slice 22 retires compose.
- Cross-cluster mTLS, autoscaling, NetworkPolicy, image signing, SBOM.

## Decisions

### Decision 1 — Split the original slice 18 into 18a / 18b / 18c along the dependency graph

The original `add-k3s-app-collector` slice as written in slice 17's design doc would have touched ~30 files across six directories AND made three architecturally independent decisions (cross-VM transport, browser OTLP path, BE log path). Each of those decisions deserves its own discovery and its own rollback boundary.

The dependency graph forces an ordering:

```
   18a (this slice)  ─▶  collector exists in app cluster
                         BE talks to in-cluster collector
                         end state: identical to today, one new hop

   18b               ─▶  obs collector exists
                         cross-VM transport chosen and wired
                         app collector multi-exports to obs + compose
                         obs grafana datasources land
                         end state: double-vision (compose still works)

   18c               ─▶  FE bundle rebake (relative /v1/* endpoints)
                         nginx pod gains /v1/traces, /v1/metrics, /v1/logs
                         browser ships same-origin → app collector
                         end state: browser OTLP cross-origin trap eliminated
```

Considered and rejected:

- **Keep slice 18 monolithic, trim non-goals explicitly.** Reviewable in one go and lands in one PR, but each architectural decision pollutes the others — a backout of the cross-cluster transport choice would drag the BE OTLP flip along with it. The three concerns truly are separable.
- **Split by signal (traces, then metrics, then logs).** Each signal-slice still touches both clusters AND the FE bundle AND the BE deployment — overlap dominates the savings. The dependency graph is by layer, not by signal.
- **Split into two: data plane + bridge as one slice, browser flip as another.** Folds two of the three architectural decisions back into one PR (transport + relay topology). Better than monolithic, worse than three-way for diff size and rollback boundary.

### Decision 2 — Relay through the compose collector via `host.lima.internal:4317`, not direct to compose tempo

The in-cluster collector exports OTLP/gRPC to the compose collector's published port `:4317`, NOT directly to compose tempo on `:4317`. Compose tempo is only published on the docker network — its OTLP receivers are not host-reachable (only its query API on `:3200` is, per `docker-compose.yml`). So "direct to tempo" is not an option without modifying compose; modifying compose is explicitly out of scope this slice.

Considered:

- **Publish tempo's OTLP port on docker-compose and skip the compose collector for this signal.** Possible, but pulls compose into the change footprint and creates a parallel path that bypasses the slice-5 `transform/redact-path-ids` processor configured in compose collector. Until slice 22 retires compose, the compose collector remains the trace-processing source-of-truth — better to keep relaying through it.
- **Direct to obs tempo over the cross-VM boundary now.** That is exactly slice 18b; doing it here merges the two slices back together.

The cost of the relay hop is a single TCP connection's worth of latency and zero meaningful CPU on the compose collector (batch + redact are idempotent on already-redacted spans because the OTTL patterns will not match `/{id}`).

### Decision 3 — Apply `transform/redact-path-ids` in the in-cluster collector even though the compose collector also applies it

The in-cluster collector's pipeline includes the same `transform/redact-path-ids` OTTL block as the compose collector. Two reasons:

1. **The in-cluster collector is the eventual production-shape processor.** When slice 22 retires compose and slice 18b/c land, the in-cluster collector becomes the only collector on the app side of the bridge. Building its processor stack now means the obs-cluster bridge work in 18b can focus on transport, not processor migration.
2. **Defensive redaction in the path matters more than processor purity.** The cost of running redaction twice is zero (idempotent on already-redacted spans); the cost of running it zero times in a misconfigured state is a high-cardinality dashboard explosion.

The drift risk (someone edits one config and forgets the other) is real for the ~6 slices the two configs coexist. A header comment in each ConfigMap names the sibling and warns about drift; slice 22's retirement collapses the two into one.

### Decision 4 — No CORS on the in-cluster collector's OTLP/HTTP receiver

The compose collector's OTLP/HTTP receiver has an `allowed_origins` block listing `:5173`, `:4173`, and `:13000` (the browser origins that POST directly to it). The in-cluster collector does NOT need this block: in this slice, only the in-cluster backend pod talks to it (server-side fetch, no preflight). The browser continues to ship cross-origin to the compose collector unchanged.

Slice 18c is the one that introduces browser → in-cluster collector traffic, and even there the path is same-origin via the FE pod's nginx (no CORS preflight). So CORS is never needed on the in-cluster collector.

Considered: adding the CORS block defensively now. Rejected — empty `allowed_origins` is more honest about the trust boundary, and the slice-16 memory ("Browser OTLP cross-origin trap") makes explicit that this allowlist is *per-origin*, not blanket. Better to add entries when an actual origin needs them.

### Decision 5 — Health probes target the collector's bundled `:13133/` health-check extension

The contrib collector image ships with the `health_check` extension. Enabling it in the ConfigMap surfaces a `:13133/` HTTP endpoint that returns 200 once all pipelines are alive. The Deployment's liveness and readiness probes target that endpoint.

Considered:

- **Probe `:4318/` (the OTLP/HTTP receiver port).** The receiver responds 404 to a bare GET — it expects POST to `/v1/traces`. A 404 is technically a "TCP-connected and HTTP-responding" health signal but kubelet's probe machinery treats 4xx as unhealthy. Workaround would be to allow 4xx as healthy, which is ugly.
- **TCP-only probe on `:4317` (gRPC).** Tells you the socket is open but not that the pipeline is alive; insufficient.

The bundled health-check extension is the documented pattern.

## Risks / Trade-offs

- **[Compose collector drift]** The redact-path-ids OTTL statements are duplicated between `infra/observability/collector/collector-config.yaml` and `infra/k8s/base/collector/configmap.yaml`. If one is updated and the other forgotten, BE-in-k3s and BE-on-host (or in-cluster-relayed-vs-direct-FE) get asymmetric redaction. Mitigation: header comment in both files naming the sibling; slice 22 deletes the compose one. Acceptable for the transition.
- **[Collector pod crashes silently swallow BE telemetry]** The collector is a single replica with no PDB and no HPA. If it OOMs or crashes, BE OTLP traffic drops until the pod restarts. The Java agent does retry within its OTLP exporter's queue, so brief outages are absorbed; longer ones lose spans. Mitigation: resource limits set generously enough (256Mi memory limit vs the agent's typical ~5KB/s span throughput) that OOM is unlikely; rollout-restart recipe gives quick recovery; compose collector remains as a fallback target (one env-var revert away). Acceptable for a dev cluster.
- **[Two collectors confuse readers]** "Wait, which collector am I editing?" The compose collector handles browser FE OTLP + host BE filelog; the in-cluster collector handles in-cluster BE OTLP. Mitigation: README subsection explicitly names which path each signal takes; ConfigMap header comments name the slice that owns them.
- **[Relay-through-compose adds latency]** One extra TCP hop (in-cluster pod → host.lima.internal:4317 → compose collector → compose tempo). At local-dev volumes (single-user, no load), this is sub-millisecond and invisible. The hop disappears in slice 18b when the relay target flips to obs.
- **[Collector image cold-pull on first apply]** First `just backend-apply` after this slice pulls `otel/opentelemetry-collector-contrib:0.111.0` from Docker Hub through the Lima VM. Subsequent applies hit the VM's local image cache. Mitigation: the same image is already used in compose, so most contributors will have it cached on the docker side of the host; on a fresh Lima VM the pull adds ~30s to first apply. Documented in README.
- **[The transitional requirement language matters for future slices]** The observability spec's existing requirement is explicitly transitional ("SHALL be revised or removed at that time"). This slice does the revision. The MODIFIED requirement's text in turn declares "until the obs-cluster bridge slice lands" as its own transitional boundary; slice 18b will revise it again. The chain of transitional requirements is honest about how the arc moves but bears watching — future readers should follow the chain back to slice 15 to understand why three slices in a row touch the same requirement.

## Open Questions

1. **Exact image pin.** Proposed `otel/opentelemetry-collector-contrib:0.111.0` (matches compose). Bump to a newer minor would diverge from compose; defer the bump to a separate slice that updates both. Confirmed at task 3.1 time.
2. **Resource caps for the collector pod.** Proposed `requests: cpu=50m mem=128Mi`, `limits: cpu=500m mem=256Mi`. The compose collector has no explicit caps; the in-cluster collector needs them to be a polite cluster citizen. Sized conservatively against the agent's typical span volume; revisit if `kubectl top pod` reveals the limit is binding.
3. **`collector-rollout` recipe scope.** Two options: (a) `kubectl rollout restart deploy/collector -n social` (rolls the whole pod), (b) `kubectl annotate configmap/collector-config kubectl.kubernetes.io/restartedAt=$(date)` followed by a watch (kustomize-friendly). Lean (a) — simpler, mirrors the documented Kubernetes pattern. Resolved at task 4.4 time.
4. **Whether to ALSO include a stub `metrics` or `logs` pipeline in the in-cluster collector ConfigMap.** Lean NO — the agent does not emit either over OTLP (per the observability spec's `_EXPORTER=none` requirements), so adding the pipeline produces a no-op surface and rots until slices 20/21. Add only when there is a producer. Resolved at task 3.3 time.
5. **Should the in-cluster collector also receive on `:4317` (gRPC) even though the Java agent uses HTTP?** Lean YES — both ports are cheap to expose, and a future BE library or sidecar may prefer gRPC. Resolved at task 3.2 time.
