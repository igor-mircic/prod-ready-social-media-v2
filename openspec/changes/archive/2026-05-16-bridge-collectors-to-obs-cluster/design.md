## Context

After slice 18a (`add-k3s-app-collector`), the app cluster runs its own otel-collector Deployment, the backend ships OTLP to it in-cluster (`collector.social.svc.cluster.local:4318`), and the collector relays everything to the compose collector via `host.lima.internal:4317`. The obs cluster from slice 17 sits next to it on a second Lima VM with the LGTM stack healthy and empty — no datasources provisioned, no data flowing in, only the apiserver published to the host. The cross-cluster transport decision that the second VM was built to exercise has not been exercised yet.

This slice is the bridge. It closes the data-plane gap that slice 17 deliberately left open. The architectural shape of the bridge — collector tier vs direct-to-tempo, hard cutover vs dual-write, one datasource provisioned now vs four — is what this design pins down. Cross-cluster auth (mTLS) is the next slice's problem; this design only commits to the *shape*, with a stance that the shape composes cleanly with what slice 19 will add.

Stakeholders are the maintainer (single-person learning project) plus the production-grade-architectures stance the project's `feedback_prefer_realistic_architectures.md` memory codifies: when a scale-driven trapdoor exists, pick the production-real option even at toy scale.

## Goals / Non-Goals

**Goals:**
- End-to-end backend traces visible in obs grafana, going BE pod → app cluster collector → obs cluster collector → obs cluster tempo → obs grafana.
- Compose grafana keeps showing the same view it shows today — no operator-facing observability regression.
- The obs cluster's OTLP ingress is a collector tier (not tempo's chart-default Service), so slice 19's mTLS lands on a receiver dedicated to cross-cluster ingress and slices 20/21's log/metric pipelines extend a collector that already exists.
- Obs grafana has all four datasources provisioned (tempo, prom, loki, alertmanager) so subsequent slices add data, not data-source-configuration churn.
- Cross-cluster transport works via `host.lima.internal:14317` — the local mirror of "two boxes on a private network."

**Non-Goals:**
- mTLS / authn on the cross-cluster OTLP hop. Slice 19.
- Browser-side OTLP path change. Slice 18c.
- BE→obs log shipping. Slice 20 (DaemonSet + filelog receiver).
- App-cluster metrics ingestion into obs prometheus. Slice 21.
- Retirement of the compose path. Slice 22.
- Fix for the FE→BE W3C `traceparent` propagation gap (memorialized after slice 16). Separate frontend defect.
- Multi-replica collectors, HPA, PDB, NetworkPolicy. Same single-node single-replica posture as the rest of the arc.
- Hetzner-side production wiring. Stubs only; slice 23 (`add-hetzner-deploy`) is the slice that ships real Hetzner.

## Decisions

### Decision 1 — Obs cluster grows its own collector tier; app collector does NOT export directly to tempo

The app collector's `otlp/obs-cluster` exporter targets a new collector Deployment in the obs cluster, NOT tempo's chart-default OTLP receiver.

**Alternatives considered:**

- *Direct-to-tempo.* Tempo's chart already enables `receivers.otlp.protocols.{grpc,http}` (slice 17 set this up). Patching tempo's chart-created Service to LoadBalancer and pointing the app collector straight at it would work for *traces*. Fewer YAML files in this slice.
- *Collector tier in obs.* Adds a Deployment + Service + ConfigMap in `infra/k8s-obs/base/collector/`. The collector pipeline is OTLP receiver → batch → otlp/tempo exporter (in-cluster).

**Why collector tier:**
- Slice 19 (mTLS) terminates client certs on the obs cluster's OTLP receiver. Terminating mTLS on tempo's listener is awkward — tempo isn't a TLS terminator, the cert material lives in a chart values file that mostly cares about other things, and the configuration shape doesn't compose with slice 20's log path or slice 21's metric path. Terminating on a collector is the production-standard pattern; cert-manager + collector is documented and clean.
- Slice 20 (pod log shipping) is a filelog receiver → OTLP exporter → cross-cluster → loki. The cross-cluster receiver has to be a *collector* (loki has no OTLP receiver in the helm chart). Slice 20 either adds the collector tier or reuses one this slice already created. Doing it now means slice 20 appends one exporter (`loki`) to an existing ConfigMap.
- Slice 21 (cluster metrics) is the same shape — prometheus receiver (kubelet, cAdvisor, node-exporter scrapes from inside the app cluster) → OTLP exporter → obs collector → `prometheusremotewrite` exporter to obs prometheus. Same collector tier is the only sane landing zone.
- The collector tier is the production-real pattern: clients ship to a collector, collectors terminate the security envelope and fan out to storage backends. Direct-to-tempo is a learning-project shortcut whose cost compounds over slices 19/20/21.

**Cost of doing it now:** ~3 YAML files in `infra/k8s-obs/base/collector/` plus an entry in `infra/k8s-obs/base/kustomization.yaml`. Lifecycle recipes (`obs-collector-logs`, `obs-collector-rollout`) are two `just` lines.

### Decision 2 — Dual-write during the transition window, not hard cutover

The app collector's traces pipeline keeps the slice-18a `otlp/compose-relay` exporter AND adds a new `otlp/obs-cluster` exporter. The pipeline's `exporters:` list is `[otlp/compose-relay, otlp/obs-cluster]`.

**Alternatives considered:**

- *Hard cutover.* Replace `otlp/compose-relay` with `otlp/obs-cluster`. Single-exporter pipeline, conceptually cleaner.
- *Dual-write.* Both exporters. The collector fans out the same batch to both destinations.

**Why dual-write:**
- Slice 17's "build the new house before tearing down the old one" sequencing is explicit. Compose stays up until slice 22 (`retire-compose-observability`) demonstrates the obs cluster has absorbed everything. Dual-write is the mechanism that makes "demonstrates" tractable: open compose grafana and obs grafana side-by-side, generate traffic, confirm identical trace counts.
- After hard cutover, compose grafana goes dark for BE traces while the browser still ships *to* compose (browser path moves in 18c). Compose grafana would show only browser spans for the slice 18b→18c window — a confusing intermediate state that makes "is the obs side working?" much harder to answer.
- The OTel collector handles multi-exporter fan-out natively. Each exporter has independent retry / queue / failure state — a wedged obs collector does NOT block the compose path. The collector logs export errors per exporter, so visibility is per-destination.
- Cost: two lines of YAML in the app collector's ConfigMap (one new exporter block + one extra list entry under `service.pipelines.traces.exporters`).

**Concern:** dual-write doubles outbound trace volume from the app cluster, which on Hetzner production would be a non-trivial bandwidth cost. Not relevant locally; flagged on the Hetzner overlay's commented stub so slice 23 doesn't accidentally inherit dual-write into prod.

### Decision 3 — All four datasources provisioned in obs grafana now, even though only tempo has data

Obs grafana's chart values gain a `datasources:` block declaring Tempo, Prometheus, Loki, and Alertmanager as datasources, each pointing at its in-cluster Service.

**Alternatives considered:**

- *Tempo only.* Each slice end-to-end shippable; grafana shows what it has data for; slices 20 and 21 each append their own datasource provisioning when their data path lands.
- *All four upfront.* Pre-stage now; loki / prom / alertmanager render "no data" until 20 / 21 / future-alerting slice light them up.

**Why all four:**
- The in-cluster Services already exist (slices 17 stood up tempo, prometheus, loki, alertmanager — they all have ClusterIP Services from their helm charts). The datasource declarations point at known, stable in-cluster DNS names. There is no risk of pointing at a Service that doesn't exist.
- Each of slice 20, slice 21, and a future alerting slice would otherwise add one or two datasource entries to the same `datasources:` block. Three rounds of churn to the same file vs one round now.
- "No data" panels in grafana are a familiar operator experience — observability dashboards routinely have no-data sections before their data path is wired. The added cognitive cost is near-zero.
- Counter-argument (shippability): slice 18b being "end-to-end" already means *the trace path is end-to-end.* The other datasources are not part of this slice's end-to-end loop; they're infrastructure for future slices. This decision is a small concession to ergonomics over strict slice-shippability purity.

### Decision 4 — Host-side ports `:14317` / `:14318` for obs OTLP; `host.lima.internal` is the local mirror of "private network IP"

The obs Lima VM publishes the obs collector's LoadBalancer Service ports `4317` and `4318` on the macOS host as `:14317` and `:14318`. The app collector's `otlp/obs-cluster` exporter targets `host.lima.internal:14317`.

**Alternatives considered:**

- *Reuse `:4317` / `:4318`* — collision with compose collector's already-published ports. Hard no.
- *Use `:4347` / `:4348` or some other arbitrary offset.* Works but offers no pattern.
- *Use `:14317` / `:14318`* — offset by 10000, symmetric with the apiserver disambiguation slice 17 chose (app `:16443`, obs `:16444`).
- *Skip Lima portForwards entirely; use VM-to-VM networking via Lima `networks:`.* Lima supports a shared `lima` network where VMs reach each other by IP. Would remove the `host.lima.internal` hop. Rejected: the shared-network feature on macOS arm64 requires socket_vmnet privileged setup (`limactl sudoers`), which is operator setup we don't currently require; would also force a change to slice 14's postgres path for consistency.

**Why `:14317` / `:14318`:** the "+10000" pattern is already established (`:16443` / `:16444`); the operator only has to remember one rule for "the obs cluster's analogue of the app cluster's port X." `host.lima.internal` from inside the app VM resolves to the macOS gateway, where Lima's host-side port-forward layer routes back into the obs VM, where klipper-lb terminates the LoadBalancer Service. The hop is two-step (Lima out, Lima in), but the operator-visible address is one stable string.

**Hetzner analogue:** the obs box's tailscale or private-network IP. The Hetzner overlay stub flags this so slice 23 doesn't paper over the address-translation difference.

### Decision 5 — Obs collector's Service is `LoadBalancer` (klipper-lb), not `NodePort` or `ClusterIP` + external IP

The obs collector Service has `type: LoadBalancer`. klipper-lb (k3s default) assigns it the obs VM's primary IP, which Lima port-forwards to the host.

**Alternatives considered:**

- *ClusterIP* + manual NodePort iptables hack. Not consistent with anywhere else in the project.
- *NodePort.* Works, but requires the operator to choose a port in the `30000-32767` range and remember it; less ergonomic than klipper-lb assigning the VM IP and Lima port-forwarding by a stable host-side number.
- *LoadBalancer* (klipper-lb). Established pattern in slice 14's postgres path (`klipper-lb assigns it the VM's primary IP`). One-line Service type declaration.

**Why LoadBalancer:** matches the slice 14 / slice 15 / slice 16 precedent. Operators don't have to learn a new ingress mechanism.

**Caveat:** klipper-lb only exposes the Service on the VM's IP, NOT on macOS-host loopback directly — the host-side reach is via the Lima portForward layer. The `infra/lima/obs.yaml` portForwards entries (one per port) carry the bridge. This is the same shape slice 14 uses for postgres `:5432`.

### Decision 6 — Obs collector pipeline mirrors the app collector's shape; same processors, same image, same probes

The obs collector's ConfigMap declares: one `otlp` receiver (gRPC `:4317`, HTTP `:4318`, no CORS), `batch` + `transform/redact-path-ids` processors (OTTL statements verbatim from the app collector), `health_check` extension on `:13133`, one exporter `otlp/tempo` pointing at `tempo.observability.svc.cluster.local:4317` with `tls.insecure: true`, one `traces` pipeline.

**Why mirror the shape:**
- Redact-path-ids on the obs collector is defense-in-depth. Every hop applies the redaction so a future regression in the app collector doesn't leak high-cardinality path segments into tempo.
- Identical image pin (`otel/opentelemetry-collector-contrib:0.111.0`) — three users of the image, one version string to update.
- Identical probe shape — operators do not have to learn two probe conventions.
- The obs collector's resource limits.memory is `512Mi` (vs the app collector's `256Mi`) because the obs collector is the aggregation point: it receives from the app cluster *and* will eventually also receive from slice 20's log shipper and slice 21's metric pipeline. 2× headroom for the destination-side collector is a sensible starting envelope; slice 19 / 20 / 21 each get a chance to revisit.

**Receiver does not declare CORS.** The obs collector's receiver is intentionally not browser-reachable; only the app collector pod dials it. This is the same posture as the app collector's receiver (CORS-locked because only in-cluster BE pods dial it). The compose collector keeps its CORS allowlist (slice 16) because the browser still ships to it until 18c.

## Risks / Trade-offs

- **Risk: app collector dual-write doubles outbound trace volume from the app cluster** → not material locally (loopback inside a single laptop). The Hetzner overlay's commented stub explicitly notes that the production Hetzner deploy should NOT inherit dual-write; slice 22 (`retire-compose-observability`) collapses dual-write to single-exporter before any prod cutover. Memory-worthy enough to flag at archive time.

- **Risk: obs VM down at apply time** → the app collector logs `otlp/obs-cluster` export errors every batch interval until the obs VM comes up; the `otlp/compose-relay` path keeps working. Operators get noisy logs but no functional regression. The README subsection documents this; the dual-exporter design is what makes the degraded mode acceptable.

- **Risk: `host.lima.internal` resolves differently inside the obs VM than inside the app VM** → both VMs see it as the macOS host's gateway IP, but if the obs VM also tried to dial `host.lima.internal:14317` it would hit itself via the loopback round-trip (Lima would forward macOS `:14317` BACK into the obs VM). No one in this slice has the obs VM dialing `host.lima.internal:14317`, so this is a latent footgun, not a present one. Mitigation: the obs cluster's collector exporter targets in-cluster tempo (`tempo.observability.svc.cluster.local:4317`), NOT `host.lima.internal`, so the obs cluster never depends on its own host alias.

- **Risk: provisioned datasources break grafana when their target Service hasn't fully come up yet** → grafana's chart provisions datasources at startup; if loki/prom/AM haven't reached Ready when grafana starts, the datasource provisioning still succeeds (it's just YAML files on disk) but the connection-test in the grafana UI will fail until the upstream Service is healthy. The "no data" rendering is the same regardless. Mitigation: the four datasources stay declared with `editable: false` and no explicit `isDefault: true` collisions; if a datasource is broken the operator sees a clear error in `Configuration → Data sources`, not a silent grafana crash.

- **Trade-off: spec churn on `observability-cluster`** → slice 17 introduced "Grafana stands up with no datasources configured." This slice MODIFIES that requirement to "Grafana provisions four datasources..." and updates the related scenario. The slice-17 *intent* (stand up empty) is preserved as a slice-17 historical fact; the spec is updated to reflect that 18b is the slice that flips it. Spec churn is one MODIFIED block, not a REMOVED + ADDED pair, because the underlying requirement (what grafana's datasource state is) is the same shape — just a different value.

- **Trade-off: app collector's `kubernetes`-spec requirement now describes a multi-exporter pipeline** → the slice-18a requirement enumerated `[otlp/compose-relay]`. This slice MODIFIES it to `[otlp/compose-relay, otlp/obs-cluster]`. Slice 22 will further MODIFY it to drop `otlp/compose-relay`. Acknowledged churn over three slices on the same `exporters:` list — but the alternative (a "list-of-exporters" requirement that is vague about which exporters) would lose specificity that the spec deltas catch.

## Migration Plan

This slice has no data migration (no schema, no persistent data shape change). Deploy is "apply the new manifests; observe both grafanas show the same data." Rollback is `git revert` plus `kubectl apply` of the prior state on both clusters.

Operator-visible cutover checklist (also encoded in `tasks.md` verification steps):
1. Pull the branch; both VMs already up (or `just up && just obs-up`).
2. `just backend-apply` — picks up the new app collector ConfigMap (rollout-restart on the collector Deployment is part of the apply).
3. `kustomize build --enable-helm infra/k8s-obs/overlays/local | kubectl --context social-obs apply -f -` — applies the new obs collector and the four grafana datasources.
4. Generate traffic against the app (e.g. open the frontend, post something).
5. Open compose grafana → Tempo → recent traces. Trace appears with `service.name=backend`.
6. `just obs-grafana` → log in → Explore → Tempo datasource → recent traces. SAME traces appear.
7. (Negative check) `kubectl -n observability logs deploy/collector --context social-obs --tail=200` shows non-zero accepted-span counts and no export errors.

If step 5 succeeds but step 6 does not:
- Check `kubectl -n social logs deploy/collector --context lima-social` for `otlp/obs-cluster` exporter errors.
- Common failure: the obs VM's portForwards aren't reloaded — `limactl stop social-obs && just obs-up` (Lima only re-reads portForwards on VM start).
- Common failure: klipper-lb hasn't assigned the LoadBalancer IP — `kubectl --context social-obs -n observability get svc collector -o wide` and confirm `EXTERNAL-IP` is the VM IP, not `<pending>`.

If immediate rollback is needed without a full git revert:
- One-line edit to `infra/k8s/base/collector/configmap.yaml`: remove `otlp/obs-cluster` from `service.pipelines.traces.exporters`.
- `just collector-rollout` — restores the slice-18a single-exporter state in the app cluster.
- Obs-side resources can stay deployed; they idle harmlessly.

## Open Questions

1. **Should the app collector use `loadbalancing` exporter or two parallel `otlp` exporters for fan-out?** The `loadbalancing` exporter is for trace-aware fan-out (it pins all spans of a trace to the same downstream collector, important when downstream collectors do tail-sampling). For dual-write to two *different* destinations, two parallel `otlp` exporters is the correct shape. Resolved here; flagged in case a future slice introduces tail-sampling.

2. **Does grafana's `datasources:` block survive a chart upgrade?** The grafana chart's `datasources:` is rendered into a Secret/ConfigMap that grafana reads on startup. Chart upgrades preserve it. Confirmed via reading the chart's `_helpers.tpl`. No action required.

3. **Should the obs collector also declare a `prometheusremotewrite` exporter stub now, even unused?** Tempting (slice 21 would just flip a switch). Rejected: declaring an exporter the pipeline doesn't reference is dead config; OTTL parser is fine with it but a reader is left wondering. Slice 21 adds it cleanly.

4. **Does the obs grafana datasource for Tempo need the service-graph configuration enabled?** Slice 16's frontend tracing spec has a requirement "Tempo datasource provisioning enables the service graph" for the compose-side tempo. For the obs-cluster tempo we leave service-graph enabled by default (matches the compose-side stance). Resolved by mirroring; if the obs tempo chart doesn't render service-graph data correctly, slice 20/21 will surface it.
