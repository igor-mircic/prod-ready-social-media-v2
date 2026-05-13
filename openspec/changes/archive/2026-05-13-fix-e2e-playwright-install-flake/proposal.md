# fix-e2e-playwright-install-flake

## Why

CI's e2e job hangs intermittently on the `Install Playwright browser
(${{ matrix.browser }})` step and rides the 30-minute job-level
timeout all the way to the cliff before being killed. Observed on
PR #26 attempt 1: all three matrix shards (chromium, firefox, webkit)
were cancelled at exactly 30m34s on the install step, with not a
single Playwright test having executed. A subsequent re-run of the
same workflow on the same commit passed cleanly. The hang is
upstream: `pnpm exec playwright install --with-deps <browser>` shells
out to `apt-get`, and `apt-get` blocks on a transiently unreachable
or slow GitHub-hosted apt mirror.

The practical consequences:

- A PR can wait 30 minutes per shard, three shards in parallel, only
  to be told CI failed — with no Playwright report to look at,
  because no test ran. The signal is "the install hung," and the
  diagnostic is "re-run the workflow."
- The required-check status on the PR sits in "pending" for 30
  minutes, which masks faster failures (a backend test breaking on
  the same PR is invisible while the e2e job's hang dominates the
  queue).
- The 30-minute cliff is the *job* timeout. There is no signal that
  *the install step* is the thing hanging — a reader of the run
  summary sees a generic "job exceeded timeout" cancellation, not
  "step exceeded its budget." This makes the failure look unbounded
  in shape when it is actually a known, retryable hang.

The existing requirement at
`openspec/specs/ci/spec.md:227-254` mandates that
`playwright install --with-deps ${{ matrix.browser }}` runs
unconditionally — `playwright install` is a no-op when cached
binaries are present, and `--with-deps` is still needed on every run
because apt-installed system libraries are not covered by the cache.
That requirement remains correct. What is missing is a *bounded*
budget for the install step plus an automatic retry on transient
failure, so a stuck `apt-get` becomes a fast, loud, retried failure
instead of a 30-minute silent stall.

This change wraps the install step with a per-attempt timeout and a
small retry count. The behaviour after this change: on a normal run
the step completes in 1–3 minutes (no change); on a transient apt
hang the step is killed at the 5-minute mark, the same step is
retried (up to three times total), and the job either recovers
inside ~15 minutes worst-case or fails fast with an actionable error.
The 30-minute cliff is no longer the failure surface for an apt
hang.

**Why a step-level timeout + retry, and not the official Playwright
container?** Switching the e2e job to
`container: mcr.microsoft.com/playwright:vX.Y-jammy` would remove
the install step entirely — the image bakes in every browser and
every apt dep. It is the correct long-term fix and is recorded as an
explicit follow-up below. The reason this change does not adopt it
now: Postgres in the e2e job is provisioned by Testcontainers from
inside the JVM started by Playwright's `globalSetup`, and
Testcontainers connects to the host Docker daemon. Running the job
*inside* a container means wiring the host Docker socket through
(`--volume /var/run/docker.sock:/var/run/docker.sock`) and setting
`TESTCONTAINERS_HOST_OVERRIDE` / `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`
so Testcontainers connects to the *outer* daemon, not the
in-container one. That is a non-trivial spec change to the
"Docker is available on the runner" requirement
(`openspec/specs/ci/spec.md:184-198`), plus it adds a renovate-style
sync between the container tag and the `@playwright/test` version in
`e2e/package.json`. Worth doing if flakes recur after this change.
Not worth doing pre-emptively for a single observed incident with a
known mitigation.

**Why not split the install into "install" + "install-deps" gated on
cache-hit?** The cache already covers `~/.cache/ms-playwright` —
i.e., the browser binaries. It does not cover the apt-installed
system libraries (libwoff, libenchant-2-2, libgstreamer-*, etc.)
that Playwright needs for firefox and webkit. Stock `ubuntu-latest`
runners do not carry these. Whether the cache hits or misses,
`apt-get install` still has to run on every fresh runner, and
`apt-get install` is exactly what is hanging. Skipping `--with-deps`
on cache-hit would skip a no-op binary install but not the apt
install — i.e., it would not address the actual hang. The existing
requirement text says this in its own words: "`playwright install`
is a no-op when binaries are present, and `--with-deps` still
installs apt system packages that are not covered by the cache." So
this option does not reduce attack surface for the failure mode in
hand. Recorded under Alternatives Considered in `design.md`.

## What Changes

- **CI — split the install into two bounded-retry steps** (revised
  during implementation after PR #27 attempts 1–2 surfaced an
  `EPERM`-on-sudo defect in `nick-fields/retry@v3` — see
  `design.md` Decision 5 and Open Questions):
  - **Step A — Browser binaries.** `nick-fields/retry@v3` wraps
    `pnpm exec playwright install ${{ matrix.browser }}` (no
    `--with-deps`, so no sudo) with `timeout_minutes: 3`,
    `max_attempts: 2`, `retry_on: any`. The action's per-attempt
    timeout can kill the user-owned pnpm child cleanly here.
  - **Step B — System deps.** A shell `for attempt in 1 2; do … done`
    loop where each iteration is `sudo --preserve-env=PATH timeout
    --signal=TERM --kill-after=30s 10m pnpm exec playwright
    install-deps ${{ matrix.browser }}`. Because `timeout` runs
    under `sudo`, its kill signal originates as root and can
    terminate the root-owned apt-get grandchild — sidestepping the
    `kill EPERM` that the retry action hits when its non-root Node
    runtime tries to signal a sudo-escalated child.
  - Combined worst-case budget: 6 + 20 = 26 minutes, inside the
    30-minute e2e job timeout.
- **CI — the cache step is unchanged.** The `actions/cache@v4` step
  keeps its key, restore-keys, and per-browser scoping. Only the
  *install* step is split.
- **OpenSpec — modify the "E2E job caches Playwright browser
  binaries per matrix shard" requirement** to add bounded-budget
  language: the install MAY be expressed as one `--with-deps` step
  or two split steps, but every install step SHALL run inside a
  bounded retry wrapper with a per-attempt timeout strictly less
  than the e2e job timeout and a small bounded `max_attempts`,
  retrying on any failure. The wrapper for any sudo-escalated step
  MUST be capable of terminating root-owned children (i.e., a shell
  loop with `sudo timeout`), because Node-based retry actions
  cannot. New scenarios cover: per-attempt timeout shorter than the
  job timeout, retry on hang (with the sudo-aware kill caveat),
  total budget bounded under the job timeout, retry on non-zero
  exit, and persistent failure surfacing.
- **No spec change to "e2e job has Docker available …"**. The
  runner is still `ubuntu-latest`, the job is still not
  containerised, and Testcontainers still talks to the host Docker
  daemon. The container-based option is recorded as a non-goal here
  and a potential future change.

### Explicit non-goals (recorded as potential follow-ups)

- **Switch the e2e job to the official Playwright container.**
  Eliminates the install step entirely and is the correct
  long-term fix. Deferred for the reason in the Why section: it
  requires re-wiring Testcontainers to the host Docker socket plus
  a renovate-style version sync, and the present change ships a
  smaller, lower-risk mitigation. Re-evaluate if `apt-get` hangs
  recur after this change lands.
- **Skip `--with-deps` when the cache hits** (split into
  `install` + `install-deps` gated on
  `steps.<id>.outputs.cache-hit`). Does not address the failure
  mode — the apt step still has to run on every fresh runner. See
  `design.md` Alternatives Considered.
- **Replace `nick-fields/retry@v3` with a hand-rolled `until`
  shell loop.** The action is small, widely used, and gives
  per-attempt timeout *and* retry in one block. A shell loop
  reimplements the same logic in YAML and loses the action's
  attempt-summary output. Not worth it.
- **Tune the cache key to a Playwright version hash** (so a
  Playwright bump invalidates the binary cache without touching
  `e2e/pnpm-lock.yaml`). The lockfile already changes when
  Playwright bumps; the existing key is correct. Out of scope.
- **Pre-warm an apt cache or vendor the apt deps into the
  repository.** Heavyweight, infrastructure-level. The retry
  wrapper is sufficient for the observed failure rate.

## Capabilities

### Modified Capabilities

- `ci` — the "E2E job caches Playwright browser binaries per matrix
  shard" requirement is amended to mandate a bounded retry wrapper
  around the `playwright install --with-deps` invocation. The cache
  step itself, its key shape, its restore-keys, and the "runs
  unconditionally" property of the install command are preserved.

### Touched-but-not-modified Capabilities (cited for clarity)

- `ci` — the requirement that the e2e job "has Docker available so
  Testcontainers can boot Postgres" (`openspec/specs/ci/spec.md:184-198`)
  is unchanged. The job still runs on `ubuntu-latest` and still
  declares no `services:` block. The container-based alternative
  would have modified it; this change does not.
- `e2e` — Playwright-side behaviour, the harness, the test specs,
  and `globalSetup` are untouched. The change is confined to the
  workflow YAML and the `ci` spec.

## Impact

- **CI:**
  - Modified: `.github/workflows/ci.yml` — the original `Install
    Playwright browser (${{ matrix.browser }})` step is replaced
    with two new steps: `Install Playwright browser binaries
    (${{ matrix.browser }})` (uses `nick-fields/retry@v3`) and
    `Install Playwright system deps (${{ matrix.browser }})` (a
    shell `sudo timeout` retry loop). Run-history greps for the
    original step name will not match; the new step names are
    descriptive of which half they cover.
- **OpenSpec specs:**
  - Modified at archive time:
    `openspec/specs/ci/spec.md` — the "E2E job caches Playwright
    browser binaries per matrix shard" requirement gains
    timeout/retry language and five new scenarios (per-attempt
    timeout, retry on hang, total budget bounded, retry on
    non-zero exit, persistent failure surfacing). The body
    explicitly permits both single-step and two-step shapes. No
    other requirement is touched.
- **Backend / Frontend / e2e harness / docker-compose.yml /
  README.md:** No changes.
- **Database:** No migrations. No schema changes.
- **Dependencies:** No new application dependencies. One GitHub
  Actions third-party action (`nick-fields/retry@v3`) is
  referenced from the workflow for the binaries step.
- **Test plan for the change itself:** Verified on PR #27 across
  three attempts. Final attempt (commit `f98c55b`, split into
  two steps): all five required checks passed — chromium 3m47s,
  firefox 5m52s, webkit 6m54s, backend 1m14s, frontend 50s.
  Optional forced-failure verifications recorded in `tasks.md`
  sections 4–5 are deferred (real-world timeouts on attempts 1
  and 2 already exercised the bounded-budget mechanic).
