# align-fe-traces-e2e-dev-port — Tasks

## 1. Swap the spawned dev server's port

- [x] 1.1 In `e2e/tests/observability.frontend-traces.spec.ts`, change `const TELEMETRY_PORT = 5174` to `const TELEMETRY_PORT = 5173`. Leave `--strictPort` in place so a busy port fails the test loudly.
- [x] 1.2 Update the explanatory comment block above `TELEMETRY_PORT` to reference the Collector's CORS allowlist as the reason for `5173` (not "avoid 4173 collision") and to call out that `--strictPort` is the intentional fail-fast for the unlikely case where a developer's own `vite dev` already binds the port.
- [x] 1.3 (Discovered during 3.2.) Change the `vite dev` spawn from `--host 127.0.0.1` to `--host localhost` AND switch `TELEMETRY_URL` from `http://127.0.0.1:5173` to `http://localhost:5173`. CORS treats `127.0.0.1` and `localhost` as distinct origins; only the latter is in the Collector allowlist, so the port fix alone leaves the OTLP preflight still rejected. Inline-comment why.

## 2. Tighten Tempo polling

- [x] 2.1 Refactor `pollTempoForTrace` so the exit condition is "the response contains at least one span with `resource.service.name=frontend` AND at least one with `resource.service.name=backend`", not "response has any batches". Keep the existing 30-second total budget and 1-second interval.
- [x] 2.2 On budget exhaustion, throw an error whose message lists which service name(s) were observed and which were still missing (so a future maintainer hitting a real latency / config issue sees the actionable diagnostic).
- [x] 2.3 Verify the test body no longer needs the separate `collectResourceServiceNames` + `expect(...).toContain('frontend')` / `'backend'` assertions after the loop — the loop's own exit invariant covers them. Either remove the redundant assertions or keep them as cheap belt-and-braces (decide locally; if removed, the spec scenario "exactly one assertion that the Tempo trace contains spans from both" is still satisfied by the implicit loop-exit assertion expressed through the thrown error path).
- [x] 2.4 (Discovered during 3.2.) Add `test.setTimeout(120_000)` to the spec. Playwright's default 30s per-test timeout is smaller than the Tempo poll budget alone, so any real ingest delay surfaced as a generic test-timeout instead of as the poll's diagnostic error. 120s comfortably covers UI flow + Tempo poll budget + Loki poll budget.

## 3. Make Loki host-reachable and fix the Loki query

- [x] 3.0 (Discovered during 3.2.) In `docker-compose.yml`, add `ports: ["3100:3100"]` to the `loki` service. Slice 4 brought Loki up without a host port mapping, so the spec's host-side query to `http://localhost:3100/loki/api/v1/query_range` always failed connection-refused. Inline-comment why and call out that Grafana's tracesToLogs pivot keeps using the container DNS name.
- [x] 3.0a (Discovered during 3.2.) Replace the spec's Loki LogQL filter `|~ \`"trace\\.id":"<id>"\`` (flat dotted key) with `|~ \`<id>\`` (substring match on the 32-hex trace id), and replace the regex-based extraction with `line.includes(traceId)`. The backend writes the ECS-nested form `"trace":{"id":"<id>"`, not a flat dotted key, and the loki exporter does not guarantee field order in `attributes` — substring is reliable and immune to both gotchas.

## 4. Local verification with the observability profile up

- [x] 4.1 Ensure `docker-compose --profile observability up -d` is running, `LOG_FILE_PATH` is exported (use the absolute path `$PWD/infra/observability/logs/backend.json` so the spawned backend's CWD does not redirect the file), and `backend/build/libs/backend-*.jar` + `opentelemetry-javaagent.jar` are fresh (run `./gradlew :backend:bootJar` if needed). After editing `docker-compose.yml`, run `docker-compose --profile observability up -d loki` to recreate the Loki container with the new port mapping.
- [x] 4.2 Run `pnpm -C e2e exec playwright test tests/observability.frontend-traces.spec.ts --project=chromium --reporter=list`. Confirmed: 1 passed (test body itself: 3.7s; total wall: ~13s).
- [x] 4.3 The test's own assertions cover what would otherwise be manual Grafana inspection: the Tempo poll exits only when both `service.name=frontend` and `service.name=backend` are present on the same trace.id, and the Loki check confirms the backend log line for that trace.id was ingested. No separate Grafana click-through needed.

## 5. CI verification (observability profile DOWN)

- [ ] 5.1 Push the branch, open a PR, watch CI. Confirm the e2e jobs all pass and that the new spec self-skips on each browser (`tests/observability.frontend-traces.spec.ts` reported as skipped, not failed, on chromium / firefox / webkit).

## 6. Final verification

- [x] 6.1 Run `openspec validate align-fe-traces-e2e-dev-port --type change --strict` from the repo root; reports no errors.
- [x] 6.2 Run `git diff main -- e2e/tests/observability.frontend-traces.spec.ts` and confirm only the port literal, host literal, comment blocks, polling helpers, Loki query, and test-timeout line changed (no churn elsewhere).
- [x] 6.3 Run `git diff main -- infra/ frontend/ backend/` and confirm zero changes in those directories. (Note: `docker-compose.yml` at the repo root is the one infra-adjacent file that DOES change — one `ports:` mapping on the `loki` service. Tracked under §3.)
- [ ] 6.4 Archive the change before merging.
