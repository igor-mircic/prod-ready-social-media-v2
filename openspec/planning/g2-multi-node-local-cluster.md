# G2 — Multi-node local cluster

**Status:** planning · 4-slice arc
**Promotes to:** `openspec/changes/add-multi-node-local-cluster/` for the first slice; later slices each get their own change directory.

## Why

Every cluster the project runs today is single-node. That's a quiet lie:

- `tolerations: {operator: Exists}` boilerplate carries the suggestion of "DaemonSet on every node" but the DaemonSet has only ever scheduled on one node.
- `replicas: 1` for the metrics-cluster-agent (slice 21) is fine on a one-node cluster but leaves a metrics gap on pod restart in any real cluster. The slice-21 design and Hetzner stub both flag this as a "leader election" follow-up — but leader election makes no sense to wire on a one-node cluster.
- PodDisruptionBudgets would all be no-ops; `topologySpreadConstraints` would all be vacuously satisfied; `podAntiAffinity` rules would never trigger.
- NetworkPolicy enforcement (G3) is impossible to meaningfully test pod-to-pod across nodes without two nodes.

Going multi-node *locally* turns these primitives into things you can break and observe. It's the highest-leverage learning move available without bringing in a cloud bill.

## Slices in this group

```
G2.1  add-multi-node-local-cluster          ← foundation
G2.2  add-poddisruptionbudgets              gains teeth from G2.1
G2.3  add-collector-leader-election         closes slice-21 prod TODO
G2.4  add-anti-affinity-and-topology-spread spreads BE/FE/collector across nodes
```

G2.1 must land first. G2.2–G2.4 are independent of each other and can interleave with other groups.

## Slice sketches

### G2.1 — `add-multi-node-local-cluster`

- Add a second Lima VM `lima-social-w1` configured as a k3s **agent** joining the existing `lima-social` server's apiserver. Token + URL passed via cloud-init from the host (or `limactl shell` post-boot).
- `infra/lima/lima-w1.yaml` (or extend `lima.yaml` with a worker variant). Smaller envelope than the server: 4 vCPU / 4 GiB / 32 GiB disk. Memory accounting: total commit goes from 16 → 20 GiB; flag in the cost-of-VM-shape README section.
- `just up` extends to bring up both VMs in order (server first, then agent waits for server's join token to appear).
- `just status` shows both nodes Ready; verify a re-applied `kubectl get pods -o wide` spreads pods across nodes once Deployments grow replicas (a later slice).
- Address-family questions: agent reaches server via `host.lima.internal:6443`? Or via the lima socket-forward shim? **Open question** — needs a spike during the slice.
- Tolerations / taints: leave the server node *untainted* for the local mirror (k3s default is no control-plane taint anyway). The Hetzner overlay would taint and use a `NoSchedule` posture; document that drift explicitly.

**Open questions for G2.1:**
- Single agent or two? One worker is enough to make scheduling concerns real. Two would let topology-spread distribute across two non-server nodes, but pushes RAM to 24 GiB — out of comfortable envelope on a 16 GiB laptop.
- Should the obs cluster also go multi-node, or stay single-node? The obs cluster's workloads (LGTM) are mostly singletons; multi-node there is less interesting. Recommendation: app cluster only.

### G2.2 — `add-poddisruptionbudgets`

- PDBs for: backend (`minAvailable: 1`), frontend (`minAvailable: 1`), app collector (`minAvailable: 1`), obs collector, postgres-exporter, log-agent (DaemonSet — uses `maxUnavailable: 1`), metrics-agent (DaemonSet).
- Postgres PDB is the interesting case: with `replicas: 1` the PDB blocks node drains entirely. Document that and accept it locally; flag it as a CNPG prerequisite (G5.2 — CNPG would carry HA naturally).
- Verify by draining `lima-social-w1` (`kubectl drain --ignore-daemonsets --delete-emptydir-data lima-social-w1`); PDBs visibly gate the drain.

### G2.3 — `add-collector-leader-election`

- Wire the `k8s_leader_elector` extension on `infra/k8s/base/collector/configmap.yaml` for the metrics-cluster-agent receiver path (the singleton Deployment from slice 21).
- Bump that Deployment to `replicas: 2`.
- Under normal operation only the leader's `k8s_cluster` receiver emits; standby takes over on leader-pod failure. The extension is bundled in `otel/opentelemetry-collector-contrib:0.111.0` (already pinned), so configmap-only change.
- Verify by `kubectl delete pod -l app=metrics-cluster-agent` (the leader); standby resumes emission within the lease re-acquire window (~15s default).
- Closes the slice-21 Hetzner-overlay TODO on leader election. Bonus: doubles as a real test of G2.2's PDB.

### G2.4 — `add-anti-affinity-and-topology-spread`

- Backend / frontend / app collector get `topologySpreadConstraints` keyed on `topology.kubernetes.io/hostname` with `maxSkew: 1`, `whenUnsatisfiable: DoNotSchedule`.
- Once any of these has `replicas: 2+`, pods land on distinct nodes.
- Verify by bumping backend replicas to 2 temporarily, observing scheduler decisions.
- Anti-affinity for stateful pods (postgres if still chart-managed): `requiredDuringSchedulingIgnoredDuringExecution` keyed on the chart's labels.

## Non-goals

- No HPA (autoscaling). Replica counts stay manual; HPA is its own slice triggered by a real load-shape question.
- No second obs-cluster node. Single-node obs cluster stands.
- No cluster-autoscaler. Adding/removing Lima VMs stays manual.
- No node taints / tolerations beyond what k3s ships with.

## Sequencing

```
G2.1 ─┬─→ G2.2 (any time after)
      ├─→ G2.3 (any time after)
      └─→ G2.4 (any time after)
```

G2.2, G2.3, G2.4 can land in any order, on any cadence, and can interleave with G1, G3, G4, G5 slices.

## Risk

- **Resource envelope**: total Lima commit climbs 16 → 20 GiB. Tight on a 16 GiB laptop. Flag in the README's cost-of-VM-shape section; document `just down-w1` as the "stop just the worker" escape.
- **k3s agent join flakiness**: first-boot join requires the server's join token to exist; race possible on cold `just up`. Mitigation: `just up` polls the token before booting the agent VM.
- **State migration**: existing pods on `lima-social` (the now-server-only node, if we taint it) need to evict and reschedule. Easier path locally: leave the server untainted so existing workloads stay put; new replicas spread.

## Size estimate

- G2.1: 1–2 evenings (the spike on join mechanics is the unknown).
- G2.2: 1 evening.
- G2.3: 1 evening.
- G2.4: 1 evening.

Total: ~1 week of evenings if pursued back-to-back.
