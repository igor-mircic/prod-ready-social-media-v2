## Context

This is slice 22b of the seven-slice "compose-to-k3s observability" arc (README §"Forward arc", line 442). Slice 22a (`migrate-obs-content`, merged 2026-05-17) was the migration half: it landed postgres-exporter in the app cluster, webhook-sink in the obs cluster, the five SLO+database rule files into obs prom, the alertmanager routing tree, and the backend/frontend/database dashboards into obs grafana — with compose still running so an operator could render the same dashboards on `:3000` and `:3001` side-by-side and verify parity. 22b is the retirement half: now that parity is proven, compose observability is deleted, the app collector's dual-write fan-out collapses to obs-only, and a small set of files that lived under `infra/observability/` but were not actually compose-specific relocate to live next to their real consumers.

**Where the system is today (post-slice-22a):**

- Two prometheuses (compose `:9090`, obs cluster) carry the same series via the app collector's three-exporter fan-out (compose-relay + obs-cluster legs, per slice 18a–c).
- Both prometheuses load the same five rule files (compose from `infra/observability/prometheus/rules/`, obs from `infra/k8s-obs/base/prometheus/rules/` — kept byte-identical by a CI `diff -q` guard introduced in slice 22a Decision 5).
- Both alertmanagers fire the same alerts; both routing trees deliver to a webhook-sink (compose on `:8081`, obs cluster on `:8080` in-namespace).
- Three grafanas worth of dashboards exist; compose grafana on `:3000` and obs grafana on `:3001` render the same backend/frontend/database panels.
- The app collector's ConfigMap (`infra/k8s/base/collector/configmap.yaml`) has three `*compose-relay*` exporters and three `*obs-cluster*` exporters; the traces/logs/metrics pipelines fan out to both.
- The five observability e2e specs (`observability.{alerting,frontend-traces,frontend-rum-metrics,metric-exemplars,frontend-errors}.spec.ts`) target compose endpoints on the host (`localhost:9090/3200/3100/9093/8081/8889`).
- `infra/observability/` carries a mix of files: compose-only configs (prom/alertmanager/grafana/loki/tempo/collector configs, the six compose-side rule files, the `logs/` mount point) **and** cross-consumer files that are still load-bearing post-compose (the CA root material under `certs/`, the 17 runbook stubs, the postgres-exporter custom-queries YAML, the `pg_stat_statements` init SQL, the webhook-sink Dockerfile + sources, the four promtool test fixtures).

**Constraints inherited from earlier slices:**

- Image pin: `otel/opentelemetry-collector-contrib:0.111.0` for any collector pod (slice 17 baseline).
- No Prometheus Operator / kube-prometheus-stack (README design constraint, lines 432–435).
- Lima 2.x portForwards remapping a k3s LoadBalancer Service port require explicit `guestIP: 0.0.0.0` (project memory: `project_lima_portforward_guestip_required.md`; slice 18c lesson). Existing VMs do not pick up source-YAML edits — use `limactl edit --set` on the running VM after the file lands.
- The arc invariant: each slice independently revertable; visibility-into-the-app-cluster never broken.
- Slice 22a's kustomization at `infra/k8s/base/postgres-exporter/kustomization.yaml` carries an explicit comment block ("Slice 22b retires the compose copy and relocates this YAML under `infra/k8s/base/postgres-exporter/`; the configMapGenerator path swaps at the same time.") — 22b honors that prior commitment.

**Stakeholder reading this design:** the person implementing this slice (the next /apply session) and the operator who will run the post-merge migration steps on their local Lima VMs.

## Goals / Non-Goals

**Goals:**

1. Every compose-side observability container, config file, and rule file is gone from the repo and from `docker compose up`'s reach.
2. The app collector's outbound batch goes to one destination (obs cluster), not two.
3. The five observability e2e specs run green against the obs cluster on `pnpm playwright test`, with the host port surface stable enough that three of the five specs need no URL constant changes (Lima portForwards mirror the compose host-port layout).
4. Every surviving file from `infra/observability/` lives next to its real consumer — no more cross-tree `../../../observability/...` configMapGenerator paths.
5. The `infra/observability/` directory is gone. No new top-level "observability" directory replaces it — the name carried compose-cluster connotations the new layout no longer matches.
6. CI's `prometheus-rules` job continues to validate rule content and run the four promtool test fixtures, with both steps reading from `infra/k8s-obs/base/prometheus/...`.

**Non-Goals:**

- Re-authoring `container-alerts.yml` against OTel-shaped families. Slice 22a Decision 6 named this as a separate follow-up (`add-k8s-container-saturation-alerts`); 22b accepts the gap. The three associated runbook stubs (`ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, `ContainerOomKilled.md`) move to `infra/runbooks/` with the others so the follow-up slice's new rules can link them in place.
- Adding new observability dashboards. The three migrated in 22a are the steady state until a future slice introduces more.
- Touching the obs cluster's chart values for prometheus/alertmanager/grafana beyond what's needed to relocate inputs (e.g., the prometheus values file's `extraConfigmapMounts:` block stays; the alertmanager routing tree stays).
- Repointing `runbook_url` annotations to public GitHub URLs that resolve only after merge to `main`. The annotations already encode `github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/observability/runbooks/...`; 22b swaps the URL path to `infra/runbooks/...` and accepts the standard "URL is dead until the PR merges" window.
- Hetzner deploy. That's slice 23. 22b updates the Hetzner overlay stub comments only.
- Backend or frontend code changes. The two services are untouched.

## Decisions

### Decision 1 — Granular relocation by consumer, not a blanket `infra/observability/` → `infra/certs/` rename

The slice-21 and slice-22a docs hinted at a single rename ("rename `infra/observability/` to `infra/certs/` + relocate `runbooks/`"). Reading the actual file list, the surviving set has six distinct consumers:

```
   File / subtree                              Real consumer
   ─────────────────────────                   ──────────────────────────
   certs/{ca.crt,ca.key,openssl.cnf}           Both clusters (slice-19 mTLS);
                                               justfile recipes
   runbooks/*.md (17 files)                    runbook_url annotations on obs
                                               prom rules
   postgres-exporter/queries.yaml              infra/k8s/base/postgres-exporter
                                               configMapGenerator
   postgres/init/01-pg-stat-statements.sql     infra/k8s/base/postgres/values.yaml
   webhook-sink/ (Dockerfile + Node src)       Image build for
                                               infra/k8s-obs/base/webhook-sink
   prometheus/rules/*-tests.yml (4 fixtures)   CI promtool test rules step
                                               against obs-side rules
```

A blanket rename would just preserve the cross-tree coupling under a new name. Putting each artifact next to its consumer kills the coupling for good and lets each subtree's lifecycle match its workload's lifecycle.

**Alternatives considered:**

- *Rename `infra/observability/` → `infra/certs/`, leave the other survivors under it.* Awkward — the new name describes only one of six consumers; the other five live somewhere whose name is wrong for them. Rejected.
- *Rename `infra/observability/` → `infra/shared/` (or `infra/common/`).* Catch-all bucket name; doesn't tell a reader what's in it. Rejected — the goal is locality, not a new shared bucket.
- *Keep `infra/observability/` as a "no-longer-compose, now-just-shared" directory.* Same problem as the rename variants; the directory name carries dead history. Rejected.
- *Leave `infra/observability/postgres-exporter/queries.yaml` where it is and adjust nothing.* The slice-22a kustomization already promised to swap the configMapGenerator path in 22b ("Slice 22b retires the compose copy and relocates this YAML under `infra/k8s/base/postgres-exporter/`; the configMapGenerator path swaps at the same time."). Breaking that commitment leaves a `../../../observability/...` path in a directory tree where nothing else under `infra/observability/` exists. Rejected.

### Decision 2 — Lima portForward maps host `:8081` → obs guest `:8080`; spec URL constant stays stable

Slice 22a's webhook-sink Deployment exposes a ClusterIP Service on `:8080` (chart-default Express port). Compose's webhook-sink ran on `:8081` on the host. The alerting e2e at `e2e/tests/observability.alerting.spec.ts` (line 21) reads `WEBHOOK_SINK_BASE_URL = 'http://localhost:8081'`.

Three options for resolving the asymmetry:

- **(i) Lima portForward host `:8081` → obs guest `:8080`.** Spec constant unchanged. One YAML line in `infra/lima/obs.yaml` carries the remap.
- **(ii) Lima portForward host `:8080` → obs guest `:8080`.** Spec constant edited from `8081` to `8080`. Cleaner port symmetry but produces a touchier diff (e2e spec changes for what's purely a transport question).
- **(iii) Change the obs webhook-sink Service to listen on `:8081`.** Reaches into slice-22a chart values for cosmetic alignment; the chart default is `:8080`; argues against the slice-22a discipline of "minimal value overrides."

(i) wins. The spec doesn't care which cluster sourced the HTTP body; it cares that POSTs arrive at `localhost:8081/received`. The Lima portForward is a transport detail and the natural place to hide the asymmetry. This also resolves the open question slice 22a Decision 3 left explicit: the alerting spec **retargets** (not retires) to the obs cluster.

The same Lima portForward pattern handles the four other endpoints (prom `:9090`, tempo `:3200`, loki `:3100`, alertmanager `:9093`); for those the host port matches the compose host port and the obs Service port, so no remap arithmetic. The remap-versus-passthrough distinction is webhook-sink-only.

**Alternative considered:** *Use `kubectl port-forward` from the e2e harness rather than Lima portForwards.* Adds a process-management dependency to every spec; couples Playwright to `kubectl`; the Lima route mirrors how the compose specs accessed compose. Rejected on parity and complexity grounds.

### Decision 3 — Drop the `COLLECTOR_PROM_URL :8889` assertions, switch to obs-prom queries

Two FE specs assert against the compose collector's Prometheus-format `/metrics` exposition on `localhost:8889`:

- `observability.frontend-rum-metrics.spec.ts` (line 34)
- `observability.frontend-errors.spec.ts` (line 37)

The assertion shape is: "the metric showed up at the collector before prom scraped it." It's a tightness signal — proving the OTLP push landed without waiting for the scrape interval.

The obs collector's Prometheus exporter is not exposed on the host. Reasons not to expose it:

- It's not a steady-state consumer surface. Obs prom is the single consumer; the obs collector's `prometheus` exporter is internal to the cluster's gateway shape.
- Adding a host-reachable port for a test assertion to scrape would invert the data-plane direction the rest of the arc commits to (everything is push-into-the-collector / pull-from-prom; never pull-from-the-collector externally).
- Hetzner (slice 23) does not want a public collector `/metrics` endpoint. Adding one in 22b would create a deprecation problem 23 has to undo.

So 22b switches the two specs to query obs prom on `:9090` for the same metric series instead of the collector's `:8889`. The query name is identical (RUM metrics carry the same metric name end-to-end); the only material change is the latency budget: prom scrapes every 15s by default, so the spec's poll-until-found window grows by ~one scrape interval.

**Alternative considered:** *Expose the obs collector `prometheus` exporter via a `LoadBalancer` Service + Lima portForward to preserve the `:8889` assertion shape.* See "Reasons not to expose it" above. Rejected — preserving a spec assertion is not worth introducing a surface the production deploy will then have to remove.

### Decision 4 — Container-alerts stay deleted; follow-up slice owns the rewrite

`container-alerts.yml` carries three alerts (`ContainerCpuThrottling`, `ContainerMemoryNearLimit`, `ContainerOomKilled`) keyed on cadvisor-shaped series. Slice 22a Decision 6 deferred the rewrite against slice-21's OTel-shaped families (`k8s_pod_*`, `k8s_container_*`) because the mapping is not 1:1 — CFS throttling is not in kubeletstats at all, and OOM signal is indirect via `k8s_container_last_terminated_reason`.

22b makes the deletion final on the compose side; the file simply does not come along. The corresponding three runbook stubs (`ContainerCpuThrottling.md`, `ContainerMemoryNearLimit.md`, `ContainerOomKilled.md`) move to `infra/runbooks/` with the rest so the follow-up slice doesn't have to re-write them — only re-link from new OTel-shaped rules.

The gap is real on the obs side: no firing alert when a container OOMs or throttles. Mitigations:

- `cluster-overview.json` (slice 21) shows pod CPU/memory/restart saturation visually — an operator inspecting cluster health sees the same pressure, just without a paging signal.
- The local dev cluster's blast radius for a missing container-saturation alert is small (single-node, no on-call).
- Hetzner deploy (slice 23) is bounded — if 23 ships before `add-k8s-container-saturation-alerts`, the Hetzner overlay stub flags the gap so a prod operator knows what's not paging.

**Alternative considered:** *Fold the rewrite into 22b.* Adds promtool test fixtures (synthetic series, expected firings), new runbook content (the runbook stubs would need real text matching the new alert semantics), and updates to `cluster-overview.json` panel queries to align labels. Same size as slices 12 and 13 combined. Wrecks 22b's "delete + repoint" character. Rejected on scope grounds; the follow-up slice was always the design.

### Decision 5 — Delete `infra/observability/logs/` outright; flip the README example to `/tmp/`

The `logs/` directory was a compose-era convenience: `docker-compose.yml` mounted it into the collector container, and the README example for the host-side LOG_FILE_PATH used `./infra/observability/logs/backend.json`. The backend's `application.yaml` (line 31-38) treats `LOG_FILE_PATH` as opt-in — empty value means stdout-only. The committed directory carried only a `.gitignore` rule (`*.json`) so the empty dir survives in git.

22b deletes the directory entirely. The README example flips from `./infra/observability/logs/backend.json` to `/tmp/backend.json` (or equivalent). No code change to `application.yaml` — its env-var-gated behavior is unchanged.

**Alternatives considered:**

- *Move to `backend/logs/`.* Plausible — keeps the example local to the service writing the file. But it puts a runtime artifact directory under a build-tree directory; muddles the gradle module's contents. Rejected.
- *Leave `infra/observability/logs/` intact (as the only thing under `infra/observability/`).* Means `infra/observability/` survives 22b for a `.gitignore` placeholder. Rejected — the whole point of 22b is for that directory to be gone.

### Decision 6 — Runbook URLs update path-only, no domain or branch change

The 17 rule annotations of the form `runbook_url: "https://github.com/igor-mircic/prod-ready-social-media-v2/blob/main/infra/observability/runbooks/<name>.md"` (e.g., `infra/k8s-obs/base/prometheus/rules/database-alerts.yml` lines 33, 46) need their path component updated from `infra/observability/runbooks/` to `infra/runbooks/`. The host (`github.com/igor-mircic/...`), the branch reference (`main`), and the file basenames stay.

The URLs are dead between merge to the PR branch and merge to `main` — this is the same window every existing change has and is accepted by the repo's runbook discipline.

**Alternative considered:** *Switch to relative paths (`./infra/runbooks/<name>.md`) so the URL is always valid in-repo.* Prometheus' alert manager renders `runbook_url` as a literal href; relative paths break click-through from Grafana/Alertmanager UIs. Rejected — the absolute GitHub URL is the right format for the consumer.

## Risks / Trade-offs

- **Many file moves across one PR; reviewer fatigue.** → tasks.md groups by phase (deletions, then relocations, then consumer updates, then CI/Lima/justfile/README) and explicitly flags moves so reviewers don't mis-read them as new files. PR description names the file count and the move-vs-add split.
- **`ca.crt` move could be missed by a developer with a long-running shell whose env points at the old path.** → README migration paragraph names the move; justfile recipes update; slice's verification steps include re-running `just obs-cert-verify` (or the actual recipe name; tasks step that confirms) against the new location.
- **Promtool fixture move risks a path-resolution miss inside the test YAML's `rule_files:` blocks.** → tasks.md includes a "run `promtool test rules` locally with the new paths before opening the PR" step. CI catches it in the worst case.
- **E2E FE-errors and FE-rum-metrics get assertion-shape edits, not URL-only swaps.** → run the full e2e shard locally pre-PR; the project's known firefox-flake family (per memory `project_firefox_flake_posts_composer.md`) is on unrelated specs but be ready to re-run firefox.
- **Lima YAML edits don't take effect on running VMs.** → verification steps explicitly call out `limactl edit --set ...` on the obs VM after the YAML lands; alternative is `limactl stop obs && limactl start obs`.
- **Compose `postgres` service stays but its `depends_on` may reference the removed collector.** → tasks step that audits the compose file for dangling references between deleted and surviving services; remove stale `depends_on`/`networks` blocks if present.
- **The CI promtool test step may need internal-path edits in the test fixture YAML.** → 22a kept the test fixtures byte-identical to compose; their `rule_files:` blocks may use `../slo-recording.yml`-style relative paths that break under the new layout. Tasks step audits and edits the four fixture files in lock-step with the relocation.
- **A developer who pulled 22a but not 22b sees byte-identical rule files on both sides and might assume the diff-guard still runs.** → the CI workflow change is in the same PR as the file deletions; nobody's checkout is in a half-state for longer than `git pull` takes.
- **Container-saturation alerting gap (Decision 4).** → mitigations listed in that decision; `cluster-overview.json` provides visual signal; flagged in Hetzner overlay stub for slice-23 awareness.

## Migration Plan

The slice is delivered as a single PR. Post-merge developer workflow:

1. `docker compose --profile observability down` (clear any compose-observability containers a developer brought up before pulling).
2. `git pull` to `main`. Verify `infra/observability/` is gone and `infra/certs/` + `infra/runbooks/` exist.
3. `limactl edit --set 'values(.portForwards)+=[{"guestPort":...,"hostPort":...,"guestIP":"0.0.0.0"}, ...]' obs` (or equivalent — exact form documented in the README migration paragraph) to apply the five new portForwards to the already-running obs VM. Alternative: `limactl stop obs && limactl start obs` to recreate from the updated YAML.
4. `just obs-up` (re-asserts the cluster manifests; nothing changes if the VM was already up post-edit).
5. Open obs grafana on `:3001` — dashboards render exactly as they did in slice 22a.
6. Run the e2e obs shard locally: `pnpm playwright test --grep observability` — all 5 specs pass against the obs cluster.
7. (Optional) `docker rmi` the cached compose observability images to free disk: `prom/prometheus`, `grafana/grafana`, `grafana/loki`, `grafana/tempo`, `prom/alertmanager`, `quay.io/prometheuscommunity/postgres-exporter` (this last one stays cached because the k8s exporter uses the same image pin).

**Rollback**: single `git revert` restores compose observability. The reverter must also `limactl edit --set` the obs VM's portForwards back to the pre-22b state, or `limactl stop / start` it.

## Open Questions

- **Should `obs-up` recipe gain a portForward-self-check step?** A `limactl shell obs -- ss -tln | grep -E ':(9090|3200|3100|9093|8081)'` (or equivalent) would fail fast if the running VM's portForward set drifted from the YAML. Out of scope for 22b but a natural follow-up — defer to the operator who first re-runs `obs-up` post-merge and feels the need.
- **`infra/runbooks/` location.** Top-level `infra/` keeps the runbooks adjacent to the cluster manifests. An alternative is `docs/runbooks/` to group with docs. 22b commits to `infra/runbooks/`; the `runbook_url` annotations are easy to retarget if a future slice prefers `docs/`.
