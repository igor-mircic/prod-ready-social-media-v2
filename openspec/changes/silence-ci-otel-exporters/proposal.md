# silence-ci-otel-exporters

## Why

The backend's OpenTelemetry Java agent is loaded on every JVM the
backend job runs and on the bootJar the e2e job boots via the harness.
With no OTLP collector listening on `localhost:4318` in CI, the
agent's `HttpExporter` logs a steady stream of
`Failed to export spans … java.net.ConnectException: Failed to connect to localhost/[0:0:0:0:0:0:0:1]:4318`
every few seconds. The noise predates the `containerize-e2e-job`
change — the same error appears on the latest main-branch CI run in
the backend job's `Run backend tests` and `Generate OpenAPI spec`
steps and in the e2e job's `Run Playwright` step. It buries real
log content, makes triage harder, and gives the false impression
that something is broken when CI is in fact green.

The dev loop is unaffected: `docker compose --profile observability up`
provides a real OTLP collector at `localhost:4318`, so the agent's
default endpoint resolves on a developer's machine. CI never wires
that collector up, and we have no consumer of the data in CI, so the
fix is to tell the agent not to export at all in CI.

## What Changes

- **CI — set `OTEL_*_EXPORTER=none` at the workflow level.** Add a
  top-level `env:` block in `.github/workflows/ci.yml` with
  `OTEL_TRACES_EXPORTER: none`, `OTEL_METRICS_EXPORTER: none`, and
  `OTEL_LOGS_EXPORTER: none`. Workflow-level env applies to every
  step in every job, so the JVMs in `backend (test + openapi drift)`
  and `e2e (${{ matrix.browser }})` both inherit it. The agent stays
  loaded — only the network exporters are disabled. In-process
  trace-context propagation and the `trace.id` / `span.id` MDC keys
  the slice-3 spec relies on continue to work.
- **Backend — `build.gradle.kts` honours parent-env OTEL_* overrides
  on `bootRun` and `test`.** The slice-3 obs spec already says the
  defaults are "overridable at runtime", but the current build calls
  `JavaForkOptions.environment(k, v)` unconditionally — which silently
  overrides whatever the parent shell set. Gate the
  `otelEnvDefaults.forEach { … environment(k, v) }` block with a
  `System.getenv(k) == null` check so the defaults only apply when
  the parent env has not already named the key. This aligns the build
  with the spec's existing wording and is what makes the CI workflow
  env vars above actually take effect on the Gradle-forked test and
  springdoc JVMs. No change to local dev: developers do not export
  `OTEL_TRACES_EXPORTER` in their shell, so the build's defaults still
  apply there.

### Explicit non-goals (deferred to follow-ups)

- **Standing up a real OTLP collector in CI.** No consumer of the
  data; the dev loop already covers the local debugging case.
  Reconsider when there is a use case (e.g., a hosted trace store
  for nightly performance regression dashboards).
- **Touching the backend's Spring config or any Java code.** The
  OTel agent reads these env vars directly at JVM startup; no app
  code path is involved.
- **Changing the dev compose profile or local-dev behaviour.** The
  env vars live entirely inside the CI workflow YAML; developers'
  local JVMs continue to use the agent's default OTLP endpoint and
  the dev-loop compose collector continues to receive spans.
- **Adding a similar suppression for the frontend job.** The
  frontend job runs Node, not a JVM; the OTel Java agent is not
  loaded; no suppression needed.

## Capabilities

### Modified Capabilities

- `ci` — adds one requirement to the existing CI workflow spec
  capturing that the workflow disables OTLP network exporters so
  the agent does not log connection errors against a non-existent
  collector. No existing requirements are removed or renamed.
- `observability` — modifies one requirement ("Agent ships spans
  only; metrics and logs OTLP exporters are explicitly disabled")
  to add a scenario asserting that the documented `bootRun` / `test`
  OTEL_* defaults are only applied when the parent env does not
  already name the key — making the spec's existing "overridable
  at runtime" wording verifiable.

### Touched-but-not-modified Capabilities (cited for clarity)

- `backend-scaffold`, `e2e` — no changes. The env vars never
  reach the application code; nothing in the JAR or test harness
  has to know about this.

## Impact

- **CI:** Modified — `.github/workflows/ci.yml` gains a workflow-level
  `env:` block setting three `OTEL_*_EXPORTER=none` variables.
- **Backend build:** Modified — `backend/build.gradle.kts`'s
  `otelEnvDefaults` loop now skips keys already set in the parent
  env, so the CI workflow's overrides actually reach the forked
  test / springdoc JVMs.
- **Backend, frontend, e2e source code:** No changes (the build
  script is build config, not application source).
- **Dependencies (npm / Gradle):** No changes.
- **Database:** No migrations. No schema changes.
- **Local dev loop:** No changes. Developers do not export
  `OTEL_*` vars in their shell; the build script's defaults still
  apply, and the dev compose `observability` profile keeps providing
  the collector at `localhost:4318`.
- **OpenSpec specs:**
  - Modified at archive time:
    - `openspec/specs/ci/spec.md` — gains one new requirement about
      disabling OTLP network exporters in the CI workflow.
    - `openspec/specs/observability/spec.md` — gains one new scenario
      under the existing "Agent ships spans only; metrics and logs
      OTLP exporters are explicitly disabled" requirement, asserting
      that parent-env values override the build's defaults.
