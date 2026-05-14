# align-fe-traces-e2e-dev-port — Design

## Context

Slice 5 (`add-frontend-traces`) shipped:

- the FE OTel browser SDK, env-gated by `VITE_OTEL_ENABLED`;
- a Collector OTLP/HTTP receiver CORS allowlist of exactly
  `["http://localhost:5173", "http://localhost:4173"]` — the
  canonical Vite dev + preview ports;
- an e2e spec at `e2e/tests/observability.frontend-traces.spec.ts`
  that spawns its own `vite dev` server with `VITE_OTEL_ENABLED=true`
  because the shared e2e harness's `vite preview` build was produced
  without the env var.

The spawned dev server was given port `5174` to sidestep "default
Vite dev port `5173` might be busy" anxieties. That choice was
inconsistent with the Collector's CORS allowlist (which targets the
canonical `5173`/`4173`) and silently broke the spec's whole reason
for existing — the browser's preflight to `:4318/v1/traces` was
rejected, the OTLP POST was dropped, the FE half of the trace
never reached Tempo, and the FE-service-name assertion failed when
a developer ran the suite locally with the observability profile up.

The bug went undetected in CI because CI doesn't run the
observability stack and the spec self-skips on Tempo unreachable.
Local-only failure of a local-only smoke is a particularly hostile
class of regression: CI is green, the developer hits the wall when
they actually try to use the feature.

A second issue stacks on the first: `pollTempoForTrace` returns on
first non-empty response. The backend's batch is exported within
~1 second of the request (the backend agent has its own batch
processor); the FE batch arrives later (its `BatchSpanProcessor`
flush plus the Collector → Tempo path). Even with the CORS fix,
the assertion could race the FE batch's ingest tail on a busy
dev machine. The poll loop needs to wait for both service names,
not for any batch.

## Goals / Non-Goals

**Goals:**

- The e2e spec's spawned `vite dev` server binds to a port that is
  already in the Collector's CORS allowlist, so the browser's
  preflight succeeds and the OTLP POST reaches the Collector.
- The Tempo poll loop tolerates the FE batch's ingest latency by
  continuing to poll until both service names are visible, within
  the same 30-second budget.
- The spec keeps its `test.skip(...)` behaviour when Tempo is
  unreachable — CI continues to skip cleanly.
- One file changes. No infra, no YAML, no backend, no frontend
  source.

**Non-Goals:**

- **Broadening the Collector CORS allowlist.** Adding `5174` would
  let the test's port choice leak into the infra config. The
  allowlist's contract is "two well-known Vite ports"; that should
  not bend to the test.
- **Eliminating the spawned dev server.** A future slice could rebuild
  the frontend with the env var baked in and reuse the harness's
  preview server. That's a larger architectural choice (CI build
  matrix, env-var-at-build vs. env-var-at-dev-serve, etc.) and out
  of scope for this fix.
- **Running the observability stack in CI.** The test still self-
  skips on Tempo unreachable. Bringing the stack up in CI is a
  separate slice with its own cost/benefit (CI minutes, runner
  resources).
- **Tightening other tests.** Only the one spec changes.

## Decisions

### Decision 1: Use port 5173, not add 5174 to the allowlist

Two ways to close the CORS gap:

**(A)** Change the test's `TELEMETRY_PORT` from `5174` → `5173`.
**(B)** Add `http://localhost:5174` to the Collector's
`cors.allowed_origins` list.

We pick **(A)** for three reasons.

First, **narrow contracts beat broad ones**. The Collector's
allowlist names ports a real production-shape deployment would
target. `5173` and `4173` are Vite's own defaults — they describe
"the canonical FE dev origins." `5174` is a test-internal port
the rest of the system has no business knowing about. Keeping the
allowlist at two values preserves the mental model the slice-5
proposal called out: "Vite proxy = same-origin trick for the
backend, full stop." The CORS allowlist mirrors that — "Vite
dev + preview, full stop."

Second, **the test is the natural place to absorb the constraint**.
The test chose to spawn its own dev server; the test must respect
the contract that server's origin participates in. Asking the
infra config to know about the test's port reverses the
dependency direction.

Third, **no observed collision risk**. The shared e2e harness uses
`4173` (preview); nothing else in the repo binds `5173` at e2e-test
time. The `--strictPort` flag the test already passes makes any
future collision fail loudly rather than silently picking a
fallback that would land us back in the CORS-blocked state. If a
developer is running their own `vite dev` on `5173` while running
e2e, the test fails-fast with a clear message — much better than
"all backend, no frontend, why?"

Alternatives considered:

- **Add `5174` to the allowlist.** Rejected: leaks test-port choice
  into infra config; precedent for further allowlist expansion as
  test ports proliferate.
- **Probe an open port at test start and pass it to vite dev.**
  Brittle (the chosen port would need to round-trip into the
  allowlist anyway, which is the same problem), and the test
  loses the "fail-fast on collision" property.
- **Stop spawning a dev server; rebuild the preview dist with the
  env var baked in.** Larger architectural change; out of scope.

### Decision 2: Poll until both service names appear, same 30s budget

The current `pollTempoForTrace` returns on first non-empty
response. With the CORS fix, FE spans will reach Tempo, but the FE
batch arrives later than the BE batch — the loop could exit on
the BE-only intermediate state and the test would fail
intermittently or always (depending on luck).

The polling change is local to the test: keep the same 30-second
total budget and 1-second interval, but compute
`collectResourceServiceNames(trace)` inside the loop and only
exit when both `frontend` and `backend` are present.

We keep the budget at 30s because:

- The slice-5 design recorded `scheduledDelayMillis=500` (FE
  BatchSpanProcessor) and the test passes
  `VITE_OTEL_BATCH_DELAY_MS=200` for the test path — both well
  inside the budget.
- Backend agent and Collector pipeline have their own batch
  intervals; in practice both batches arrive within a few seconds.
- 30s is the slice-3/4 e2e polling shape; staying with it keeps
  the cross-slice cadence uniform.

On budget exhaustion, the test SHALL throw with a message
identifying which service name(s) were still missing — actionable
diagnostics for a future developer who hits a real latency or
config issue.

### Decision 3: One file changes; no Collector / spec / docs side-effects

The test is wrong; everything else is right. The proposal could
have argued for layered changes (e.g. tightening the spec's
CORS-scenario language to mention test-server-port constraints
explicitly, adding a README note about the dev-port contract).
We reject that because:

- The Collector CORS scenarios already cover the allowlist (and
  the `5173`-allowed / disallowed-rejected pair).
- The README's frontend-tracing section documents the
  `VITE_OTEL_ENABLED=true pnpm dev` invocation, which is on the
  canonical `5173` already.
- The fix is one port literal and one helper rewrite. Layering
  doc + spec text on top would be noise.

The spec delta in `specs/observability/spec.md` is a focused
MODIFY of the existing trace-continuity Requirement and adds
two new Scenarios that make the test's invariants explicit, so
a future reader who tries to "simplify" the port choice or the
poll loop has a written-down reason not to.

### Decision 4: Bind/navigate via `localhost`, not `127.0.0.1`

Discovered during local verification: even with the port set to
`5173`, the browser's preflight to the Collector is still rejected
when the page is loaded as `http://127.0.0.1:5173`. CORS treats the
hostname literally — `localhost` and `127.0.0.1` are distinct
origins, and only `http://localhost:5173` is in the Collector
allowlist.

The fix is symmetric and one-line in two places: change the spawn's
`--host 127.0.0.1` to `--host localhost`, and change `TELEMETRY_URL`
from `http://127.0.0.1:5173` to `http://localhost:5173`. On macOS
both names resolve to the same IPv4 loopback, so binding behaviour
is unchanged.

Alternatives considered:

- **Add `http://127.0.0.1:5173` to the Collector allowlist.**
  Rejected for the same reason we rejected adding `5174`: the
  allowlist names "the canonical FE dev origins," not test-host
  literals. Two names for the same loopback would also lock readers
  into wondering which the FE actually uses at runtime.

### Decision 5: Expose Loki on host port 3100 (one-line infra change)

Discovered during local verification: the slice-5 spec queries
`http://localhost:3100/loki/api/v1/query_range` from the Playwright
process running on the host, but slice 4's `docker-compose.yml`
brought Loki up without a `ports:` mapping. Loki is reachable from
inside the Docker network (`http://loki:3100`, used by Grafana's
`tracesToLogs` pivot and by the Collector's loki exporter) but not
from the host. Every local run of the spec failed at the Loki
assertion with `Received: undefined` regardless of correctness on
the FE/Tempo side.

Adding one `ports: ["3100:3100"]` entry on the `loki` service is
the minimum-friction fix: it surfaces Loki the same way Tempo,
Prometheus, Grafana, and the Collector are already surfaced for
direct host-side debugging. CI is unaffected (the observability
profile is not started in CI).

This expands the proposal's original "no infra changes" promise.
The expansion is justified because the proposal's stated goal is
"the slice-5 e2e spec passes when run locally with observability
up," and that goal cannot be reached without the port exposure.
The original "no infra changes" framing was an artifact of an
incomplete pre-implementation read of the spec; the implementation
surfaced the gap.

### Decision 6: Loki query — substring match on the trace id

The slice-5 spec's Loki LogQL filter looks for the flat dotted key
`"trace.id":"…"`, but the backend writes the ECS-nested form
`"trace":{"id":"…"}` (verified in `infra/observability/logs/backend.json`
during local verification). The filter never matched a single line,
so the test's Loki assertion always returned `undefined` locally.

Two options to fix:

**(A)** Match the nested shape exactly: `"trace":\{"id":"<id>"`.
**(B)** Match the bare 32-hex trace id as a substring.

We pick **(B)**. The 32-hex trace id is unique enough that false
positives are impossible in practice, and the substring approach is
immune to two real fragilities of (A):

- The loki exporter emits the `attributes` object with fields in
  alphabetical order (`flags` before `id`), not source order — so
  `"trace":\{"id":...` would still miss the attributes copy of the
  trace id, leaving only the body's escaped JSON to match.
- Backslash-escaping inside the body field (`\"trace\":{\"id\":\"…\"`)
  forces the regex to negotiate two escape layers (LogQL raw string
  → regex → escaped JSON), which is exactly the kind of thing
  future-us will get wrong.

The post-filter in JS (`line.includes(traceId)`) confirms the match
without re-introducing a shape-coupled regex.

## Risks / Trade-offs

[**Risk**: A future test or tool binds `:5173` while e2e runs.]
→ Mitigation: `--strictPort` is already passed to the spawned
vite dev. A collision fails the test immediately with a clear
port-in-use error — louder than the current "FE spans missing
in Tempo, why?" silence. If this becomes a recurring friction,
revisit by introducing a dedicated "telemetry test" port and
adding it to the Collector allowlist with a clear comment about
why.

[**Risk**: The new "both service names" poll exit condition still
times out on a genuinely slow dev machine (e.g. Apple Silicon under
contention from a parallel Docker build).]
→ Mitigation: the 30s budget matches slice-3/4 patterns, which
have been stable. On real timeout the test reports which service
name was missing, so the failure is diagnostic rather than
mysterious. If 30s proves insufficient in practice, bump the
budget — a budget bump is one constant.

[**Trade-off**: We bind to Vite's default dev port, which a
developer running `pnpm dev` alongside `pnpm test` in e2e/ would
collide with.]
→ Mitigation: the test fails loud with a clear "port in use"
message. The developer's choices are obvious: stop the local
`pnpm dev`, or run e2e in a separate workspace. This is no worse
than any other e2e test that wants a fixed backend port.

## Migration Plan

- One commit on a branch (already exists locally:
  `fix-frontend-traces-smoke`, renamed to match the change id
  on commit).
- No CI behavioural change — the test still self-skips when the
  observability stack is down (the default in CI).
- No rollback strategy needed beyond reverting the commit; the
  worst case if this lands incorrectly is the same failure mode
  we have today (local smoke fails, CI green).

## Open Questions

(None.)
