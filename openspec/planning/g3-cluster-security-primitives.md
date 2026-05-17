# G3 — Cluster security primitives

**Status:** planning · 3-slice arc
**Promotes to:** `openspec/changes/add-pod-security-admission/` for the first slice; later slices each get their own change directory.

## Why

The local clusters today are wide open. Pods run as root by default, can mount hostPath without push-back, can talk to any other pod in any namespace, can dial out anywhere. That's fine for slice-1-to-22 velocity, but every production cluster on every realistic deploy target enforces some subset of:

- **Pod Security Standards** (`baseline` or `restricted`) — declarative gate on what a pod's spec can declare (runAsNonRoot, no hostPath, no hostNetwork, capabilities dropped, seccomp `RuntimeDefault`).
- **NetworkPolicy** — deny-by-default ingress + per-pod egress allowlists. Means "the FE pod can hit BE on :8080, nothing else."
- **A CNI that actually enforces NetworkPolicy** — k3s ships flannel, which does *not* enforce NetworkPolicy. Adding NetworkPolicy resources on flannel is a silent no-op. Real enforcement requires Calico, Cilium, or k3s's bundled-but-opt-in `--flannel-backend=none` + bring-your-own.

This group exercises the production stance locally — same shape that will deploy on Hetzner (whenever that lands), no shortcuts that have to be rewritten.

## Slices in this group

```
G3.1  add-pod-security-admission       declarative, ships baseline → restricted
G3.2  swap-flannel-for-networkpolicy-cni   spike + CNI swap
G3.3  add-network-policies             deny-by-default + per-workload allowlists
```

G3.1 is independent. G3.3 requires G3.2 (otherwise the rules silently no-op).

## Slice sketches

### G3.1 — `add-pod-security-admission`

- Add `pod-security.kubernetes.io/enforce: <level>` labels per namespace:
  - `social` (app workloads): start at `baseline`, target `restricted` once any failures are fixed.
  - `observability` (LGTM pods): likely `baseline` only — Loki / Tempo / Prometheus / Grafana chart defaults often violate `restricted` (privileged init containers, root user, etc.). Document the deviation.
  - `kube-system`: leave alone (k3s system pods need privileged escape hatches).
- Each label flip is a separate verification step: `kubectl apply -k overlays/local` will *fail* on the first violating pod. Iterate: fix or downgrade per namespace.
- Likely fixes: explicit `runAsNonRoot: true`, `runAsUser: <uid>`, drop all capabilities, seccompProfile: `RuntimeDefault`, no hostPath where unnecessary.
- **The DaemonSets are the hard part** — log-agent (slice 20) and metrics-agent (slice 21) both mount hostPath (`/var/log/pods`, `/var/lib/kubelet`); they will fail `restricted` and need a per-namespace exception or a relaxed posture. Recommendation: put log-agent + metrics-agent in their own namespace (`observability-agents`) labeled `baseline`, leave the rest of `social` at `restricted`.
- e2e: a deny case — `kubectl run` a privileged pod into `social`, observe rejection.

### G3.2 — `swap-flannel-for-networkpolicy-cni`

- **Spike first**: Calico vs Cilium vs k3s's bundled `flannel-backend=none + canal`. Decision criteria:
  - Footprint (RAM per node — Cilium is heavier).
  - eBPF maturity (Cilium leans heavily on eBPF; Calico has both modes).
  - Operator experience needed for routine ops (Calico is simpler day-to-day).
  - Existing project intent: the README repeatedly invokes "production-grade locally" — argues for whatever real clusters actually run. **Calico is the conservative pick.**
- Concrete swap:
  - Re-provision k3s with `--flannel-backend=none --disable-network-policy --disable=traefik` (Traefik untouched if G4 hasn't picked between Traefik and ingress-nginx).
  - Install Calico via its own manifest or operator.
  - Verify CNI handover: pods get IPs, cross-pod traffic works, NetworkPolicy *enforces* (smoke test: apply a deny-all, confirm a pod-to-pod ping breaks).
- Re-provision is destructive on the cluster (pods evict + reschedule). Lima VM stays; k3s install reinitialises.
- **Open question**: does G3.2 happen on the app cluster only, or both clusters? The obs cluster has fewer pods and less benefit from NetworkPolicy. Recommendation: both, for parity; obs cluster's policy set in G3.3 is a near-empty default-deny.

### G3.3 — `add-network-policies`

- **Default-deny** NetworkPolicy in `social` namespace: deny all ingress, deny all egress.
- Then add explicit allowlists, one per workload pair:
  - FE → BE: `ports: [{port: 8080, protocol: TCP}]`, podSelector matched on backend label.
  - BE → postgres: `ports: [{port: 5432, protocol: TCP}]`.
  - BE → app collector: `ports: [{port: 4318, protocol: TCP}]` for OTLP/HTTP.
  - App collector → obs box: egress to `host.lima.internal:14317/14318` (host-network egress — requires `ipBlock` since DNS doesn't resolve in NetworkPolicy).
  - All pods → DNS: egress to `kube-system/coredns` on 53/UDP+TCP.
  - All pods → kubelet (DaemonSets only): egress to the node IP on kubelet ports.
- e2e: assert a denied path stays denied (FE pod tries to dial postgres directly; rejected).
- Obs cluster: default-deny + explicit allow for cross-cluster OTLP ingress from `host.lima.internal` (the app cluster's outbound NAT'd source) on 14317/14318.

## Non-goals

- No service mesh (Istio / Linkerd). Out of scope; the slice-19 mTLS posture already covers the one cross-cluster trust boundary the project cares about. A mesh adds 30+ CRDs for a single-cluster intra-traffic benefit — out of scope until any workload needs mTLS *inside* a cluster.
- No `SecurityContextConstraints` (OpenShift-only).
- No image-signing / Sigstore. Worth its own slice if `add-image-signing` becomes a priority; not part of G3.
- No runtime-security (Falco). Same — its own slice if needed.

## Sequencing

```
G3.1 ──→ (independent; can land any time)

G3.2 ─→ G3.3   (G3.3 silently no-ops without G3.2)
```

G3.1 should probably land before G3.2/G3.3 — fixing PSS violations exposes the pod spec issues, which is good groundwork before tightening network.

## Risk

- **G3.2 is the disruptive one**: CNI swap re-provisions k3s, evicts every pod, exercises the "what's actually idempotent in `just up`" question for real. Land it on a quiet day.
- **G3.3 can cause silent breakage if G3.2 isn't done first** — NetworkPolicy rules apply without complaint on flannel and do nothing. Verification step: `kubectl get networkpolicies` shows rules; a smoke test confirms enforcement.
- **G3.1 will surface unexpected violators** — k3s system pods, chart-managed pods (grafana, prometheus operators, the LGTM stack) often need a permissive namespace. Plan to land per-namespace, not cluster-wide.

## Size estimate

- G3.1: 1–2 evenings (the namespace-by-namespace fix-or-relax iteration is the unknown).
- G3.2: 2–3 evenings (CNI swap + spike + re-provision verification).
- G3.3: 2 evenings.

Total: 1–2 weeks of evenings.
