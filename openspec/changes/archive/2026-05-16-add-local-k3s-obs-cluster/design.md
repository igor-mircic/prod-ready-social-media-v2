## Context

After slices 14–16 (add-local-k3s-postgres / -backend / -frontend) the application stack runs inside a single Lima VM hosting a single-node k3s cluster ("app cluster"). The observability stack (prometheus, loki, tempo, grafana, alertmanager, otel-collector) still runs as docker-compose on the macOS host. Backends in k3s ship telemetry to `host.lima.internal:4318`, a transitional bridge that has no Hetzner analogue and is flagged as the open architectural question in `infra/k8s/overlays/hetzner/kustomization.yaml`.

The strategic decision settled in discovery (see proposal) is the **two-cluster pattern**: the production observability stack will run on a separate Hetzner box (separate k3s cluster), not co-located with the app cluster. The driving reason is fate-separation — the cluster being observed is the cluster most likely to break, and observability that dies with the workload it instruments is observability you can't trust during an outage. Co-locating obs in the same k3s as the app is an MVP shortcut; the project's "production-grade architectures over MVP shortcuts" stance pushes toward the two-cluster shape.

Managed observability (Grafana Cloud, Datadog, etc.) was explicitly rejected for this project: the stated learning intent is to operate observability infrastructure, not consume it.

This slice is the **local mirror** of that production target. It stands up a second Lima VM, installs k3s into it (reusing the existing shared provision script), and deploys the LGTM stack with no app data flowing in yet. Wiring data flow across the cluster boundary is a separate slice (currently planned as `add-k3s-app-collector`); cross-cluster authentication is the slice after that. This slice is intentionally pure-layout: the new VM stands up, the stack is healthy, grafana loads with no datasources configured. Validating the two-cluster shape is the entire deliverable.

The host docker-compose observability stack stays running throughout this slice. Both stacks coexist (the in-VM one empty, the host one continuing to receive app data) until a later slice retires compose. This is a deliberate "build the new house before tearing down the old one" sequencing — visibility into the app cluster is never lost.

## Goals / Non-Goals

**Goals:**

- Stand up a second Lima VM (`infra/lima/obs.yaml`) whose shape matches the eventual second Hetzner box (4 vCPU, 8 GiB RAM, 64 GiB disk, arm64, Ubuntu 24.04 LTS — same envelope as the app VM).
- Reuse `infra/provisioning/install-k3s.sh` unchanged. This slice is the second consumer of that script and validates its host-agnostic invariant.
- Establish the `infra/k8s-obs/` directory shape (`base/<component>/`, `overlays/{local,hetzner}/`) following the conventions slice 14 set for `infra/k8s/`.
- Deploy each LGTM component (prometheus, loki, tempo, grafana, alertmanager) inside the obs cluster via Kustomize `helmCharts:` directives, each chart pinned to an explicit version (no `latest`, no channel).
- Each component gets a dedicated PVC on the obs cluster's `local-path` provisioner. Sizes are learning-project scaled (5 Gi / 5 Gi / 5 Gi / 1 Gi / 1 Gi for prom / loki / tempo / grafana / alertmanager).
- Grafana stands up with no datasources configured. The UI loads, the login works, an empty datasource list is the expected end state for this slice.
- Add a non-colliding kubeconfig context for the obs cluster (proposed: `social-obs`). Operators can `kubectl --context social-obs get pods -A` without touching the app context.
- Add justfile recipes (`obs-up`, `obs-down`, `obs-status`, `obs-grafana`) mirroring the shape of the app-cluster recipes.
- Lock in the fate-separation invariant: the obs cluster receives NO app-cluster kubeconfig, NO inbound credential, and exposes NO Service intended for the app cluster to dial into the obs cluster's storage plane. (Inbound OTLP receivers and grafana UI are the only legitimate ingress paths, and neither lands in this slice.)
- Leave a clearly marked `infra/k8s-obs/overlays/hetzner/` placeholder naming what the eventual Hetzner-deploy slice will add (Secret strategy, ingress/TLS, storage sizing).

**Non-Goals:**

- Wiring any data flow from the app cluster into the obs cluster. No collector in the app cluster talks to the obs cluster yet. No backend OTLP target changes. No log shipper. No prometheus scrape. All deferred to the next slices.
- Retiring or modifying the host docker-compose observability stack. It keeps running unchanged.
- mTLS / cross-cluster auth. The obs cluster's OTLP receivers (when they land in the next slice) start with no auth; auth is its own slice.
- Datasource provisioning in grafana. Datasources land in the slice that pipes data across, not before.
- Prometheus Operator / kube-prometheus-stack. Deliberately rejected (Decision 3).
- Production-grade storage (object-store-backed loki / tempo, replicated prometheus, Thanos / Mimir / Cortex). Single-node single-PVC per component for the local cluster, same as the postgres slice.
- CI integration. The obs cluster is local-only; no CI job brings it up. A kustomize-build smoke check may be added later.
- Provisioning the second Hetzner box. Hetzner deploy is a separate slice; this slice's `overlays/hetzner/` is a placeholder.
- HA / replicas / failover. Single-node by design, same posture as the app cluster.

## Decisions

### Decision 1 — Two Lima VMs, two k3s clusters (not one VM with two namespaces)

The local mirror of "two Hetzner boxes" is "two Lima VMs." A namespace split inside a single cluster does not exercise the cross-cluster primitives that production needs: separate kubeconfig contexts, separate apiservers, separate PKI roots, OTLP across a real network boundary, no shared RBAC. The whole point of the two-cluster pattern is fate-separation, and a namespace split shares fate completely.

Considered and rejected:

- **One VM, two namespaces** (`app` + `observability`). Cheap, easy, useless as a fidelity check for the prod target. Catches none of the cross-cluster auth / network / discovery issues. Would silently teach the wrong shape.
- **One VM, two k3s clusters via different ports/sockets.** Hacky, fragile, and still shares kernel/disk/network — the fate-separation property only holds at the VM boundary.
- **One Lima VM with multi-cluster k3s** (server + agents). Multi-node ≠ multi-cluster. Same apiserver, same etcd.

The cost of the two-VM approach is real (operators commit ~8 GiB extra RAM to the obs VM when it is up). It is the cost of an honest local mirror. `just obs-down` lets operators stop the obs VM when not actively working on observability.

### Decision 2 — Reuse `infra/provisioning/install-k3s.sh` unchanged

The shared install script is the single source of truth for "what an installed k3s node looks like in this project" — both Lima VMs and (eventually) both Hetzner boxes will run identical k3s installs. This slice is the script's second consumer; if the script needs ANY change to support the obs cluster, that is a leak in its host-agnostic invariant and the script itself must be fixed, not branched.

Considered and rejected:

- **A second provision script** (e.g. `install-k3s-obs.sh`). Tempting if the obs cluster needs slightly different k3s flags. Rejected because the project's working assumption — and the spec invariant on the existing script — is that k3s installs identically everywhere; differences belong in the workloads, not the cluster bootstrap. If a future obs-specific need emerges, the existing script grows an environment-variable knob; it does not fork.
- **Branching install logic inside the script based on hostname or marker file.** Rejected for the same reason.

### Decision 3 — Plain helm charts via Kustomize `helmCharts:`, NOT kube-prometheus-stack

`kube-prometheus-stack` is the conventional "one chart, full LGTM-on-k8s" answer. It bundles Prometheus Operator, ~30 CRDs (ServiceMonitor, PodMonitor, PrometheusRule, AlertmanagerConfig, etc.), node-exporter as a DaemonSet, kube-state-metrics, default scrape configs for kubelet/cAdvisor/apiserver, default Alertmanager rules, default Grafana dashboards. It is fast to stand up. It is the right choice for a real ops team that wants minimum effort.

It is the wrong choice for this project's learning intent. The Operator hides the actual mechanics behind a CRD layer; learners using it never see the underlying Prometheus config, the actual scrape rules, the actual Alertmanager wiring, or the Grafana provisioning surface. The CRDs become the contract, and the underlying YAML becomes opaque.

This slice deploys each LGTM component as a SEPARATE helm chart pinned to an explicit version:

- `prometheus` — the community `prometheus` chart, not `kube-prometheus-stack`. Bare Prometheus server, no operator, scrape configs live in a ConfigMap we own.
- `loki` — the `loki` chart in single-binary monolithic mode (single-node, single-PVC). Not the SimpleScalable or Distributed deployment modes.
- `tempo` — the `tempo` chart in monolithic mode (same rationale).
- `grafana` — the `grafana` chart with no datasources, dashboards-via-sidecar disabled. Datasources land in slice 18.
- `alertmanager` — the `alertmanager` chart.

The cost is more YAML to own (five chart configs + scrape configs + alert rules + retention configs). The benefit is every byte of observability behavior is visible in the repo, which is exactly what the project exists to demonstrate.

A future slice may add the Operator if/when ServiceMonitor-style autodiscovery becomes operationally valuable; the migration cost is bounded because the Operator's CRDs are additive.

### Decision 4 — Per-component PVCs on `local-path`, no object storage

Each LGTM component gets one PVC, sized for short-window retention at learning-project scale:

| Component    | PVC size | Why                                                        |
| ------------ | -------- | ---------------------------------------------------------- |
| prometheus   | 5 Gi     | ~7 days at our cardinality with default 15s scrape         |
| loki         | 5 Gi     | ~7 days at observed log volume from the app cluster        |
| tempo        | 5 Gi     | ~3 days at observed span volume (traces are heavier)       |
| grafana      | 1 Gi     | dashboards, datasources, plugin cache only                 |
| alertmanager | 1 Gi     | silences, notification log, replica state                  |

Total: 17 Gi, well within the VM's 64 Gi envelope.

`local-path` provisioner ships with k3s and uses the VM's local disk directly. Object storage (S3, MinIO) would be the production-real answer for loki and tempo at scale, but adds two MinIO StatefulSets, two sets of credentials, and zero learning value for a single-node single-developer cluster. Object storage moves in when the cluster goes multi-node or retention windows grow beyond what local-path can hold — neither applies yet.

Considered and rejected for this slice: hostPath PVs (less portable than local-path), Longhorn / OpenEBS (multi-node storage, not needed), in-cluster MinIO (premature). Retention enforcement is handled by chart defaults; explicit retention configs are a sub-task in slice 18 once we know what we're keeping.

### Decision 5 — `social-obs` kubeconfig context, both contexts coexist in `~/.kube/config`

Lima's `copyToHost:` (or equivalent provision step) writes a kubeconfig with a context name we control. The app cluster's existing context (from slice 14) stays as-is; the new VM adds a `social-obs` context. Operators switch contexts explicitly (`kubectl config use-context social-obs`, or `kubectl --context social-obs ...`).

The naming convention is `social-<role>` so future clusters extend predictably (e.g. `social-staging`, `social-prod-app`, `social-prod-obs`). The existing app context — whatever it is named today — is honored unchanged; this slice does NOT rename it (renaming kubeconfig contexts is its own slice if ever needed).

The port that the obs VM's kube-apiserver lands on the host MUST NOT collide with the app VM's (Lima will refuse to start otherwise). Implementation will pick a non-default port for the obs VM (likely 6444; 6443 is the app VM's).

### Decision 6 — Push-only ingress invariant, locked in now

Even though no traffic crosses the cluster boundary in this slice, the cluster's network shape is set up to enforce push-only from the start:

- The obs cluster has NO kubeconfig, token, or credential for the app cluster. Operators may consult both clusters from the host, but the obs cluster itself cannot reach into the app cluster.
- The obs cluster's Services that the app cluster will eventually dial — the OTLP collector receiver (slice 18) and (only if needed) a Prometheus remote-write endpoint — are the ONLY ingress paths the obs cluster will expose toward the app cluster.
- The obs cluster's storage plane (prometheus TSDB, loki chunks, tempo blocks) is clusterIP-only; never exposed as LoadBalancer or NodePort, never reachable from the app cluster directly.

This rules out the "obs cluster scrapes app cluster's pods directly" pattern from the start. Pull-from-obs would require the obs cluster to hold an app-cluster kubeconfig, which inverts the auth direction and creates a fat blast radius. The push model (app cluster ships out via OTLP / remote_write) is the production-real choice and the only choice this layout supports.

### Decision 7 — Both stacks coexist during transition; docker-compose retirement is its own slice

The host docker-compose observability stack is NOT modified in this slice. While the obs cluster stands up empty, the compose stack keeps receiving and visualizing app-cluster telemetry exactly as it does today. The cutover happens in slice 18 (when the app collector starts shipping to the obs cluster instead of to the compose stack); compose retirement happens in slice 22 (after the obs cluster has demonstrably absorbed everything the compose stack was doing, including dashboards and alert rules).

This sequencing avoids the worst case where the obs cluster has a latent gap (missing dashboard, broken alert) that nobody notices because compose was already gone. Running both in parallel for two slices lets us A/B verify.

The cost is operators run both stacks during the transition (~2 Gi extra RAM for the compose stack, already running). Acceptable.

## Risks / Trade-offs

- **[Disk pressure on the obs VM during long-running dev]** → PVCs total 17 Gi against a 64 Gi VM disk; with k3s images + system overhead the steady-state headroom is ~35 Gi. Long-running grafana/loki accumulation could push this. Mitigation: chart-default retention is conservative; revisit if PVC usage > 50% on routine inspection. Operators can `just obs-down && limactl delete social-obs && just obs-up` to wipe state.
- **[Operator RAM cost when both VMs are up]** → 8 + 8 GiB committed to Lima VMs when both are running, on a typical 16-32 GiB developer machine. Mitigation: `just obs-down` when not actively working on observability. The slice is honest about this cost in README.
- **[helmCharts: more verbose than kube-prometheus-stack]** → 5 separate charts, 5 values files, scrape configs we own. More YAML, more upkeep. Trade-off explicitly accepted (Decision 3) — visibility over convenience.
- **[Lima port-forward collisions]** → both VMs need apiserver ports forwarded to the host; one of them gets the non-default port. Document the chosen port explicitly to avoid future "why doesn't kubectl work" confusion.
- **[Standing up an empty stack is hard to verify is "right"]** → no data flowing means most smoke checks (grafana shows panels, prometheus shows targets up) don't apply. Mitigation: verification focuses on what CAN be checked at this stage — every pod Ready, every PVC bound, grafana UI loads and the empty datasource list renders, alertmanager API responds, prometheus `/-/ready` returns 200. The "real" end-to-end check arrives in slice 18.
- **[Two compose+cluster stacks may diverge silently during the transition]** → dashboards added to compose-grafana but not to in-cluster grafana, alert rules edited in one place but not the other. Mitigation: the cutover slice (18) will explicitly mirror the compose configuration into the new grafana before flipping the data direction; this slice does not introduce divergence because the new grafana is empty.
- **[Reusing install-k3s.sh might mask a host-agnostic regression]** → if the script accidentally became Lima-specific in a previous slice, this slice surfaces that as a bug. Mitigation: this is a FEATURE, not a risk. The point is to validate the script's invariant. Any failure here means the script needs fixing.

## Future Slices in This Arc

This slice is the first of a planned 7-slice arc that moves observability from compose-on-host to a two-cluster-on-Hetzner production deployment. The arc is sequenced so each slice is independently revertable and the visibility-into-the-app-cluster property is never broken.

```
   slice 17  add-local-k3s-obs-cluster      ◀── THIS SLICE
              ├─ second Lima VM + k3s + empty LGTM stack
              └─ no data crosses the boundary

   slice 18  add-k3s-app-collector
              ├─ otel-collector Deployment in the APP cluster
              ├─ backend OTLP target flips from host.lima.internal to in-cluster Svc
              ├─ app collector exports OUT to obs cluster's OTLP receiver
              ├─ grafana in obs cluster gets datasources provisioned
              └─ at end of slice: app traces visible in obs-cluster grafana

   slice 19  add-cross-cluster-mtls
              ├─ self-signed CA, distributed via Secrets in both clusters
              ├─ app collector exporter: TLS cert + key + CA
              ├─ obs collector receiver: TLS client_ca enforcement
              └─ at end of slice: cross-cluster OTLP is mTLS only

   slice 20  add-k3s-pod-log-shipping
              ├─ DaemonSet in app cluster (otel-collector with filelog receiver)
              ├─ ships /var/log/pods/* via OTLP to obs cluster's collector → loki
              ├─ structured-log parsing for backend (JSON), nginx (combined), postgres
              └─ at end of slice: pod logs queryable in obs grafana

   slice 21  add-k3s-cluster-metrics
              ├─ kubelet + cAdvisor + node-exporter scrape (in app cluster)
              ├─ via otel-collector prometheus receiver, pushed OUT via OTLP
              ├─ default cluster dashboards in obs grafana
              └─ at end of slice: pod CPU/mem/network/disk visible

   slice 22  retire-compose-observability
              ├─ delete prometheus/grafana/loki/tempo/alertmanager/collector from
              │   docker-compose.yml (keep postgres-exporter — different story)
              ├─ migrate any compose-only dashboards/rules into obs cluster
              ├─ README + observability spec delta
              └─ at end of slice: obs lives only in the obs cluster

   slice 23  add-hetzner-deploy
              ├─ overlays/hetzner for app cluster (CAX21 box)
              ├─ overlays/hetzner-obs for obs cluster (smaller box; CPX11 or CAX11)
              ├─ Hetzner-specific Secret strategy (SOPS or Sealed Secrets)
              ├─ Ingress + TLS (cert-manager + Let's Encrypt) for grafana + app
              └─ at end of slice: real two-box prod deploy on Hetzner
```

Each slice may surface new open questions that get folded into the next slice's design — particularly slice 18 (datasource provisioning approach, prometheus remote_write vs OTLP metrics receiver), slice 19 (cert-manager in obs cluster vs static Secrets), and slice 23 (whether the obs box gets its own ingress/DNS or shares the app box's).

## Open Questions

1. **kubeconfig context name for the obs cluster.** Proposed: `social-obs`. Confirmed in implementation when the existing app cluster's context name is inspected (currently `lima-social` or similar; the obs context just needs to not collide). Resolved at task 1.3 time.

2. **Exact helm chart versions for each LGTM component.** Pinned to the latest stable at implementation time. The repo's existing slice convention is to record the resolved pin in the values file's header comment.

3. **Whether to enable grafana's anonymous-viewer mode by default in local overlay.** Convenience for dev iteration, but introduces a habit that does NOT survive to Hetzner (anon-viewer on a public-facing grafana is a leak). Lean toward NO — same auth posture in both overlays, login-required everywhere. Confirm at task 4.5.

4. **Storage class on the obs cluster — `local-path` (k3s default) vs an explicit named StorageClass.** Lean toward k3s default for symmetry with the app cluster's postgres PVC. Revisit only if a chart-default needs a different class.

5. **NodePort vs port-forward for grafana access from the host.** App cluster uses klipper-lb LoadBalancer for postgres. Grafana could go the same route. Trade-off: LoadBalancer feels heavier for a single dev workload, port-forward is more "explicit-when-needed." Lean toward port-forward via `just obs-grafana` (matches the "the obs stack is not always running" posture). Resolved at task 5.3 time.
