# align-fe-traces-e2e-dev-port — Tasks

## 1. Swap the spawned dev server's port

- [ ] 1.1 In `e2e/tests/observability.frontend-traces.spec.ts`, change `const TELEMETRY_PORT = 5174` to `const TELEMETRY_PORT = 5173`. Leave `--strictPort` in place so a busy port fails the test loudly.
- [ ] 1.2 Update the explanatory comment block above `TELEMETRY_PORT` to reference the Collector's CORS allowlist as the reason for `5173` (not "avoid 4173 collision") and to call out that `--strictPort` is the intentional fail-fast for the unlikely case where a developer's own `vite dev` already binds the port.

## 2. Tighten Tempo polling

- [ ] 2.1 Refactor `pollTempoForTrace` so the exit condition is "the response contains at least one span with `resource.service.name=frontend` AND at least one with `resource.service.name=backend`", not "response has any batches". Keep the existing 30-second total budget and 1-second interval.
- [ ] 2.2 On budget exhaustion, throw an error whose message lists which service name(s) were observed and which were still missing (so a future maintainer hitting a real latency / config issue sees the actionable diagnostic).
- [ ] 2.3 Verify the test body no longer needs the separate `collectResourceServiceNames` + `expect(...).toContain('frontend')` / `'backend'` assertions after the loop — the loop's own exit invariant covers them. Either remove the redundant assertions or keep them as cheap belt-and-braces (decide locally; if removed, the spec scenario "exactly one assertion that the Tempo trace contains spans from both" is still satisfied by the implicit loop-exit assertion expressed through the thrown error path).

## 3. Local verification with the observability profile up

- [ ] 3.1 Ensure `docker-compose --profile observability up -d` is running, `LOG_FILE_PATH=./infra/observability/logs/backend.json` is exported, and `backend/build/libs/backend-*.jar` + `opentelemetry-javaagent.jar` are fresh (run `./gradlew :backend:bootJar` if needed).
- [ ] 3.2 Run `pnpm -C e2e exec playwright test tests/observability.frontend-traces.spec.ts --project=chromium --reporter=list`. Confirm one test passes.
- [ ] 3.3 Inspect the Tempo trace in Grafana → Explore → Tempo: confirm both `service.name=frontend` and `service.name=backend` spans are present on the same `trace.id`.
- [ ] 3.4 Inspect the corresponding Loki line in Grafana → Explore → Loki via the `tracesToLogsV2` "Logs for this span" pivot from the Tempo trace view: confirm the line carries the same `trace.id`.

## 4. CI verification (observability profile DOWN)

- [ ] 4.1 Push the branch, open a PR, watch CI. Confirm the e2e jobs all pass and that the new spec self-skips on each browser (`tests/observability.frontend-traces.spec.ts` reported as skipped, not failed, on chromium / firefox / webkit).

## 5. Final verification

- [ ] 5.1 Run `openspec validate align-fe-traces-e2e-dev-port --type change --strict` from the repo root; reports no errors.
- [ ] 5.2 Run `git diff main -- e2e/tests/observability.frontend-traces.spec.ts` and confirm only the port literal, the comment block, and the polling helper changed (no churn elsewhere).
- [ ] 5.3 Run `git diff main -- infra/ frontend/ backend/` and confirm zero changes in those directories.
- [ ] 5.4 Archive the change before merging.
