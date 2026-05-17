## Context

This is slice 22a of the seven-slice "compose-to-k3s observability" arc named in README §"Forward arc" (line 442 onward). The README has slice 22 (`retire-compose-observability`) as a single retirement step; this proposal splits it into **22a `migrate-obs-content`** (this slice, content migration with compose still running) and **22b `retire-compose-observability`** (next slice, deletion of compose + e2e retarget). The split preserves the side-by-side parity window the entire dual-write spine in slices 18b–21 was built to enable.

**Where the obs side is today (slice-21 end state):**

- Obs prometheus runs (chart pin `29.6.0`), with the remote-write receiver enabled (slice 18c) and `resource_to_telemetry_conversion.enabled: true` on the obs collector's exporter (slice 21). It accepts incoming OTel-shaped series; it carries *no* rules, no alertmanager target.
- Obs alertmanager runs (chart pin `1.36.0`), with a `null` receiver that drops every firing. Slice-17 stood it up empty intentionally to give slice 22 a place to land the real routing.
- Obs grafana runs (chart pin `8.5.4` / app `10.5.15`), provisioning datasources (Prometheus, Tempo, Loki, Alertmanager) since slice 18b and one dashboard (`cluster-overview.json`) since slice 21.
- App-cluster collector dual-writes every signal type to compose + obs (slices 18a-c).
- App cluster has no `postgres-exporter`; compose's `postgres-exporter` reaches the in-cluster postgres via `host.docker.internal:5432` (slice 14).
- Compose's `webhook-sink` is the only target for the existing alertmanager routing tree.

**Constraints inherited from earlier slices:**

- Image pin: `otel/opentelemetry-collector-contrib:0.111.0` for any collector pod (slice 17 baseline; touched by 18b/18c/19/20/21).
- No Prometheus Operator / kube-prometheus-stack (README design constraint, lines 432–435).
- Local-only — Hetzner overlay gains a commented stub alongside slice-15..21 stubs.
- 8 GiB Lima VM envelope per VM; budget the migration at ~+128Mi total across both VMs.
- The arc invariant: each slice independently revertable; visibility-into-the-app-cluster never broken.

**Stakeholder reading this design:** the person implementing this slice (the next /apply session) and the operator who will later run the side-by-side parity check before signing off on slice 22b.

## Goals / Non-Goals

**Goals:**

1. Every SLO + database alerting rule that compose prometheus carries today is also loaded by obs prometheus, firing the same alerts on the same series under the same labels.
2. The obs alertmanager carries the same severity-keyed routing tree compose has — page/ticket receivers + BackendDown inhibition — delivering firings to an in-cluster webhook-sink.
3. The `pg_*` series that today only exist in compose prom because of `postgres-exporter` also flow through the app collector into both prometheus instances, validating that the new in-cluster exporter produces compose-equivalent output.
4. Backend, frontend, and database operator dashboards render in obs grafana with the same panels (and same data) compose grafana already shows.
5. Compose observability continues to work unchanged. The slice does not delete or rewire anything compose-side.
6. The CI promtool job continues to validate rule content; a new diff guard catches drift between the parity-window copies.

**Non-Goals:**

- Container-tier infra alerts (`container-alerts.yml`). Cadvisor-shaped series do not map 1:1 to slice-21 OTel families; rewriting `container_cpu_cfs_throttled_periods_total` to `k8s_container_cpu_throttled_periods` (or the closest equivalent) and re-authoring the alerts under the new label set is real spec evolution that deserves its own promtool test fixture. Out of scope; flagged below as "what's next."
- Compose retirement. The `compose-relay*` exporters in the app collector stay; the `observability` profile in docker-compose.yml stays; `infra/observability/` keeps its current name. That's slice 22b.
- E2E spec retargeting. The five observability e2e specs (`observability.frontend-traces`, `observability.frontend-rum-metrics`, `observability.metric-exemplars`, `observability.alerting`, `observability.frontend-errors`) continue hitting compose endpoints (`localhost:9090/3200/3100/8081/8889`). Repointing is part of 22b alongside the Lima portForward additions the obs VM needs.
- `infra/observability/` rename. The directory keeps its current name; renaming to `infra/certs/` + relocating `runbooks/` happens in 22b.
- Alertmanager UI parity. Both UIs render the same active alerts; the operator can grafana-Explore both. No grafana dashboard for Alertmanager state.
- Leader election / HA. Single-replica webhook-sink; single-replica postgres-exporter. Hetzner overlay stub flags both.
- Production-grade postgres exporter credentials. The exporter loads `social`/`social` from the same Secret the backend uses. A `pg_monitor`-granted role is a Hetzner concern, called out in the overlay stub.

## Decisions

### Decision 1 — Split the README's slice-22 into 22a (migrate) + 22b (retire)

The README and the slice-21 proposal both name slice 22 as a single `retire-compose-observability` step. Re-reading the surface area, that slice carries *two* unit-of-work bundles glued together:

```
  Migration unit                              Retirement unit
  ──────────────                              ───────────────
  - 5 rule files into obs prom                - 3 compose-relay exporters dropped
  - alertmanager routing tree                 - observability compose profile deleted
  - webhook-sink to obs cluster               - infra/observability/ renamed
  - postgres-exporter to app cluster          - 5 e2e specs retargeted
  - 3 dashboards into obs grafana             - 4 Lima portForwards added (obs VM)
  - app collector prometheus receiver         - README narrative rewritten
                                              - CI promtool path repoint
```

The migration unit is the risky one — rule queries must produce the same series under the same labels; dashboard JSON must render without "No data"; alertmanager firings must reach the sink. The retirement unit is mostly mechanical once migration is verified.

Doing both in one slice means the operator either (a) merges before the parity is proven, with no way to verify since compose is already gone, or (b) holds the PR open while running parity by hand, which is exactly the side-by-side window the slice would just have collapsed.

**Alternatives considered:**

- *Single slice 22 with a feature flag.* Adds a chart-values toggle (`migrate.enabled: true`) to gate the new content. Hides the parity question behind ops procedure rather than git-history granularity. Rejected: not how the rest of the arc is sequenced; each slice is a single coherent change, not a flag-gated capability.
- *Migrate during slice 22b's retirement, no separate slice.* Same problem — no parity window.
- *Three slices: 22a content, 22b workloads, 22c retire.* Over-decomposed. The postgres-exporter Deployment and the rule-file copy land in the same conceptual unit (validate parity end-to-end before deleting compose).

### Decision 2 — `extraConfigmapMounts` for rule files, not `serverFiles.alerting_rules.yml`

The prometheus-community chart exposes two ways to ship rules:

- **(A) `serverFiles.alerting_rules.yml` + `serverFiles.recording_rules.yml`** — YAML content embedded directly in the chart values file. The chart templates a ConfigMap from the values. Cleanest from a chart-perspective; one less manifest.
- **(B) `extraConfigmapMounts:`** — values file references a separately-generated ConfigMap whose source files are kustomize-generated. The rule YAML stays in `.yml` files on disk.

We pick (B) for two reasons:

1. **The same `.yml` files run through `promtool test rules` in CI today.** Promtool reads file paths, not embedded YAML. (A) would require either (a) duplicating the rules in two places — values.yaml and the existing rules/ directory — invalidating the single source of truth, or (b) authoring a CI step that extracts the embedded YAML from values.yaml before promtool runs. Both are worse than keeping the rules in `.yml` files.
2. **A `configMapGenerator` lets the obs-side rules ConfigMap source files from `infra/k8s-obs/base/prometheus/rules/`** — a sibling directory that survives slice 22b (when the compose-side `infra/observability/prometheus/rules/` retires). The parity-window copies live in both directories and are guarded by a CI `diff` step (Decision 5).

**Alternatives considered:**

- *Embed in `serverFiles`.* See above.
- *Mount `infra/observability/prometheus/rules/` directly via `extraConfigmapMounts:` referencing a kustomize ConfigMap whose `files:` list crosses `../../observability/`.* Kustomize allows this, but the cross-tree relative path is fragile — a future move of either directory breaks both. Worse, it makes the obs cluster's manifest tree depend on the compose-cluster's manifest tree, exactly the coupling slice 22b will break in a few weeks.

### Decision 3 — `webhook-sink` lands in obs cluster (not dropped)

The webhook-sink is a test mock: a tiny HTTP service that records every POST body and exposes them on a `/received` query endpoint. Compose's `observability.alerting.spec.ts` spec queries it to verify alertmanager routing.

Three options:

- **(i) Drop it.** Lose the alerting e2e test; the operator manually verifies via alertmanager UI. Cheap, but a regression on test coverage for the alerting tree.
- **(ii) Deploy in obs cluster.** ~32Mi pod; alertmanager → ClusterIP webhook URL; one `kubectl port-forward` for the e2e to talk to it (slice 22b decides whether to repoint the e2e or retire it).
- **(iii) Deploy in app cluster.** Cross-cluster network from alertmanager → app cluster; introduces a new auth/transport concern just for a test mock.

(ii) wins. The webhook-sink is the alertmanager's *receiver*; it belongs next to the alertmanager. The image already exists at `infra/observability/webhook-sink/`. Building it and pushing to the local OCI registry under the same slice-15 image flow keeps the inner loop short.

### Decision 4 — `postgres-exporter` lands in app cluster (not obs cluster)

Three placements for the exporter:

- **(i) App cluster, scraped by app collector.** Same agent/gateway pattern as slice 20/21. The exporter dials `postgres.social.svc.cluster.local:5432` (in-cluster); the collector dials `postgres-exporter.social.svc.cluster.local:9187` (in-cluster); the existing dual-write fan-out delivers `pg_*` to both prometheus instances.
- **(ii) Obs cluster, scrapes app-cluster postgres cross-cluster.** Inverts the data flow (everything else is push, this would be pull). Requires ingress on app cluster's postgres-lb plus a second auth model. Inconsistent with slice 20/21.
- **(iii) Drop database-alerts entirely.** Regressive.

(i) wins. The exporter lives next to the workload it observes; the cross-cluster spine carries the same shape it carries for every other signal.

The exporter scrapes postgres with the *same* `social`/`social` credentials the backend uses (loaded from the existing `postgres-credentials` Secret), matching the compose path. A production exporter wants a `pg_monitor`-granted role with read-only stats access; that's a Hetzner concern called out in the overlay stub. Local dev does not need the separation.

**Why a `prometheus` receiver on the collector, not a Prometheus scrape job:**

The agent/gateway commitment is "all metrics flow OTLP into the collector, then dual-write fan-out at the gateway." Adding a chart-side scrape on either prometheus instance would short-circuit that — one prom would see `pg_*` directly, the other only via the OTel-shaped path. Putting the scrape *on the collector* (using the contrib `prometheus` receiver, which scrapes Prometheus-format endpoints and emits OTLP metrics internally) keeps the fan-out symmetric. Both prometheus instances receive `pg_*` through the same pipeline that carries every other family.

**Alternatives considered:**

- *Side-by-side: keep compose's `postgres-exporter` + add a second one in app cluster.* Two exporters, two sets of series labelled differently, hard to verify parity without label normalization. Rejected.
- *Use the OTel contrib `postgresql` receiver instead of the prom-format exporter.* Different metric family names (`postgresql.backends`, not `pg_stat_database_numbackends`). Breaks the existing `database-alerts.yml` expressions. The exporter is the right tool for spec parity.

### Decision 5 — CI diff guard catches parity-window drift

Both `infra/observability/prometheus/rules/*.yml` (compose source of truth, fed to compose prom) and `infra/k8s-obs/base/prometheus/rules/*.yml` (obs copies, fed to obs prom via configMapGenerator) carry the same rule content during the parity window. The risk: a future PR edits one but not the other; the two prometheuses diverge silently; the side-by-side parity property breaks without anyone noticing.

The CI `prometheus-rules` job gains a `diff -q` step:

```sh
for f in slo-recording.yml slo-alerting.yml fe-slo-recording.yml \
         fe-slo-alerting.yml database-alerts.yml; do
  diff -q "infra/observability/prometheus/rules/$f" \
          "infra/k8s-obs/base/prometheus/rules/$f"
done
```

Fails the job on any byte difference. Costs ~2s. The check retires when slice 22b deletes the compose-side files (the diff step is removed in the same commit).

**Alternatives considered:**

- *Symlink the obs copies to the compose originals.* Symlinks across `infra/` subtrees work locally but are fragile under kustomize's path-resolution and break on Windows checkouts. Rejected.
- *Single source of truth via configMapGenerator pointing across `../../observability/`.* See Decision 2's rejected variant. Same fragility cost as Decision 2.

### Decision 6 — Container-alerts deferred to a follow-up slice

`container-alerts.yml` carries three alerts: `ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`. All three are keyed on cadvisor series:

```
container_cpu_cfs_throttled_periods_total{name=~"social-.*"}
container_memory_working_set_bytes{name=~"social-.*"} /
  container_spec_memory_limit_bytes{name=~"social-.*"}
container_oom_events_total{name=~"social-.*"}
```

Slice 21's `metrics-agent` emits the OTel-shaped equivalents:

```
k8s_pod_cpu_time     (no CFS throttling counter — kubeletstats does not expose it)
k8s_pod_memory_working_set / k8s_container_memory_limit
k8s_pod_status_reason / k8s_container_restarts (OOM signal is indirect)
```

The mapping is not 1:1. CFS throttling is not in kubeletstats at all — it lives on `/sys/fs/cgroup` and the hostmetrics receiver does not surface it. The OOM signal in k8s_cluster is `k8s_container_restarts` with `k8s_container_last_terminated_reason="OOMKilled"`, which fires *after* the kill, not on the kill itself.

Re-authoring the three alerts against the OTel families, validating the new expressions against promtool synthetic fixtures, and updating the runbooks is a unit of work comparable to slices 12 and 13 themselves. It does not belong inside 22a's migration scope. It also does not block 22b: a temporary gap in container-saturation alerting on a single-node local dev cluster is small risk (the saturation surfaces visibly in `cluster-overview.json`, which slice 21 already provides).

Follow-up slice: `add-k8s-container-saturation-alerts` (or whatever the next /openspec-new-change names it), post-22b.

### Decision 7 — Dashboard datasource UIDs already align; only `instance` filter loosens

The obs grafana datasource definitions (slice 18b) name the prometheus datasource `prometheus` (UID matches the compose one). Dashboards exported from compose grafana embed `datasource: prometheus` in every panel. So the migration is *byte-identical* on the datasource leg.

The compose dashboards do carry one compose-flavored selector: backend panels filter `instance="host.docker.internal:8080"` (the value compose's prometheus assigns when scraping the host backend on slice-6's days). In obs prom, the backend pushes via OTLP through the collector, so the `instance` label is absent or carries the in-cluster pod IP. Relaxing each such selector to `instance=~".*"` (or removing the selector if there's only one series) makes the same JSON render on both grafanas.

This is the only systematic edit. Per-panel queries are reviewed individually during 8.x verification (tasks.md §8).

## Risks / Trade-offs

- **Rule duplication during the parity window.** Mitigated by the CI diff guard (Decision 5). Retires in 22b.
- **Postgres-exporter credentials shared with the backend.** Acceptable for local dev; flagged for prod via the Hetzner overlay stub.
- **Webhook-sink image must be (re)built and pushed.** Adds one `just webhook-sink-image` recipe to the slice. Same flow as slice-15 backend image.
- **Alertmanager routing tree change risks losing in-flight alerts.** The slice-17 null receiver was already dropping firings; replacing it with the real tree is purely additive (no loss of behavior). The compose alertmanager is untouched and remains the source of truth during the window.
- **`prometheus` receiver on the collector is new for this repo.** The OTel contrib distribution image (`0.111.0`) carries it; configuration is single-target, single-job; no operational risk beyond the standard scrape semantics.

## Migration Plan

1. Stand up postgres-exporter in app cluster; verify it serves `/metrics` via `kubectl port-forward`.
2. Add the `prometheus` receiver to app collector ConfigMap; verify both prometheus instances see `pg_stat_database_numbackends` (one path through the gateway delivers to both, so a single query on each grafana validates the fan-out).
3. Generate and apply the prometheus-extra-rules ConfigMap; verify the obs prom `/api/v1/rules` lists the migrated groups.
4. Wire the alertmanager target in obs prom values; verify `/api/v1/alertmanagers` shows the obs alertmanager as `up`.
5. Stand up webhook-sink in obs cluster; verify ClusterIP reachability from an alertmanager pod via `wget -qO- webhook-sink.observability.svc.cluster.local:8080/healthz` (or equivalent).
6. Replace alertmanager values' null receiver with the migrated routing tree; verify `/api/v2/status` reflects the new config.
7. Provision the three dashboards in obs grafana; render each in Browse → Dashboards; compare side-by-side against compose grafana on `:3000`.
8. Manually inject one synthetic firing (rule `vector(1)` or similar) via a throwaway recording-rule edit; confirm the webhook-sink's `/received` records it on both sides.
9. Open the PR. CI runs promtool + diff guard.
