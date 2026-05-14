## Context

The backend bundles the OpenTelemetry Java agent (the slice-3
`add-backend-traces` change attached it to the JVM startup). The
agent's default behaviour is to send OTLP traces, metrics, and logs
to `localhost:4318` over HTTP unless told otherwise. On a developer's
machine, `docker compose --profile observability up` provides an
OTel Collector listening on that port, so the default endpoint
works and spans flow into the local backend store.

CI does not run that collector. There is no consumer of the traces;
they exist purely as a learning surface in the dev loop. The agent's
`HttpExporter` retries the export indefinitely, logging a `WARN` /
`ERROR` line every retry. On a typical CI run the noise looks like:

```
[otel.javaagent ...] [OkHttp http://localhost:4318/...] ERROR
io.opentelemetry.exporter.internal.http.HttpExporter
- Failed to export spans. The request could not be executed.
  Full error message: Failed to connect to localhost/[0:0:0:0:0:0:0:1]:4318
java.net.ConnectException: Failed to connect to localhost/[0:0:0:0:0:0:0:1]:4318
  Suppressed: java.net.ConnectException: Failed to connect to localhost/127.0.0.1:4318
```

This appears in any CI step that boots the backend JVM:
`backend > Run backend tests` (the test JVM), `backend > Generate
OpenAPI spec` (the springdoc bootstrap JVM), and `e2e > Run
Playwright` (the bootJar process the harness spawns). The errors do
not fail the build — the exporter retries silently — but they bury
the actually-interesting log lines.

The OTel SDK supports turning exporters off via environment
variables read at JVM startup. Setting `OTEL_TRACES_EXPORTER=none`
disables the trace exporter; metrics and logs have analogous knobs.
The variables are read by the agent itself, so no application code
or Spring configuration needs to know about them.

## Goals / Non-Goals

**Goals:**

- The CI run log is free of `OTel Failed to export spans /
  ConnectException` lines, in every job that boots the backend
  JVM (backend job's test + openapi-drift steps and the e2e
  job's Run Playwright step).
- The OTel agent itself stays attached. Slice-3's `trace.id` /
  `span.id` MDC keys, which the backend log layout includes
  (`add-log-shipping` slice 4), continue to be populated because
  the agent still creates and propagates spans in-process.
- The dev loop is unchanged. Developers running the backend
  locally (with or without the observability compose profile)
  see no behaviour difference.
- The fix is one workflow YAML edit. No Java code, Spring
  config, or build-script change.

**Non-Goals:**

- Running a real OTLP collector in CI. No consumer of the data
  exists today.
- Disabling the agent entirely (e.g., via `-Dotel.javaagent.enabled=false`
  or by removing the agent jar from the bootJar classpath). The
  agent is what supplies the `trace.id` / `span.id` MDC keys; we
  want those to keep working.
- Suppressing the noise at the log-output layer (e.g., grep -v).
  That hides the symptom while keeping the cost (network
  retries, OkHttp threadpool churn) and would be brittle to log-
  format changes.
- Touching the frontend job. The frontend job runs Node, not the
  JVM; the agent does not load there.

## Decisions

### Decision 1: Use `OTEL_*_EXPORTER=none` for all three signals

**Chosen:** Set three workflow env vars:

```yaml
env:
  OTEL_TRACES_EXPORTER: none
  OTEL_METRICS_EXPORTER: none
  OTEL_LOGS_EXPORTER: none
```

These tell the agent "do not register a network exporter for this
signal type". The agent still loads, instruments the JVM,
propagates context, and populates the MDC. Only the network call
on the `OkHttp` exporter thread is suppressed.

**Alternative A: `OTEL_SDK_DISABLED=true`.** Disables the SDK
wholesale — no spans created, no MDC keys populated. Breaks the
log layout's `trace.id` / `span.id` fields in CI logs, which
would diverge from prod and dev. Rejected.

**Alternative B: `-Dotel.javaagent.enabled=false` (JVM arg).**
Same effect as `OTEL_SDK_DISABLED` plus harder to thread through
the test launcher's command line. Rejected.

**Alternative C: `OTEL_EXPORTER_OTLP_PROTOCOL=...` or
`OTEL_EXPORTER_OTLP_ENDPOINT=http://0.0.0.0:0`.** Both still
attempt a connection, just to a different (still failing)
target. Trades one set of errors for another. Rejected.

**Alternative D: Set only `OTEL_TRACES_EXPORTER=none`.** Closes
the loudest exporter but leaves metrics and logs exporters
free to retry their own connection attempts as soon as the
agent extends its default config. Cheaper to set all three at
once than to chase regressions. Rejected.

### Decision 2: Set the env at the workflow level, not per job

**Chosen:** Put the `env:` block at the top of
`.github/workflows/ci.yml`, outside any `jobs:` entry. GitHub
Actions makes top-level `env` available to every step in every
job; the variables are inherited cleanly.

**Alternative A: Per-job `env:`.** Repeats the three vars on
the `backend` and `e2e` jobs. Three extra lines per job, easy
to forget on a new JVM-using job added later. Rejected for
maintenance reasons.

**Alternative B: Per-step `env:` only on JVM-touching steps.**
Tightest scope but most fragile: every future step that touches
a JVM (a smoke step, a profiling step, a flakiness diagnostic
step) would have to remember to set the vars. Rejected.

**Alternative C: Set the vars from a CI-only Spring profile.**
The OTel agent reads its config from env vars and system
properties before Spring boots, so a Spring profile does not
help; the exporter would already be wired by the time
`application-ci.yml` is loaded. Rejected on correctness grounds.

### Decision 3 (added during implementation): Fix `build.gradle.kts` to honour parent-env OTEL_* values

**Chosen:** Gate the `otelEnvDefaults.forEach { (k, v) -> environment(k, v) }`
block in `backend/build.gradle.kts` on `System.getenv(k) == null`,
so the build's defaults only apply when the parent env has not
already named the key.

Empirical observation during implementation: the workflow-level
env block from Decision 2 reaches the `Run backend tests`,
`Generate OpenAPI spec`, and `Run Playwright` steps' direct
process environments. It does NOT reach the JVMs Gradle forks
for `bootRun` and `test`, because Gradle's
`JavaForkOptions.environment(k, v)` unconditionally overrides
the parent env. The result was 3 OTel-error lines in
`Generate OpenAPI spec` and 120 across the three e2e legs on the
first attempt, despite the workflow env being correct.

The slice-3 observability spec at
`openspec/specs/observability/spec.md:530` already says the
defaults are "overridable at runtime". The build's current
unconditional `.environment(k, v)` calls violate that wording.
Adding the `System.getenv(k) == null` guard fixes the bug and
makes the spec's overridability contract verifiable.

The e2e harness at `e2e/src/setup/backend.ts:99-106` has the
same anti-pattern in a different language: it spreads
`...process.env` into the spawn's env object and THEN lists
the OTel keys with literal values, so the harness's defaults
override parent env on the spawned JVM. Same fix in TypeScript:
`OTEL_TRACES_EXPORTER: process.env.OTEL_TRACES_EXPORTER ?? 'otlp'`,
so the harness's default applies only when the parent env did
not name the key. The harness's harness-specific overrides
(`SPRING_DATASOURCE_URL`, `APP_AUTH_*`) stay forced — they are
intentionally not overridable from outside.

**Alternative A: `JAVA_TOOL_OPTIONS=-Dotel.traces.exporter=none`
at the workflow level.** OTel SDK reads JVM system properties as
well as env vars, and system properties win over env vars in the
SDK's config resolution. JAVA_TOOL_OPTIONS is auto-honoured by
every JVM the runner starts, including Gradle's forks. Stays
within the original "CI-only" scope. Costs: a `Picked up
JAVA_TOOL_OPTIONS: …` line on every JVM startup (small new
noise, ironic given the goal); uses a different config mechanism
(system properties) than the existing build script (env vars),
which is harder to read. Rejected — Option A (fix the build) is
a smaller diff with no new noise.

**Alternative B: leave the build alone, accept that the
workflow env vars only silence the e2e bootJar (which is not
Gradle-forked) and live with the backend job's OTel noise.**
Half-measure; would leave the `Generate OpenAPI spec` step
still spewing errors. Rejected.

**Why the existing "overridable at runtime" wording is correct
and the build needs fixing, not the spec:** the spec authors
clearly intended overridability — the wording, the scenario
name ("Build wires the documented OTEL_* **defaults**"), and
the inline build comment at line 94-95 ("Each is **overridable
by a real env var** when running outside Gradle") all say
defaults. The current unconditional `.environment(k, v)` is
the inconsistent piece.

### Decision 4: Keep the dev compose collector

**Chosen:** No change to `docker-compose.yml`'s `observability`
profile. The dev loop's collector listens on `localhost:4318`
and is reached by the default (env-var-free) OTel agent
endpoint. Disabling the exporters in CI does not change the
dev path because the env vars do not exist on a developer's
shell.

This is the property the design relies on: the workflow YAML's
`env:` block is scoped to the GitHub Actions runner, not the
developer's machine. No risk of the env vars leaking into
local dev.

## Risks / Trade-offs

- **Risk:** A future change wants to assert in CI that traces
  are being emitted (e.g., a contract test against the OTel
  collector). → **Mitigation:** That change can override the
  env vars at the step or job level — workflow-level env is
  the lowest precedence in GitHub Actions, so a step-level
  override wins. Documented in the design so future authors
  see the escape hatch.

- **Risk:** A future Spring change reads `OTEL_TRACES_EXPORTER`
  directly (not via the agent) and crashes on `none`. →
  **Mitigation:** `none` is the documented sentinel in the
  OTel SDK spec; SDK-aware code paths recognise it. Spring
  itself does not read these variables. If a future direct
  consumer emerges, it can set `OTEL_TRACES_EXPORTER=logging`
  (stdout exporter) instead — same noise-suppression effect
  on the network, but emits to logs which the OTel SDK can
  pipe to a NopExporter.

- **Risk:** Workflow-level env vars sometimes get shadowed by
  a step's `env:` block that does NOT redeclare them (the
  step inherits but a child process started in a sub-shell
  may not). → **Mitigation:** Top-level env vars in
  `.github/workflows/*.yml` are exported into the step's
  process environment by the GitHub Actions runner before the
  step command runs; child JVMs spawned from that step (the
  Gradle test executor, the springdoc CLI, the harness's
  bootJar spawn) inherit them through the standard env
  inheritance chain. Verified by the empirical CI run that
  closes this change.

- **Trade-off accepted:** Two-config drift between dev and CI.
  Dev has exporters enabled (talking to the local collector);
  CI has them disabled. The dev compose profile and the CI
  env-var block name the same OTel SDK control points, so a
  reader who looks at one can find the other.
