## 1. Webhook sink container

- [x] 1.1 Create `infra/observability/webhook-sink/` with `package.json` declaring a pinned Express version, no dev dependencies, and a `start` script.
- [x] 1.2 Implement the sink server (~30 lines): `POST /page` and `POST /ticket` append Alertmanager webhook payloads to an in-memory ring tagged with path and receive timestamp; `GET /received?after=<unix-millis>` returns the ring as JSON filtered by timestamp; `GET /healthz` returns `200 ok` for liveness probes.
- [x] 1.3 Write the multi-stage `Dockerfile` (build stage installs deps, runtime stage copies `node_modules` and source; base image pinned to an explicit `node:<version>-alpine` tag).
- [x] 1.4 Write a short `README.md` in the directory naming the three endpoints, the ring size, and how to rebuild the image after a source change.
- [x] 1.5 Add the `webhook-sink` service to `docker-compose.yml` under the `observability` profile: build context, container name `social-webhook-sink`, host port `8081:8080`, joined to the same network as Alertmanager.

## 2. Alertmanager routing tree and inhibition

- [x] 2.1 Rewrite `infra/observability/alertmanager/alertmanager.yml`: replace the `null` receiver with `default`, `page-webhook`, and `ticket-webhook` receivers; declare the severity-based child routes on the top-level `route:`; preserve existing `group_by`/`group_wait`/`group_interval`/`repeat_interval`.
- [x] 2.2 Add `webhook_configs:` to `page-webhook` and `ticket-webhook` targeting `http://webhook-sink:8080/page` and `/ticket` respectively, with `send_resolved: true`.
- [x] 2.3 Add the `inhibit_rules:` block with the single `BackendDown → slo=~".+"` rule and `equal: []`.
- [x] 2.4 Update the file header comment to describe the routing tree, the inhibition rule, and the deferred-but-now-real receiver story.
- [x] 2.5 Verify Alertmanager starts clean against the new config locally (`docker compose --profile observability up -d alertmanager` then check `docker compose logs alertmanager` for parse errors).

## 3. Runbook stubs

- [x] 3.1 Create `infra/observability/runbooks/` with twelve Markdown stub files, one per alert name (`ApiAvailabilityFastBurn.md`, `ApiAvailabilitySlowBurn.md`, `ApiAvailabilityBudgetBurn.md`, `FeedReadLatencyFastBurn.md`, `FeedReadLatencySlowBurn.md`, `PostCreateLatencyFastBurn.md`, `PostCreateLatencySlowBurn.md`, `BackendDown.md`, `LcpSloFastBurn.md`, `LcpSloSlowBurn.md`, `InpSloFastBurn.md`, `InpSloSlowBurn.md`).
- [x] 3.2 Each stub uses H2 headings `Symptoms`, `Impact`, `Triage`, `Mitigation`, `Escalation` (in that order), with at least one bullet or paragraph under each.

## 4. Runbook URL annotations on alerting rules

- [x] 4.1 Add `annotations.runbook_url:` to every alert in `infra/observability/prometheus/rules/slo-alerting.yml` (Api*, FeedRead*, PostCreate*, BackendDown — eight alerts).
- [x] 4.2 Add `annotations.runbook_url:` to every alert in `infra/observability/prometheus/rules/fe-slo-alerting.yml` (Lcp*, Inp* — four alerts).
- [x] 4.3 Confirm each URL ends in `/infra/observability/runbooks/<AlertName>.md` and that the AlertName matches the rule's `alert:` field exactly.

## 5. Promtool fixture assertions

- [x] 5.1 Extend every `exp_alerts:` stanza in `infra/observability/prometheus/rules/slo-tests.yml` with the expected `runbook_url` value under `exp_annotations:`.
- [x] 5.2 Extend every `exp_alerts:` stanza in `infra/observability/prometheus/rules/fe-slo-tests.yml` the same way.
- [x] 5.3 Run `promtool test rules` against the rule directory locally and confirm the build passes.

## 6. End-to-end alerting spec

- [x] 6.1 Create `e2e/tests/observability.alerting.spec.ts` following the slice-9 skip-on-unreachable pattern from `observability.metric-exemplars.spec.ts`.
- [x] 6.2 Implement a `probeReady` for Alertmanager `/-/ready` and the sink `/healthz`; mark the suite skipped in `beforeAll` when either is unreachable.
- [x] 6.3 Implement the `severity=page` routing test: POST a synthetic alert to Alertmanager, poll the sink's `/received?after=<test-start>` for a matching payload on the `/page` path, assert the `runbook_url` annotation is preserved.
- [x] 6.4 Implement the `severity=ticket` routing test in the same shape.
- [x] 6.5 Implement the inhibition test: POST `BackendDown` + `ApiAvailabilityFastBurn` together with `severity=page`; assert only the BackendDown payload is observed.
- [x] 6.6 Verify the spec runs locally against the full observability profile, and verify it skips cleanly when the profile is down.

## 7. README and docs

- [x] 7.1 Update the project README's Alerting subsection: keep the existing surfaces (Alertmanager UI, Grafana Alerting nav, `promtool test rules` one-liner, rule-file restart note); add the webhook-sink subsection (`http://localhost:8081/received`, `docker compose logs webhook-sink`, the page/ticket path split).
- [x] 7.2 Add a one-paragraph note in the README pointing at `infra/observability/runbooks/` and explaining that the stubs are intentionally minimal — real incident learnings should fill them in over time.

## 8. Validate and ship

- [x] 8.1 Run `openspec validate close-alerting-loop --strict` and resolve any findings.
- [x] 8.2 Bring the full observability profile up locally, run the new e2e spec end-to-end, confirm `promtool test rules` still passes.
- [ ] 8.3 Commit on a branch named `close-alerting-loop`, open the PR with the proposal/design/specs/tasks summary, and follow the autonomous-apply workflow through CI to archive.
