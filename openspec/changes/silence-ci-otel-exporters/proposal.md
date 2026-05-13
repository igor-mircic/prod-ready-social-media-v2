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

### Touched-but-not-modified Capabilities (cited for clarity)

- `observability` — no changes. The slice-3 trace-id / span-id
  propagation contract is unaffected because the agent stays
  loaded; only its network exporters are off.
- `backend-scaffold`, `e2e` — no changes. The env vars never
  reach the application code; nothing in the JAR or test harness
  has to know about this.

## Impact

- **CI:** Modified — `.github/workflows/ci.yml` gains a workflow-level
  `env:` block setting three `OTEL_*_EXPORTER=none` variables.
- **Backend, frontend, e2e source code:** No changes.
- **Dependencies (npm / Gradle):** No changes.
- **Database:** No migrations. No schema changes.
- **Local dev loop:** No changes. The dev compose `observability`
  profile keeps providing the collector at `localhost:4318`; the
  agent's default endpoint resolves locally as before.
- **OpenSpec specs:**
  - Modified at archive time: `openspec/specs/ci/spec.md` — gains
    one new requirement about disabling OTLP network exporters in
    the CI workflow.
