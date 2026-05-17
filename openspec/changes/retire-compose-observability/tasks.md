## 1. Relocate cross-consumer files to their consumer-local homes

- [ ] 1.1 `git mv infra/observability/certs/ infra/certs/` — move `ca.crt`, `ca.key` (uncommitted in git but present locally), `openssl.cnf` wholesale; verify `git status` shows the rename (not a delete + add).
- [ ] 1.2 `git mv infra/observability/runbooks/ infra/runbooks/` — all 17 markdown stubs (including the three container-saturation stubs that the follow-up slice will link).
- [ ] 1.3 `mkdir -p infra/k8s-obs/base/webhook-sink/src/ && git mv infra/observability/webhook-sink/* infra/k8s-obs/base/webhook-sink/src/` — Dockerfile + Node sources; preserve every file in the directory.
- [ ] 1.4 `git mv infra/observability/postgres-exporter/queries.yaml infra/k8s/base/postgres-exporter/queries.yaml` — single file move.
- [ ] 1.5 `mkdir -p infra/k8s/base/postgres/init/ && git mv infra/observability/postgres/init/01-pg-stat-statements.sql infra/k8s/base/postgres/init/01-pg-stat-statements.sql` — single file move.
- [ ] 1.6 `mkdir -p infra/k8s-obs/base/prometheus/tests/ && git mv infra/observability/prometheus/rules/slo-tests.yml infra/observability/prometheus/rules/fe-slo-tests.yml infra/observability/prometheus/rules/database-tests.yml infra/observability/prometheus/rules/container-tests.yml infra/k8s-obs/base/prometheus/tests/` — four promtool test fixtures.
- [ ] 1.7 Audit each relocated `*-tests.yml` for `rule_files:` references; update relative paths in lock-step so each fixture finds its target rule file under `../rules/<file>.yml` (or the path the relocated layout requires); run `promtool test rules infra/k8s-obs/base/prometheus/tests/*.yml` locally and confirm pass.

## 2. Update consumers of the relocated files

- [ ] 2.1 `infra/k8s/base/postgres-exporter/kustomization.yaml` — change the `configMapGenerator:` `files:` entry from `queries.yaml=../../../observability/postgres-exporter/queries.yaml` to `queries.yaml` (local sibling). Rewrite the file's header comment block to remove the "parity window" / "relocates in 22b" language; rewrite to describe the obs-only steady state.
- [ ] 2.2 `infra/k8s/base/postgres/values.yaml` — update the path reference for `01-pg-stat-statements.sql` from `infra/observability/postgres/init/...` to `infra/k8s/base/postgres/init/01-pg-stat-statements.sql`; check any neighbouring kustomization / Helm `initdb` mount and update in lock-step.
- [ ] 2.3 Every `runbook_url` annotation in `infra/k8s-obs/base/prometheus/rules/*.yml` — replace the path component `infra/observability/runbooks/` with `infra/runbooks/`; preserve the host (`github.com/igor-mircic/prod-ready-social-media-v2`), the `blob/main` branch reference, and the file basenames.
- [ ] 2.4 `justfile` — change `OBS_CERTS_CA_DIR := "infra/observability/certs"` to `OBS_CERTS_CA_DIR := "infra/certs"` (around line 39); change the webhook-sink image build path from `infra/observability/webhook-sink` to `infra/k8s-obs/base/webhook-sink/src` (around line 547); update any other recipe path references caught by `grep -n "infra/observability" justfile`.
- [ ] 2.5 Delete obsolete justfile recipes if any: `compose-observability-up`, `compose-observability-down`, the compose-side `webhook-received` (preserve `obs-webhook-sink-received`).

## 3. Collapse the app collector to obs-only

- [ ] 3.1 `infra/k8s/base/collector/configmap.yaml` — remove the `otlp/compose-relay`, `otlphttp/compose-relay-logs`, and `otlphttp/compose-relay-metrics` exporter declarations (and any associated comments).
- [ ] 3.2 Remove the same three exporter names from the `service.pipelines.traces.exporters`, `service.pipelines.logs.exporters`, and `service.pipelines.metrics.exporters` lists; each list collapses to a single obs-cluster destination.
- [ ] 3.3 Rewrite the file's header comment block (currently lines 1–50ish) to describe the obs-only topology; drop references to dual-write and compose-relay; reference slice 22b as the slice that collapsed the dual-write.
- [ ] 3.4 `kubectl --context k3s-app apply -k infra/k8s/overlays/local/` (or `just up`) locally and confirm the app collector pod restarts cleanly and that no `tls: handshake error` lines appear in the new pod's logs against the obs-cluster exporters; `obs grafana → Explore → Tempo` shows new backend traces.

## 4. Add the five new Lima portForwards on the obs VM

- [ ] 4.1 `infra/lima/obs.yaml` — under `portForwards:`, insert the five new entries before the catch-all `ignore: true` rule: `9090→9090`, `3200→3200`, `3100→3100`, `9093→9093`, `8080→8081` — each with `guestIP: 0.0.0.0`.
- [ ] 4.2 Apply to the running obs VM via `limactl edit --set ...` (exact form to be captured in tasks-step verification) or recreate via `limactl stop obs && limactl start obs`.
- [ ] 4.3 Verify each new host port reaches the corresponding obs Service: `curl -sS http://localhost:9090/-/healthy`, `curl -sS http://localhost:3200/ready`, `curl -sS http://localhost:3100/ready`, `curl -sS http://localhost:9093/-/healthy`, `curl -sS http://localhost:8081/healthz` — every response 2xx.

## 5. Retarget the five observability e2e specs

- [ ] 5.1 `e2e/tests/observability.alerting.spec.ts` — no URL constant changes; update header comments referencing "the local observability profile" to describe the obs cluster.
- [ ] 5.2 `e2e/tests/observability.frontend-traces.spec.ts` — no URL constant changes; update header comments.
- [ ] 5.3 `e2e/tests/observability.metric-exemplars.spec.ts` — no URL constant changes; update header comments.
- [ ] 5.4 `e2e/tests/observability.frontend-rum-metrics.spec.ts` — remove `COLLECTOR_PROM_URL = 'http://localhost:8889/metrics'` and the assertion(s) that read from it. Replace those assertions with prom queries on `http://localhost:9090/api/v1/query?query=...` for the same series. Grow the poll-until-found budget by one prom scrape interval (~15s, so go from whatever the current N seconds is to N+15s, or simplify to a single ≥30s budget). Update the self-skip predicate to test obs prom reachability only (drop the `:8889` check). Update header comments accordingly.
- [ ] 5.5 `e2e/tests/observability.frontend-errors.spec.ts` — same `:8889` removal; switch the assertion shape from "metric appeared at collector" to "metric appeared at obs prom"; keep the Loki and Tempo queries (they continue to resolve via the new Lima portForwards). Update the self-skip predicate and header comments.
- [ ] 5.6 Run the full obs e2e shard locally: `pnpm --filter e2e exec playwright test --grep observability` (or equivalent invocation) — all 5 specs pass against the obs cluster. Re-run firefox if firefox flakes per the known flake family.

## 6. Update CI workflow

- [ ] 6.1 `.github/workflows/ci.yml` — drop the slice-22a `diff -q` step (the loop comparing `infra/observability/prometheus/rules/X.yml` with `infra/k8s-obs/base/prometheus/rules/X.yml` for the five files).
- [ ] 6.2 Repoint the `promtool check rules` step's file glob from `infra/observability/prometheus/rules/*.yml` to `infra/k8s-obs/base/prometheus/rules/*.yml`.
- [ ] 6.3 Repoint the `promtool test rules` step's working directory or file globs from `infra/observability/prometheus/rules/` to `infra/k8s-obs/base/prometheus/tests/`.
- [ ] 6.4 Verify locally by running the same promtool commands the workflow runs (against the relocated paths) — both `check` and `test` exit 0.

## 7. Delete the compose observability stack

- [ ] 7.1 `docker-compose.yml` — remove the 7 services declared under `profiles: ["observability"]`: `prometheus`, `alertmanager`, `grafana`, `loki`, `tempo`, `webhook-sink`, `postgres-exporter`, `otel-collector` (exact name may differ; identify by `profiles: ["observability"]`). Keep `postgres` and any non-observability services.
- [ ] 7.2 Audit `docker-compose.yml` for stale `depends_on:`, `networks:`, or volume references targeting the removed services; remove dangling fragments so `docker compose config` parses cleanly.
- [ ] 7.3 Delete the now-empty compose-specific subdirectories: `infra/observability/alertmanager/`, `infra/observability/collector/`, `infra/observability/grafana/`, `infra/observability/loki/`, `infra/observability/tempo/`, `infra/observability/prometheus/` (after step 1.6 emptied its `rules/` subdir of test fixtures and step 7.4 emptied the rule files), and `infra/observability/logs/`.
- [ ] 7.4 Delete the six compose-side rule files: `infra/observability/prometheus/rules/{slo-recording,slo-alerting,fe-slo-recording,fe-slo-alerting,database-alerts,container-alerts}.yml` (the obs-side copies at `infra/k8s-obs/base/prometheus/rules/` are the surviving canonical source for the first five; `container-alerts.yml` has no surviving counterpart, per design.md Decision 4).
- [ ] 7.5 Delete the empty `infra/observability/` directory entirely — verify nothing remains via `ls infra/observability/ 2>&1` (should be a "No such file or directory" error).

## 8. README and Hetzner overlay updates

- [ ] 8.1 `README.md` — rewrite the "Opt-in observability stack (default off)" / "Local observability" section near the top to describe the obs-cluster-only run loop: `just obs-up`; the obs grafana URL `http://localhost:3001` with the four provisioned dashboards; the obs prometheus URL `http://localhost:9090`; the obs tempo / loki / alertmanager / webhook-sink URLs; the all-local-dev-only caveat.
- [ ] 8.2 `README.md` — flip the "Forward arc" entry for slice 22b to past tense; flip the next-slice pointer to slice 23 only (no more 22b reference).
- [ ] 8.3 `README.md` — `grep -n "infra/observability" README.md` and update every reference to point at the new locations: `certs/` → `infra/certs/`; `runbooks/` → `infra/runbooks/`; `webhook-sink/` → `infra/k8s-obs/base/webhook-sink/src/`; `postgres-exporter/queries.yaml` → `infra/k8s/base/postgres-exporter/queries.yaml`; `postgres/init/...` → `infra/k8s/base/postgres/init/...`; `collector/collector-config.yaml` reference deleted; `prometheus/prometheus.yml` reference deleted; rule-file references updated to `infra/k8s-obs/base/prometheus/rules/`.
- [ ] 8.4 `README.md` — flip the `LOG_FILE_PATH` example from `./infra/observability/logs/backend.json` to `/tmp/backend.json`; update the surrounding prose to drop the "committed directory" sentence.
- [ ] 8.5 `README.md` — delete the compose-observability cost paragraph if any survives in the "Cost of the two-VM shape" section; the only remaining cost is the two k3s VMs.
- [ ] 8.6 `README.md` — add a "Migration from slice 22a" paragraph naming the directory moves (certs, runbooks, queries.yaml, postgres init SQL, webhook-sink sources, promtool fixtures), the docker-compose profile deletion, the Lima portForward additions, and the e2e spec assertion changes — so a developer on a stale checkout knows what they're walking into.
- [ ] 8.7 `infra/k8s/overlays/hetzner/kustomization.yaml` (and the obs-cluster counterpart at `infra/k8s-obs/overlays/hetzner/kustomization.yaml`) — extend the existing commented stub blocks to flag the slice-22b follow-ups: cert-manager replacing the self-signed CA in `infra/certs/`, real DNS for the obs-cluster endpoints replacing the Lima portForwards, the deferred container-alerts rewrite as a prerequisite for prod alerting parity.

## 9. End-to-end verification

- [ ] 9.1 `kustomize build infra/k8s/overlays/local/ > /dev/null && kustomize build infra/k8s-obs/base/ > /dev/null` — both render without error after every kustomization path update.
- [ ] 9.2 `docker compose config > /dev/null` — compose still parses (no dangling refs to deleted services).
- [ ] 9.3 `docker compose up -d postgres && docker compose ps` — postgres still comes up alone under the default invocation.
- [ ] 9.4 `just obs-up` from a clean state (or rerun on an already-up obs VM) — the cluster stands up, all LGTM pods are Running, all four dashboards visible in obs grafana on `:3001`.
- [ ] 9.5 Manually fire one synthetic alert (vector-rule edit or alertmanager amtool) and confirm it lands in the obs webhook-sink: `just obs-webhook-sink-received` returns the body.
- [ ] 9.6 Manually trigger an FE error from a browser session pointed at the FE-on-k3s (slice 16 nginx) and confirm: (a) the error appears in obs grafana → Explore → Loki for `service.name=frontend`; (b) the `frontend_errors_total` counter increments in obs prom; (c) the trace pivots from Tempo to Loki via the slice-18b correlation.
- [ ] 9.7 Run `pnpm --filter e2e exec playwright test --grep observability` — all 5 obs e2e specs green; re-run firefox if the known flake family bites.
- [ ] 9.8 `git grep -n "infra/observability"` — only references should be in `openspec/changes/archive/` (historical slice records) and in the slice 22b proposal itself (referencing the deletion). No live code or config retains the path.

## 10. OpenSpec validation, branch, commit

- [ ] 10.1 `openspec validate retire-compose-observability --strict` — exits 0.
- [ ] 10.2 Branch from `main` named `retire-compose-observability` and commit the proposal + design + specs + tasks (proposal-only commit per the user's `feedback_branch_commit_proposal_first.md`). (This step usually runs at proposal time, before implementation; included here so the apply phase has a clean starting state.)
- [ ] 10.3 (Implementation commit) After steps 1–9 are done, commit the implementation diff with a clear message. Run `openspec archive retire-compose-observability --yes` before PR merge per `feedback_openspec_apply_autonomous_to_merge.md`.
