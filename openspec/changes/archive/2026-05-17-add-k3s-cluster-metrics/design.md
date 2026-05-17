## Context

This is slice 21 of the seven-slice "compose-to-k3s observability" arc named in README §"Forward arc" (line 442 onward). It is the third and final signal-type slice of the arc:

- **Slice 18b** built the cross-cluster trace path: app-cluster gateway dual-writes traces to compose-relay AND obs-cluster collector.
- **Slice 18c** extended dual-write to logs (FE error logs) and metrics (FE web vitals). The gateway's metrics pipeline already fans out to compose-relay + obs-cluster.
- **Slice 19** wrapped the cross-cluster legs in mTLS.
- **Slice 20** added the second log source: a node-local DaemonSet (`log-agent`) reads `/var/log/pods/social_*` and ships to the gateway. The gateway's logs pipeline carries that load through the slice-19 mTLS envelope to obs Loki. The slice-20 design.md Decision 1 establishes the *agent/gateway* pattern: scrape locally, ship plaintext OTLP/gRPC to a per-cluster gateway, the gateway is the only thing that knows about the obs cluster.
- **Slice 21** (this slice) adds the cluster-metric producers: a `metrics-agent` DaemonSet (kubeletstats + hostmetrics for per-node and per-pod resource metrics) and a `metrics-cluster-agent` Deployment (k8s_cluster for cluster-state metrics). Both ship to the existing gateway, which already dual-writes metrics under the slice-19 mTLS envelope to obs prometheus.

**Constraints inherited from earlier slices:**
- **Image pin**: every collector pod runs `otel/opentelemetry-collector-contrib:0.111.0` (slice 17 baseline; one bump moves all four pods — gateway, log-agent, metrics-agent, metrics-cluster-agent, obs collector).
- **No Prometheus Operator / kube-prometheus-stack** (README design constraint at lines 432-435). Each LGTM chart is deployed bare; CRD-based stacks are out of scope.
- **Local-only**: this slice never runs on Hetzner. The Hetzner overlay gets a commented stub alongside the existing slices' stubs.
- **Single k3s node locally**: the DaemonSet is one pod. Tolerations must include the control-plane taint (mirrors slice 20 Decision 8).
- **8 GiB Lima VM envelope**: budget ~512 MiB total for the two new pods (256Mi each, matches the slice-20 log-agent envelope).

**Constraints from the OTel-native commitment:**
- The slice's three producers map to three OTel contrib receivers that, between them, cover the same ground as the three Helm subcharts the prometheus chart bundles:
  - `kubeletstats` ⟷ what kubelet's `/metrics/cadvisor` scrape would deliver (pod / container CPU, memory, network, filesystem).
  - `hostmetrics` ⟷ what `prometheus-node-exporter` would deliver (node-level CPU, memory, disk, network, load, paging).
  - `k8s_cluster` ⟷ what `kube-state-metrics` would deliver (deployment desired/available, pod phase, restart counters, PVC phase, etc.).
- Going OTel-native means *no scrape jobs land in the obs prometheus chart*. The chart stays in its slice-17 posture: subcharts disabled, every default scrape job's `enabled: false`. Data flows in via the existing slice-18c remote-write endpoint. The values.yaml comment block that names slice 21 as the home for those scrape configs is misleading and gets rewritten as part of this slice.

**Stakeholder reading this design:** the person implementing this slice (the next /apply session) and any future operator looking at the agent/gateway shape who needs to know *why* there are two metrics-side agents instead of one combined pipeline on the existing log-agent.

## Goals / Non-Goals

**Goals:**

1. Node-level metrics (CPU, memory, disk, load, network) for every k3s node land in obs prometheus, queryable via Explore on obs grafana under OTel-naming-translated families (e.g. `system_cpu_utilization`, `system_memory_usage`).
2. Pod-level and container-level metrics for every pod in every namespace land in obs prometheus, queryable under k8s-shaped families (e.g. `k8s_pod_cpu_utilization`, `container_memory_working_set`) with `k8s_namespace_name`, `k8s_pod_name`, `k8s_container_name` labels.
3. Cluster-state metrics (deployment desired/available, pod phase, restart counters, PVC phase) land in obs prometheus, queryable under `k8s_deployment_*`, `k8s_pod_*`, `k8s_pvc_*` families.
4. A `cluster-overview` dashboard provisioned automatically in obs grafana renders the above into operator-readable panels, paralleling (but NOT replacing) the existing compose `infrastructure-overview` dashboard's role for the Docker-cAdvisor families.
5. The agent/gateway pattern slice 20 established carries forward unchanged: scrape on the agent, ship plaintext to the gateway, the gateway dual-writes under slice-19 mTLS.
6. The compose `infrastructure-overview` dashboard and the Docker-cAdvisor metric path continue to work unchanged in compose grafana — the slice does not touch them and they will retire with slice 22 alongside the rest of compose observability.

**Non-Goals:**

- A Prometheus Operator install. (README constraint; CRD-based stacks out of scope.)
- Scrape jobs in the obs prometheus chart. (OTel-native commitment; everything arrives via remote-write.)
- Control-plane metrics: kube-scheduler, kube-controller-manager, etcd. k3s embeds them in the supervisor process; exposing them requires `--kube-scheduler-arg=metrics-bind-address=...` server flags. Out of scope here. (Could land in a future slice once the obs side has dashboards that would use them.)
- Application metrics from the social workloads. Backend (slice 6) already pushes Spring `/actuator/prometheus` via OTLP through the gateway; frontend (slice 6 + 18c) already pushes web vitals via OTLP through the gateway. Neither needs the new agents.
- Alerting rules on cluster metrics. A future alerting slice (post-slice-22) decides which thresholds page.
- Cardinality engineering, metric filtering, or retention tuning. The chart defaults (5Gi PVC, 7d retention) stand for this slice; future slices revisit when real volume is in.
- Leader election for the `k8s_cluster` receiver. Single-replica Deployment on a single-node local cluster has no duplicate-data problem. The Hetzner overlay stub flags the multi-node concern.
- A compose-side `cluster-overview` dashboard. Compose dies in slice 22. Operators verifying side-by-side comparability during the slice-21 → slice-22 window run ad-hoc PromQL in compose grafana's Explore tab.
- Scope widening beyond the app cluster. The obs cluster has its own metric-emitting workloads (prometheus-server, loki, tempo, grafana); shipping THEIR metrics is the kind of cross-cluster wiring slice 23 can decide on once the obs cluster has a stable identity.
- A direct agent → obs cluster path. Reuses slice 20 Decision 2: single security envelope at the gateway, single redaction pass.
- Operator-grade configuration knobs. Hard-coded ConfigMaps; a future slice can lift them.

## Decisions

### Decision 1 — Two pods (DaemonSet + Deployment), not one combined agent

The metrics-side receivers split cleanly along a scoping axis:

- `kubeletstats` and `hostmetrics` are *per-node*. Each kubelet only exposes its own node's stats; each `/proc` only describes its own node. A Deployment with `replicas: 1` would see exactly one node and miss the rest on any multi-node cluster.
- `k8s_cluster` is *per-cluster*. Multiple replicas would duplicate every cluster-state metric (`k8s_deployment_available` reported N times from N replicas) and either explode cardinality or trip the prometheus duplicate-sample rejection.

These are inherently different workload kinds. A combined pipeline in one pod could only run on one node (the DaemonSet's per-node guarantee would be violated if we picked the Deployment shape; the k8s_cluster scope would be violated if we picked the DaemonSet shape). Two pods is the documented OTel idiom.

**Alternatives considered:**
- *One DaemonSet, one pipeline per signal source, gate k8s_cluster on a leader-election extension.* Rejected: introduces `k8s_leader_elector` extension complexity for zero gain at single-node-local scale. Hetzner slice can revisit.
- *Add a metrics pipeline to the slice-20 `log-agent` DaemonSet.* Tempting (single pod = lower overhead), but slice-20's own configmap (`infra/k8s/base/log-agent/configmap.yaml` lines 217-219) explicitly handed slice 21 the split-it-out option: *"Slice 21 will add a separate agent (or a sibling pipeline) for cluster metrics; mixing them here would tangle the signal scopes."* Honoring that handoff keeps each agent's failure domain independent — a logs regression at the log-agent does not blind the cluster-metrics dashboard, and vice-versa. The shared-pod variant remains a future consolidation if pod density ever becomes a real concern.

### Decision 2 — OTel receivers (kubeletstats + hostmetrics + k8s_cluster), not prometheus scrape jobs

The README forward-arc entry says "scrape via the app collector" (line 459). The agent/gateway pattern slice 20 established says: producers live in the app cluster, ship plaintext OTLP to the gateway, the gateway is the only thing that crosses to obs. Producing cluster metrics via prometheus scrape on the obs side would mean the obs prometheus pulling cross-cluster from the app cluster's kubelet — which inverts the data flow, demands new ingress on the app cluster (kubelet port `10250` exposed), and requires a second auth model (prometheus → app-cluster kubelet) separate from the slice-19 mTLS envelope.

OTel receivers on the app cluster side keep:
- One direction of cross-cluster flow (app → obs, always).
- One security envelope (slice-19 mTLS at the gateway).
- One image pin (`otel/opentelemetry-collector-contrib:0.111.0`) shared across all collector pods.

The cost is a metric-family rename: OTel emits `k8s.pod.cpu.usage`, not `container_cpu_usage_seconds_total`. The prometheusremotewrite exporter handles the dotted-to-underscored translation (`k8s.pod.cpu.usage` → `k8s_pod_cpu_usage` in prometheus), but the PromQL in the new dashboard has to be written against the OTel names, not the cAdvisor names the compose `infrastructure-overview.json` uses. Acceptable: the compose dashboard renders Docker-cAdvisor metrics that won't exist in the k3s prom anyway, and the new dashboard is a fresh JSON, so there's no migration cost.

**Alternatives considered:**
- *Enable the prometheus chart's bundled `kubernetes-nodes-cadvisor`, `kubernetes-api-servers`, `kubernetes-service-endpoints` scrape jobs.* Rejected: inverts cross-cluster flow (obs prom pulling from app kubelet), demands new ingress on app cluster, and breaks the agent/gateway pattern slice 20 just stood up.
- *Run prometheus-node-exporter / kube-state-metrics as Helm subcharts of the obs prometheus chart.* Rejected: those subcharts would run *in the obs cluster*, which has no app-cluster nodes to describe. Even if we ran them in the app cluster instead (separate manifest, not chart subcharts), we'd then need a way to scrape them and we're back to "obs prom pulls from app cluster" — same downside.
- *Use the OTel `prometheus` receiver to scrape the bundled exporters' `/metrics`.* Worse than direct OTel receivers: introduces an intermediate exporter format with its own per-metric quirks, doubles the family count (cAdvisor names AND OTel names), and adds a second config surface (scrape jobs in the receiver YAML).

### Decision 3 — Obs prometheus chart values.yaml gets a comment-block rewrite, no runtime config change

The slice-17 prometheus chart (`infra/k8s-obs/base/prometheus/values.yaml`) was provisioned with every subchart and every default scrape job disabled, with TODO comments naming slice 21 as the home for the scrape configs. Now that we know the answer (OTel-receiver-side, not chart-side), the runtime configuration is *already correct*: subcharts disabled (Decision 2 rationale), scrape jobs disabled (same), remote-write receiver enabled (slice 18c). The only file change is the comment block at lines 6, 10-11, 59-60, 77-80 — rewrite to drop the misleading "scrape configs land in slice 21" hints and instead point at the new agents as the data source.

**Alternatives considered:**
- *Don't touch the file at all.* Rejected: the misleading comments become harder to retract over time. A future reader looking at "the prometheus chart says slice 21 enables kube-state-metrics" would have to read four other files to discover that slice 21 chose the OTel-receiver-side path instead.
- *Move the scrape-configs comment block to a dedicated `OBS_PROMETHEUS_NOTES.md` file.* Rejected: the file would be a one-off documentation surface that no other slice writes to. The values.yaml's own comments are the right home for "why are these settings what they are" notes.

### Decision 4 — kubeletstats targets `${NODE_NAME}:10250`, with TLS-skip-verify

The agent talks to the kubelet of *its own node*. `${NODE_NAME}` comes from the downward API (`spec.nodeName`), injected into the container's env. The kubelet listens on `10250` (HTTPS, k3s self-signed cert) and authenticates the caller via the mounted ServiceAccount token (the kubeletstats receiver presents the token automatically when `auth_type: serviceAccount`).

`insecure_skip_verify: true` is acceptable here because:
- The connection is from a pod on node N to the kubelet of node N — never cross-node.
- The k3s kubelet's cert is self-signed and rotates on every k3s restart; pinning a CA would require a chicken-and-egg distribution step.
- The auth check is via SA token, not cert mTLS — the TLS is encryption-in-transit, not authentication.

**Alternatives considered:**
- *`hostNetwork: true` on the DaemonSet, target `127.0.0.1:10250`.* Workable, but hostNetwork pods bypass the CNI and complicate any future NetworkPolicy. The env-var indirection is the documented OTel idiom.
- *Pin the k3s kubelet's CA via a hostPath mount of `/var/lib/rancher/k3s/server/tls/server-ca.crt`.* Too coupled to k3s internals; breaks if the chart is ever applied to a non-k3s cluster.

### Decision 5 — hostmetrics' enabled scrapers

The hostmetrics receiver ships 11 scrapers. This slice enables eight:

| Scraper      | Why enabled                                                                                                 |
|--------------|-------------------------------------------------------------------------------------------------------------|
| `cpu`        | Node CPU utilization — primary dashboard panel.                                                              |
| `memory`     | Node memory used/available — primary dashboard panel.                                                        |
| `load`       | Node load1/load5/load15 — saturation signal.                                                                 |
| `disk`       | Per-device disk IO — primary dashboard panel.                                                                |
| `filesystem` | Per-mountpoint disk used % — primary dashboard panel.                                                        |
| `network`    | Node-level network rx/tx — primary dashboard panel.                                                          |
| `paging`     | Swap pressure — operator signal even if rarely triggered locally.                                            |
| `processes`  | Count of running processes — cheap and operator-useful.                                                      |

Three deliberately NOT enabled:

- `process`: emits a metric series per running process on every scrape. On a busy host this is hundreds of series × tens of metrics each = cardinality blow-up. Operators query process state with `ps`, not prometheus.
- `processes_temperature`: requires `/sys/class/thermal/*` which is not present on all Lima VM images.
- `system`: emits boot time and uptime — operator-useful, but redundant with `kube_node_info` from `k8s_cluster`. Skipping to keep the family list focused; trivial to enable later.

### Decision 6 — k8s_cluster Deployment, `replicas: 1`, no leader election

A single-replica Deployment on a single-node local cluster has no duplicate-data problem. Adding `k8s_leader_elector` extension is documented complexity for a problem that does not exist locally. The Hetzner overlay stub flags this for multi-node prod (the chosen patch is "bump replicas to 2 + wire `k8s_leader_elector` extension before flipping prod"; out of scope here).

**Why a Deployment and not a StatefulSet:**
- The receiver is stateless. It watches the apiserver and emits metric points; nothing persists across pod restarts. Deployment is the right shape.

**Why not a Job / CronJob (one-shot per scrape interval):**
- Cluster-state metrics are continuous, not point-in-time. The receiver maintains apiserver watch connections to emit phase transitions promptly. CronJob teardown/setup churn would lose state and produce gaps in series.

### Decision 7 — RBAC scope: cluster-scoped read, the documented minimum per receiver

Both new ClusterRoles grant *read-only*, *cluster-scoped*. Cluster-scoped because:

- `kubeletstats` enriches pod metrics with pod metadata (pod UID resolved to pod name + labels) — the metadata lookup hits the apiserver, not just the local node. Even though the actual kubelet scrape is per-node, the enrichment is cluster-wide.
- `k8s_cluster` watches every resource kind it emits metrics for. The watch is cluster-wide by definition.

Resource lists for both ClusterRoles are taken verbatim from the contrib repo's example RBAC for each receiver — the lists are upstream-published minimums, not bespoke choices here. Writing the lists out long-form in this slice's `rbac.yaml` files (rather than referring to a CRD) keeps the manifest grep-friendly and avoids a hidden coupling to an external CRD definition.

**Alternatives considered:**
- *Namespace-scoped Role.* Rejected for the same reason slice 20 rejected it for log-agent: the receiver doesn't know that the scope is narrowed, it just resolves metadata against the apiserver and would silently fail on every pod outside the namespace.

### Decision 8 — Resource sizing matches the slice-20 log-agent envelope

Both new pods: `requests: cpu=50m, memory=128Mi`, `limits: cpu=200m, memory=256Mi`. Identical to slice-20's log-agent. Justification:

- Per-pod work is similar in shape: a receiver pulls structured data from a source (kubelet HTTPS, /proc, apiserver watch), runs it through a batch processor, ships OTLP/gRPC to a local Service. No cross-cluster TLS handshake (that happens on the gateway). No dual-write fan-out (also gateway).
- Operators don't have to learn a new envelope. Same numbers across log-agent, metrics-agent, metrics-cluster-agent.
- The 256Mi memory ceiling fits the kubeletstats apiserver-cache + the batch processor's in-flight queue + the k8s_cluster watch state at local-dev scale. Hetzner slice will re-size.

### Decision 9 — Dashboard PromQL targets OTel-translated metric names (e.g. `k8s_node_cpu_utilization`), not cAdvisor names

The `prometheusremotewrite` exporter on the obs collector applies the standard dotted-to-underscored translation when writing into prometheus. The OTel semantic conventions for kubeletstats, hostmetrics, and k8s_cluster are stable as of v0.111.0; the contrib repo publishes the family list for each receiver. Dashboard JSON is written against the published OTel-translated names.

**Why not write the dashboard against cAdvisor's `container_cpu_usage_seconds_total` family:**
- That family does not exist in the obs prometheus. The OTel receivers emit a different family; no Docker-cAdvisor sample ever reaches obs prom.
- The compose `infrastructure-overview.json` dashboard renders the cAdvisor family in *compose* prom (which is scraped by compose's cAdvisor sidecar). It stays compose-only and retires with slice 22.

### Decision 10 — One ConfigMap per agent, no shared base ConfigMap

Each agent has its own `configmap.yaml` co-located with its `daemonset.yaml` / `deployment.yaml`. Receivers, processors, and exporters are agent-specific — the kubeletstats config block has no meaning for the cluster agent, and the k8s_cluster block has no meaning for the per-node agent. Sharing a ConfigMap would force defensive `if-this-receiver-is-listed` thinking and complicate ConfigMap rollouts.

This matches the slice-18 / slice-20 convention: each collector pod has its own ConfigMap at `infra/k8s/base/<workload>/configmap.yaml`.

## Risks / Trade-offs

- **[Risk] Metric cardinality blows up the obs prometheus 5Gi PVC before we notice.** kubeletstats + hostmetrics emit a per-pod or per-mount series for every label combination. At single-node local scale this is bounded by node count × pod count × container count, which is small — but unbounded ingest is the kind of thing that fails silently until the PVC is full. → *Mitigation*: deferred filter / drop list is a known follow-up (proposal NON-GOAL); monitor `prometheus_tsdb_storage_blocks_bytes` against the 5Gi cap during the first week of running and add a `filter/keep` processor on the gateway if needed.
- **[Risk] Two-pod sprawl drifts from one-pod consolidation.** Slice 20 left the door open for slice 21 to add a sibling pipeline on the log-agent instead. By splitting into two new pods we're locking in the multi-pod shape. → *Mitigation*: each pod has independent failure domain (a logs regression doesn't kill metrics, etc.), and Hetzner-scale resource budgets dwarf the per-pod overhead. The consolidation path is reversible if local-dev pod density ever becomes a real concern.
- **[Risk] kubeletstats' insecure_skip_verify masks a real MITM in production.** Local k3s self-signed cert is fine; on Hetzner the kubelet cert may rotate, may be CA-signed, may be exposed across nodes. → *Mitigation*: the Hetzner overlay stub flags this — production kubeletstats should pin the k3s server CA via a hostPath mount or rely on the k3s server's cert-rotation mechanism. Local-mirror posture stays insecure_skip_verify.
- **[Risk] OTel `k8s.pod.*` family names change between contrib versions.** v0.111.0 names are stable, but a future bump may rename `k8s.pod.cpu.usage` to `k8s.pod.cpu.utilization` (or similar). The dashboard PromQL is tied to current names. → *Mitigation*: image-pin discipline across all four collector pods means version bumps land in a dedicated bump-collector slice; dashboard PromQL is updated in the same slice as the bump.
- **[Trade-off] Doubles the pod count of the "metrics-side" surface area from zero to two.** vs. zero today (cluster-state-blind). The dashboard payoff justifies the cost; the slice is the moment that ratio inverts.
- **[Trade-off] Compose prometheus also receives cluster metrics via the gateway's dual-write, but compose grafana has no panel for them.** The data is in compose prom but invisible — clean Explore queries work; pretty dashboards don't. Operators verifying side-by-side dual-write comparability during slice 21 → slice 22 run ad-hoc PromQL. The dashboard would be churn since compose dies in one slice.
- **[Trade-off] Single-replica k8s_cluster means a brief metrics gap if the pod restarts.** ~10s gap during pod rollout. Acceptable locally; multi-replica + leader election is the Hetzner-slice answer.

## Migration Plan

1. Apply the new base manifests via `just k8s-apply` (which already covers `./metrics-agent` and `./metrics-cluster-agent` once the base kustomization lists them).
2. Wait one scrape interval (15s) plus prometheus' WAL flush window (~15s additional) — ~30s total.
3. Verify in obs grafana → Explore → Prometheus datasource: queries like `k8s_node_cpu_utilization` and `k8s_deployment_available{deployment="backend"}` return points.
4. Open obs grafana → Dashboards → `cluster-overview` — every panel renders. The "Container restart count (last 1h)" panel reads 0 if the cluster is steady.
5. (Optional) Open compose grafana → Explore → Prometheus → run the same query. Side-by-side comparability check: same series, same values within scrape-interval lag. This is the operator confidence signal for slice 22 (`retire-compose-observability`).

**Rollback:**

Single revert. The pre-slice-21 state has no `metrics-agent` directory, no `metrics-cluster-agent` directory, no `cluster-overview.json` dashboard, no four justfile recipes, and the slice-17 comment block at `infra/k8s-obs/base/prometheus/values.yaml`. `git revert <slice-21-merge-commit>` removes all of the above. The obs prometheus keeps any samples already written; they age out per the 7d retention window.

No data migration. No state to preserve. No cert material to rotate.

## Open Questions

1. **Should `hostmetrics`' `filesystem` scraper include only the root mount `/`, or every mountpoint?** Default behavior on Lima is to include every mount, which on k3s nodes can mean tens of overlay mounts (one per container). Each is a separate series. → Deferred. Default config (every mount) for the slice; revisit if PVC pressure surfaces in week 1.
2. **Should the `k8s_cluster` receiver enable `node_conditions_to_report` for additional node conditions beyond `Ready`?** Default is `[Ready]`. Adding `[Ready, MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable]` gives operator-useful saturation signals at near-zero cardinality cost. → Plan to enable all five in the implementation; revisit if any of them flap on Lima.
3. **Should the `metrics-cluster-agent` Deployment carry the same `tolerations: [{operator: Exists}]` posture as the metrics-agent DaemonSet?** Single-node-local doesn't care; on a multi-node Hetzner cluster a singleton Deployment without broad tolerations might fail to schedule if the only untainted node is full. → Plan: NO tolerations on the Deployment (the k8s_cluster receiver doesn't care which node it lands on, so leaving the scheduler free to pick any untainted node is fine). The Hetzner overlay stub can add tolerations later if observed scheduling issues.
4. **PromQL `k8s_pod_cpu_utilization` vs. `k8s_pod_cpu_usage`:** the OTel kubeletstats receiver historically emits both, with `*_utilization` being a derived 0..1 ratio and `*_usage` being a rate. v0.111.0 family list says utilization is the stable one. → Plan: write dashboard PromQL against `*_utilization`; if the metric is missing at runtime, the implementation step verifies and switches to `*_usage` before commit.
5. **Should the `cluster-overview` dashboard be loaded via the same provisioning ConfigMap that the slice-17 grafana chart created, or a new sibling ConfigMap?** Depends on the chart's `extraConfigmapMounts` shape and whether the existing ConfigMap is named in a way that admits more JSON files. → Implementation step inspects the slice-17 grafana chart's provisioning layout and chooses; either path is fine, the dashboard JSON is the same.
