## Context

After slice 19, the observability arc has a fully-built transport spine for logs:

```
                                          ┌─────────────────────┐
                                          │ obs k3s cluster     │
                                          │                     │
  ┌──────────────────────┐                │  ┌────────────────┐ │
  │ app k3s cluster      │                │  │ obs collector  │ │
  │                      │   mTLS         │  │ logs pipeline  │ │
  │  ┌────────────────┐  │   :14318       │  │ otlp.recv →    │ │
  │  │ gateway        │──┼─────────────► │ │ │  batch →       │ │
  │  │ collector      │  │  (slice 19)   │  │  redact →      │ │
  │  │ logs pipeline  │  │                │  │  otlphttp/loki │ │
  │  │ otlp.recv →    │  │                │  └───────┬────────┘ │
  │  │  batch →       │  │                │          ▼          │
  │  │  redact →      │  │                │  ┌────────────────┐ │
  │  │  frontend_only │  │                │  │ loki           │ │
  │  │  → relay+obs   │  │                │  │ (chart-default)│ │
  │  └────────────────┘  │                │  └────────────────┘ │
  │         ▲            │                │                     │
  │         │ OTLP/HTTP  │                │  ┌────────────────┐ │
  │         │ (slice 18c)│                │  │ grafana        │ │
  │  ┌──────┴────────┐   │                │  │ Loki datasource│ │
  │  │ frontend nginx │  │                │  │ pre-provisioned│ │
  │  │ + browser SDK  │  │                │  │ (slice 18b)    │ │
  │  └────────────────┘  │                │  └────────────────┘ │
  │                      │                │                     │
  │  ┌────────────────┐  │                └─────────────────────┘
  │  │ backend pod    │  │
  │  │ stdout JSON    │  │
  │  │ (slice-2)      │  │     The gap: this log source
  │  └────────┬───────┘  │      has nowhere to plug into
  │           │          │      the spine.
  │           ▼          │
  │  /var/log/pods/social_backend-*/backend/0.log
  │                      │
  └──────────────────────┘
```

The gateway's logs pipeline carries a `filter/frontend_only` processor (slice 18b)
that drops every record whose `service.name != "frontend"`. That filter was placed
defensively *because the only log source dialing the collector was the browser*;
slice 18b was a half-step that wanted to fail closed against unexpected log volume.
Slice 20 turns that half-step into a full step: a real second source ships logs,
the filter's job changes from "only let FE through" to "drop the obs feedback loop"
(defence-in-depth against a future regression where the agent's namespace scope widens
without anyone noticing it would shadow itself).

**Existing primitives this slice rides on:**
- Gateway collector OTLP/gRPC receiver on `collector.social.svc.cluster.local:4317` (slice 18a)
- Gateway logs pipeline `batch → redact → … → dual-write to compose-relay + obs-cluster` (slice 18b)
- Cross-cluster mTLS envelope on `:14318` (slice 19)
- Obs collector logs pipeline `otlp → batch → redact → otlphttp/loki` (slice 18b)
- Loki 3.x with native `/otlp` ingest path (chart values, slice 17)
- Grafana Loki datasource pre-provisioned (slice 18b)
- Backend emits structured JSON via logback (slice-2 hardening) — `timestamp`, `level`, `logger`, `message`, plus `trace.id` / `span.id` from the OTel agent's MDC propagation

**Constraints inherited from earlier slices:**
- Image pin: every collector pod runs `otel/opentelemetry-collector-contrib:0.111.0` (one bump, all pods)
- Local-only: this slice never runs on Hetzner. The hetzner overlay gets a commented stub.
- Single k3s node: the DaemonSet is one pod. Tolerations must include the control-plane taint or the pod will never schedule.
- 8 GiB Lima VM envelope: budget ~256 MiB for the agent (matches gateway sizing).

## Goals / Non-Goals

**Goals:**

1. Backend pod stdout logs land in obs grafana's Loki datasource end-to-end, with `kubectl logs deploy/backend -n social` and Loki query results matching line-for-line.
2. Logs carry k8s attributes (`k8s.namespace.name`, `k8s.pod.name`, `k8s.container.name`, `k8s.node.name`, plus the `app.kubernetes.io/name` workload label) as resource attributes — queryable as Loki labels.
3. JSON-shaped backend logs are parsed at the agent (not the gateway, not Loki) so `timestamp`, `severity_text`, `body`, `trace.id`, and `span.id` are first-class attributes by the time the record reaches Loki.
4. Browser FE error logs continue to flow into Loki unchanged.
5. The transport spine — gateway → obs collector → Loki — is unchanged. Only the agent (new) and the gateway's filter (renamed + rescoped) move.
6. The agent/gateway pattern this slice introduces is reusable as-is by slice 21 for cluster metrics (kubelet/cAdvisor → agent → gateway → obs prometheus).

**Non-Goals:**

- Tailing logs from `kube-system`, `default`, or any namespace other than `social`. The filelog `include:` glob is `/var/log/pods/social_*/*/*.log`. Widening is a future concern; doing it now risks blowing up Loki's PVC on the local mirror.
- Metrics or trace signals from the agent. The agent has one pipeline: logs.
- Log-based alerting, retention tuning, or index/label cardinality engineering. Defaults from the slice-17 Loki chart values stand.
- Audit logs, container runtime logs, kernel logs. Slice 20 is application pod logs.
- A direct agent → obs cluster path (Option B from exploration). Single security envelope at the gateway, single redaction pass — the reasoning is captured in Decision 2.
- Operator-grade configuration knobs (per-namespace include/exclude lists, dynamic reload). Hard-coded in the ConfigMap; a future slice can lift them.

## Decisions

### Decision 1 — DaemonSet, not Deployment

A DaemonSet places one agent pod per node, co-located with the kubelet's pod log directory at `/var/log/pods/`. A Deployment cannot tail node-local files reliably (replicas land on arbitrary nodes; only the replica on the same node as a given pod sees that pod's logs).

**Alternatives considered:**
- *Sidecar streaming container in every pod.* Rejected: invasive, requires modifying every workload's Deployment manifest, and doubles the pod count for no architectural gain.
- *Loki Promtail / Grafana Alloy.* Rejected: introduces a non-OTel logging stack alongside the OTel-native traces/metrics stacks, and the spec's grafana datasource is configured for Loki's OTLP ingest, not Promtail's loki-push API. Keeping everything in OTel is the production-grade choice the user's `feedback_prefer_realistic_architectures` memory points at.
- *Fluent Bit DaemonSet.* Same objection — non-OTel-native. Possible future migration, not now.

### Decision 2 — Agent ships to the gateway, not direct to the obs cluster

The agent's OTLP exporter targets `collector.social.svc.cluster.local:4317` (in-cluster, plaintext gRPC). The gateway forwards via mTLS to the obs cluster. This is the production-canonical OTel "agent/gateway" pattern.

**Why over direct-to-obs:**
- One mTLS endpoint to manage. The cross-cluster cert pair (slice 19) lives on the gateway only. The agent has no cert material.
- One redaction pass. The gateway's `transform/redact-path-ids` already runs before the cross-cluster hop. The agent doesn't duplicate it.
- One security boundary. If a future change tightens the cross-cluster envelope (e.g. SPIFFE IDs, network policy), it lands at the gateway. The agent is naïve.
- Slice 21 (cluster metrics) inherits the same pattern: scrape on the agent, forward to the gateway, the gateway is the only thing that knows about the obs cluster.

**Cost:**
- Gateway becomes a single point of fan-in for two log sources (browser FE errors via nginx → gateway; pod logs via agent → gateway). Acceptable: the gateway is already designed as the fan-in point, and the same single-point-of-fan-in exists for traces and metrics.
- If the gateway is down, pod logs queue at the agent's batch processor and eventually drop (retry queue is bounded). For local-dev this is acceptable; for production a future slice will tune retry / persistent-queue (out of scope here).

### Decision 3 — Parse JSON at the agent, not at the gateway or Loki

The filelog receiver's `operators:` chain (a) strips the CRI envelope, (b) runs a `router` operator that branches on whether the message body parses as JSON, (c) for the JSON branch, runs a `json_parser` operator that promotes inner fields to attributes (`timestamp` → log record timestamp, `level` → severity, `message` → body, `trace_id` / `span_id` → record fields used by Loki's trace-to-logs correlation).

**Why at the agent and not query-time at Loki:**
- Loki's `json` parser at query time burns CPU per query and per repeat-query. Doing it once at ingest amortizes across all future queries.
- Grafana's trace-to-logs correlation needs `trace.id` and `span.id` as proper log-record fields (or labels), not as substrings inside a JSON body. The slice-9 exemplar work and the slice-5 frontend-traces work both depend on this correlation; the agent doing the lift means those flows light up automatically.
- The redact processor at the gateway operates on attributes (the existing OTTL hits `url.path`, `http.url`, etc.). Promoting JSON fields to attributes at the agent feeds the redactor the right shape.

**Why not at the gateway:**
- The gateway already does redaction (an expensive OTTL pass). Adding JSON parsing there doubles the per-record work at the fan-in chokepoint. Parsing at the agent distributes the cost across nodes.
- The agent is the only place where we know which container produced the line. JSON-vs-text detection is per-container in practice (backend = JSON, postgres = text, nginx = text). The agent has the right context (via `k8sattributes`) to route correctly.

**Why not at Loki:**
- Loki LogQL `json` parser is fine for ad-hoc exploration but isn't the path for routine dashboards.
- More importantly: trace correlation in Grafana wants the trace ID as a field, not as a substring.

### Decision 4 — Rename `filter/frontend_only` → `filter/exclude_observability_self`, not delete it

The slice-18b filter dropped non-frontend records. That logic is *removed* — backend pod logs must flow through. But removing the processor entirely loses a defence-in-depth lever. The new filter drops records whose `resource.attributes["k8s.namespace.name"] == "observability"` — a feedback-loop guard.

**Why keep a filter at all:**
- The agent's namespace scope is `social_*` today (Decision 5), so the filter is a no-op in practice. But: if a future slice widens the scope without thinking about it, the obs cluster's own collectors and the obs cluster's own grafana would start shipping logs through the loop — gateway → obs collector → Loki → ... → gateway gets logged → ships through again.
- The filter is one OTTL line that costs nanoseconds per record. The insurance premium is trivial.

**Why rename rather than keep the name:**
- `frontend_only` describes the OLD behavior (only FE logs allowed). Keeping the name with new OTTL produces a misleading processor at every config-grep. The cost of a rename is one line in the ConfigMap and one line in the modified-requirement delta.

### Decision 5 — Filelog scope is `/var/log/pods/social_*/*/*.log` only

The `include:` glob restricts the filelog receiver to pods in the `social` namespace (and the agent's own pods in `social_log-agent-*/*/*.log`, so the shipper observes itself).

**Why narrow first:**
- Local Lima VM is 8 GiB. The obs cluster's Loki has a 5Gi PVC. `kube-system` pods (Traefik, coredns, metrics-server, klipper-lb) produce real log volume continuously. Including them on day one risks the Loki PVC filling under sustained local-dev sessions, which would surface as cryptic grafana errors and obscure the slice's actual end-to-end loop.
- Application pod logs are the most operator-valuable signal in this stage of the project — `kubectl logs deploy/backend` is the daily-dev surface area we're mirroring into Loki.
- A future slice can widen the include glob (the rest of the pipeline is identical), gated on a Loki retention / sizing rev.

**Why include the agent's own pods:**
- "The shipper that doesn't observe itself" is a class of incident. If the agent regresses, no operator sees it from inside the spine; they have to drop to `kubectl logs daemonset/log-agent`. Including the agent's own logs in the shipped set means a single Loki query covers both app and shipper.

### Decision 6 — RBAC: ClusterRole, not Role

The `k8sattributes` processor reads pod metadata to enrich records. The processor documents requiring `pods`, `namespaces`, and `replicasets` read access. Even though the agent's `include:` glob is `social_*` today, the processor enriches records based on the *pod that produced them* — and to do that lookup the processor needs to read the corresponding pod object in the apiserver.

**Why cluster-scoped read:**
- The pod whose logs are being read might be in any namespace. The processor doesn't know that the include glob narrows the scope; it just resolves UIDs to attributes against the apiserver. Cluster-scoped read is the documented minimum.
- The grant is read-only on three resource kinds. Cluster admin / write is NOT granted.

**Alternatives considered:**
- *Namespace-scoped Role.* Rejected: the processor would silently fail to enrich records from any pod outside the agent's own namespace, even though it's structurally capable of producing them.

### Decision 7 — Resource sizing matches the gateway, not a smaller "edge" envelope

Agent: `requests: cpu=50m, memory=128Mi`, `limits: cpu=200m, memory=256Mi`. Gateway: `requests: cpu=50m, memory=128Mi`, `limits: cpu=500m, memory=256Mi`.

Same memory envelope. Agent's CPU limit is lower because the agent does parse-and-attribute work per record but no cross-cluster TLS handshake / batching across two destinations. Gateway's CPU limit is higher for the dual-write + TLS overhead.

**Why 256Mi memory:**
- filelog's buffer + batch processor's in-flight records + k8sattributes' apiserver cache fits comfortably in 256Mi for local-dev volume.
- Aligns with the gateway so operators don't have to learn two envelopes.

### Decision 8 — DaemonSet tolerates the control-plane taint

A one-node k3s cluster has the only node carrying `node-role.kubernetes.io/control-plane:NoSchedule` (or the k3s equivalent). Without an explicit toleration the DaemonSet's pods would not schedule on that node, and the agent would have zero pods running — a silent failure mode.

```yaml
tolerations:
  - operator: Exists
```

`operator: Exists` (no `key:`, no `value:`) tolerates every taint. On a one-node cluster this is the right answer. On a multi-node Hetzner cluster the same `Exists` toleration is also correct (we want pod logs from every node, including worker nodes that don't carry the control-plane taint and master nodes that do). The Hetzner overlay stub will document this as the intentional production stance, not a local-mirror shortcut.

## Risks / Trade-offs

- **[Risk] Gateway fan-in saturation under heavy log volume.** The gateway processes traces, metrics, and now two log sources. → *Mitigation:* The batch processor at the gateway absorbs short bursts. Long-term capacity work is a future concern; local-dev volume is well below the gateway's headroom. If the gateway OOMs, the agent's OTLP retry queue absorbs the gap.
- **[Risk] filelog cursor file lost on pod restart.** The DaemonSet's filelog receiver tracks read offsets per file. Default storage is in-memory; if the agent pod restarts, it re-reads from the start of every open log file, duplicating records into Loki. → *Mitigation:* Configure the filelog receiver's `storage` extension to use the host's `/var/log/pods` parent directory (or a hostPath-mounted bookkeeping directory). For the local mirror this is acceptable to defer to a follow-up if pod restarts are rare enough; capturing as an open question.
- **[Risk] JSON-vs-text autodetect mis-routes a log line.** A backend log line that contains a stray `{` could trip the JSON parser and produce garbled attributes. → *Mitigation:* The `router` operator's JSON branch uses `body matches "^\\s*\\{"` as the predicate (start-of-line `{` after optional whitespace). The `json_parser` operator's `on_error: send_quiet` falls back to the raw body if parsing fails, so a mis-detected line lands as text rather than dropping.
- **[Risk] k8sattributes processor's apiserver cache thrashes on pod churn.** Every new pod resolution hits the apiserver until cached. → *Mitigation:* `k8sattributes` ships sensible defaults (5 min TTL on the pod cache). Pod churn in a one-node local cluster is near-zero.
- **[Risk] The renamed gateway filter drops a record that today flows through.** Browser FE errors carry `resource.attributes["service.name"] = "frontend"` but no `k8s.namespace.name` — they come from the browser, not a pod. → *Mitigation:* The new OTTL drops only records where `k8s.namespace.name == "observability"`, so browser-origin records (which have the attribute absent or null) pass through. The verification scenario explicitly exercises this — see specs.
- **[Trade-off] The agent does not stream logs across pod restarts.** If the agent pod is restarted (e.g. on ConfigMap rollout), filelog re-reads from the start of every open log file. For local-dev this is acceptable; for production the storage extension is the answer.
- **[Trade-off] No namespace label widening.** Operators querying Loki for `kube-system` logs will see nothing. Documented in README and the Hetzner overlay stub.

## Migration Plan

This slice is additive at the manifest level (one new DaemonSet) and renames one existing processor at the gateway. No data migration is required.

**Forward path:**
1. Bring up the cluster: `just vm-up` (no-op if already running).
2. Generate certs / bring up obs cluster if not already up: `just obs-up` (no-op).
3. Apply the app cluster: `just k8s-apply` — the new `./log-agent` resource is included in the base kustomization, kubectl rolls out the DaemonSet and the renamed processor at the gateway in one apply.
4. Generate traffic: `just backend-forward` and curl an endpoint.
5. Open obs grafana: `just obs-grafana`, browse to Explore → Loki, query `{k8s_namespace_name="social"}`.
6. Backend log lines appear with matching `trace_id`, `pod`, `container` labels.

**Rollback path:**
- `git revert` the slice's commit.
- `just k8s-apply` re-renders the previous state (no `./log-agent` entry, original `filter/frontend_only` processor).
- Loki retains logs already shipped — they sit in storage until the chart's default retention window expires.

## Open Questions

1. **filelog cursor persistence.** Defer to a follow-up if pod restarts in local-dev prove rare enough, or wire the `file_storage` extension to a hostPath now? Tentative answer: defer (one-line follow-up), flag in README. Resolution acceptable in spec via "no requirement on cursor durability in slice 20".
2. **Log severity mapping for non-JSON containers.** Postgres logs land as raw text via the agent. Severity defaults to unset. Acceptable for slice 20 (operators querying postgres logs in Loki use full-text search); future slice may add a regex-based severity extractor.
3. **Trace correlation field names.** Loki/Grafana expect `trace_id` and `span_id` (underscored) for trace-to-logs correlation panels. Backend logback MDC emits `trace.id` / `span.id` (dotted, the OTel convention). The agent's JSON parser config will normalize to the underscored form expected by Grafana. Captured as a spec requirement (see specs).
