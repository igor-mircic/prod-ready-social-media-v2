## 1. CI — add the workflow-level env block

- [x] 1.1 In `.github/workflows/ci.yml`, add a top-level `env:` block (outside `jobs:`) immediately after the `on:` block. The block SHALL contain three keys: `OTEL_TRACES_EXPORTER: none`, `OTEL_METRICS_EXPORTER: none`, `OTEL_LOGS_EXPORTER: none`.
- [x] 1.2 Confirm the block is placed at the workflow root (sibling of `on:` and `jobs:`), not nested under a job — this guarantees inheritance by every step in every job per GitHub Actions env precedence.
- [x] 1.3 Add a short inline comment above the block linking to the design's reasoning (one line; keep the file readable).

## 2. CI — guardrails the spec calls out

- [x] 2.1 Confirm the workflow does NOT set `OTEL_SDK_DISABLED=true` anywhere (workflow env, job env, step env).
- [x] 2.2 Confirm no backend or e2e step passes `-Dotel.javaagent.enabled=false` on a JVM command line. The agent stays loaded; only its exporters are disabled.

## 2b. Backend build — honour parent-env OTEL_* overrides

- [x] 2b.1 In `backend/build.gradle.kts`, gate the `otelEnvDefaults.forEach { (k, v) -> environment(k, v) }` block in both the `bootRun` and `test` task configurations on `System.getenv(k) == null`, so the defaults only apply when the parent env has not already named the key. Keep the existing comment about the defaults being "overridable by a real env var when running outside Gradle" — and refresh it to note that overridability now holds inside Gradle too.
- [ ] 2b.2 Confirm `./gradlew test` from `backend/` still passes locally — proves the test JVM still gets the defaults when the parent shell has no `OTEL_*` exports.

## 2c. e2e harness — honour parent-env OTEL_* overrides on the bootJar spawn

- [x] 2c.1 In `e2e/src/setup/backend.ts`, change each `OTEL_*` literal in the `startBackend()` `env:` block from `OTEL_X: 'literal'` to `OTEL_X: process.env.OTEL_X ?? 'literal'`, so the harness's defaults yield to whatever the parent env named. Leave the non-OTel overrides (`SPRING_DATASOURCE_URL`, `APP_AUTH_REFRESH_COOKIE_SECURE`, `APP_AUTH_ACCESS_TOKEN_TTL`) unchanged — those are intentionally harness-controlled.
- [x] 2c.2 Refresh the inline comment block (currently lines 96-98) so it no longer claims "the agent's OTLP exporter logs a connection-refused warning and continues" — under the fix, parent env may override `OTEL_TRACES_EXPORTER` to `none` and silence the exporter entirely.

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
