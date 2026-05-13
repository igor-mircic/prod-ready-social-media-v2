## 1. CI — add the workflow-level env block

- [ ] 1.1 In `.github/workflows/ci.yml`, add a top-level `env:` block (outside `jobs:`) immediately after the `on:` block. The block SHALL contain three keys: `OTEL_TRACES_EXPORTER: none`, `OTEL_METRICS_EXPORTER: none`, `OTEL_LOGS_EXPORTER: none`.
- [ ] 1.2 Confirm the block is placed at the workflow root (sibling of `on:` and `jobs:`), not nested under a job — this guarantees inheritance by every step in every job per GitHub Actions env precedence.
- [ ] 1.3 Add a short inline comment above the block linking to the design's reasoning (one line; keep the file readable).

## 2. CI — guardrails the spec calls out

- [ ] 2.1 Confirm the workflow does NOT set `OTEL_SDK_DISABLED=true` anywhere (workflow env, job env, step env).
- [ ] 2.2 Confirm no backend or e2e step passes `-Dotel.javaagent.enabled=false` on a JVM command line. The agent stays loaded; only its exporters are disabled.

## 3. CI — smoke against the empirical log

- [ ] 3.1 Push the change to a feature branch and open its pull request.
- [ ] 3.2 Confirm the `backend (test + openapi drift)` job's `Run backend tests` log does NOT contain `Failed to export spans` or `ConnectException: Failed to connect to localhost/.*4318`.
- [ ] 3.3 Confirm the same job's `Generate OpenAPI spec` log is similarly clean of OTLP exporter errors.
- [ ] 3.4 Confirm each `e2e (${{ matrix.browser }})` matrix leg's `Run Playwright` log is clean of OTLP exporter errors (the backend bootJar's process logs are interleaved into that step's output).
- [ ] 3.5 Confirm at least one backend application log line in the CI log carries non-empty `trace.id` and `span.id` fields, proving the OTel agent still loads and propagates context (the suppression only disables network exporters).

## 4. Documentation

- [ ] 4.1 No README change is required (the dev loop is unchanged). Confirm no developer-facing doc claims that the CI run produces OTLP traces — if any such claim exists, update it inline to reflect the new CI behaviour.

## 5. OpenSpec hygiene

- [ ] 5.1 Run `openspec validate silence-ci-otel-exporters --strict` and resolve any failures.
- [ ] 5.2 Confirm `git status` shows only `.github/workflows/ci.yml` modified (plus the proposal/design/specs/tasks under `openspec/changes/silence-ci-otel-exporters/`) — no incidental edits.
