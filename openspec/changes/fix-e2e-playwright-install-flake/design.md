# fix-e2e-playwright-install-flake — design

## Context

Code state verified against the tree at change-draft time:

- `.github/workflows/ci.yml:152-162` declares the cache step and the
  install step in their current shapes. The cache step
  (`actions/cache@v4`) keys on
  `playwright-${{ runner.os }}-${{ matrix.browser }}-${{ hashFiles('e2e/pnpm-lock.yaml') }}`
  with a `playwright-${{ runner.os }}-${{ matrix.browser }}-`
  restore-keys prefix. The install step runs
  `pnpm exec playwright install --with-deps ${{ matrix.browser }}`
  from the `e2e/` working directory. There is no `timeout-minutes`
  on the step. The job-level `timeout-minutes: 30` at line 109 is
  the only budget around it.
- The observed failure on PR #26 attempt 1: every shard hit the
  30-minute job timeout, with the active step at the cancel moment
  being `Install Playwright browser` for all three. A workflow
  re-run on the identical commit passed. No application change
  could have caused this — the failure is environmental.
- `e2e/package.json` pins `@playwright/test` and exposes the
  `playwright` CLI via `pnpm exec`. `playwright install --with-deps`
  is documented as idempotent: re-running it after a partial run
  re-resolves only what is missing on the binary side and re-runs
  `apt-get install` for the system packages (apt's own dedupe makes
  the second invocation cheap if the first got far enough to install
  packages, and the first attempt's downloaded `.deb`s in
  `/var/cache/apt/archives` survive across processes within the same
  runner).
- The runner is `ubuntu-latest`. The image carries Docker for
  Testcontainers (per `openspec/specs/ci/spec.md:184-198`) but does
  not carry the full set of apt packages Playwright requires for
  firefox and webkit. This is why `--with-deps` must run on every
  job — verified by inspecting the documented `playwright
  install-deps` package list against the GitHub-hosted Ubuntu runner
  image manifest.
- `nick-fields/retry@v3` is a maintained third-party action with
  current usage in the broad GitHub Actions ecosystem. It exposes
  `command`, `timeout_minutes`, `max_attempts`, `retry_on`
  (`any` / `timeout` / `error`), and per-attempt output. It is a
  composite JS action — no shell-isms, runs on any runner.

## Goals / Non-Goals

**Goals:**

- Make the install step fail fast on a hang. A stuck `apt-get`
  becomes a per-attempt timeout, not a job-level cancellation 30
  minutes later.
- Recover automatically from a single transient failure without a
  human re-running the workflow.
- Keep the diagnostic surface useful: the step name in the run
  summary, the attempt count, and the per-attempt logs.
- Preserve the existing cache-step behaviour entirely. This change
  does not re-key the cache, does not change what is cached, and
  does not gate `--with-deps` on cache-hit.
- Keep the total install budget strictly under the job timeout so a
  pathologically slow run still leaves room for Playwright tests
  themselves to execute.

**Non-goals:**

- Eliminating the install step (would require switching to the
  official Playwright container — recorded as a follow-up in
  `proposal.md`).
- Skipping `--with-deps` on cache-hit (does not address the failure
  mode — see Alternatives Considered below).
- Caching apt packages (out of scope; a runner-image concern).
- Reducing the Playwright matrix from three browsers to one.
- Making the install step "advisory" / non-blocking. The step is and
  remains a hard requirement of the job.

## Decisions

### Decision 1: Option 1 (step timeout + auto-retry), not options 2 or 3

**Choice:** Wrap the install step with `nick-fields/retry@v3`
providing a per-attempt timeout and a bounded retry count. Do not
adopt the official Playwright container in this change; do not split
the install command into `install` + `install-deps` gated on
cache-hit.

**Why option 1 over option 3 (container):** option 3 is correct in
the long run but pays for itself only if hangs recur. The cost of
adopting it now is real: the e2e job currently runs Testcontainers
in-JVM, and Testcontainers connects to the host Docker daemon by
default. Moving the job into a container means mounting
`/var/run/docker.sock` from the host into the container, exporting
`TESTCONTAINERS_HOST_OVERRIDE` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, and verifying that the
Playwright image's Java toolchain matches the harness's expectations
(or installing Java inside the container). It also adds a
renovate-style sync between the
`mcr.microsoft.com/playwright:v<X.Y>-jammy` tag and the
`@playwright/test` version in `e2e/package.json`. That is a worthy
follow-up change *if* this mitigation proves insufficient. Shipping
it pre-emptively on a single observed incident is over-correcting.

**Why option 1 over option 2 (skip `--with-deps` on cache-hit):**
option 2 does not address the failure mode. The cache covers
`~/.cache/ms-playwright` — browser binaries. The apt-installed
system libraries Playwright needs for firefox and webkit
(`libwoff1`, `libenchant-2-2`, `libgstreamer-plugins-bad1.0-0`,
`libwebpdemux2`, and ~25 others) are NOT in the cache and NOT
pre-installed on `ubuntu-latest`. They have to be apt-installed on
every fresh runner. The apt step is exactly what is hanging. The
existing spec text at `openspec/specs/ci/spec.md:229` already
captures this: "`playwright install` is a no-op when binaries are
present, and `--with-deps` still installs apt system packages that
are not covered by the cache." Option 2 would skip a no-op binary
install on cache-hit and still run `apt-get`, i.e., not reduce
exposure to the actual fault. A variation — running
`playwright install-deps` only when the runner image is verified to
already carry every required package — is rejected for the same
reason: empirical inspection confirms stock `ubuntu-latest` does
*not* carry them.

**Trade-off:** option 1 leaves the door open for option 3 to land
later. It does not foreclose either alternative. It is the minimum
change that converts the failure mode from "30-minute silent stall"
to "5-minute fast-retry."

### Decision 2: 5-minute per-attempt timeout

**Choice:** `timeout_minutes: 5` on each attempt.

**Why 5:** the normal cold path is `playwright install` downloading
one browser (chromium 150 MB, firefox 95 MB, or webkit 65 MB; ~30–90
seconds on the GitHub-hosted runner network) plus
`apt-get update && apt-get install <30-or-so packages>` (~30–90
seconds on a healthy mirror). Empirical numbers from prior green
runs on this repo's PRs land in the 1m20s–2m40s range across the
three shards. 5 minutes is ~2× the upper end of the happy-path
distribution. Wide enough to absorb a slow-but-progressing mirror,
tight enough that a true hang is killed quickly.

**Why not 3:** would clip the upper tail of the happy path under
adverse-but-still-recovering network conditions, increasing false-
positive retries. The retry is cheap (the cache restore for
attempt 2 is instant once binaries are present from attempt 1's
partial work) but unnecessary retries pollute the run log.

**Why not 10:** the value of a tight per-attempt timeout *is* fast
failure. A 10-minute attempt followed by two retries is a 30-minute
worst case — i.e., back at the original cliff with no headroom for
the actual tests.

**Trade-off:** a one-off legitimate cold install that crosses 5
minutes (e.g., GitHub's CDN throttling a single shard) will trigger
a needless retry. Acceptable. The retry is itself bounded and idempotent.

### Decision 3: 3 attempts total (max_attempts)

**Choice:** `max_attempts: 3`.

**Why 3:** total worst-case install budget = 3 × 5 = 15 minutes.
That fits inside the 30-minute job timeout with 15 minutes left for
the Playwright suite to run, which is comfortably above the suite's
observed worst-case duration (~6–8 minutes for a full shard
including the harness's globalSetup). Two attempts would also fit,
but a back-to-back transient mirror issue on attempts 1 and 2 — not
implausible during a GitHub Actions network event — would burn the
entire budget on bad luck. Three attempts has roughly one extra
chance for free.

**Why not 5:** diminishing returns, and a noisier signal. If
attempt 4 is needed, the underlying network event is the wrong
shape for retry to fix — the right response is to fail loudly and
let a human re-run later. Five-attempt loops also tempt readers to
treat the install step as fundamentally flaky, which it is not on
the happy path.

**Trade-off:** in the very narrow regime of "three consecutive
attempts all hit transient apt failures," CI will fail and require
a human re-run. That is the same outcome as today, just reached in
~15 minutes instead of 30, with three diagnostic attempt-logs to
inspect.

### Decision 4: Retry on any failure, not just timeout

**Choice:** `retry_on: any`.

**Why:** `apt-get` failures present in two shapes:

- **Silent hang.** A mirror is reachable but stops streaming bytes.
  This is the exact PR #26 attempt-1 shape. `retry_on: timeout`
  catches it.
- **Loud non-zero exit.** A mirror returns `404 Not Found`,
  `Hash sum mismatch`, or `Could not resolve …`. These exit
  non-zero from `apt-get` and propagate non-zero out of
  `playwright install --with-deps`. `retry_on: timeout` would NOT
  retry these; they would fail the step on the first attempt.

Both shapes are transient and both are correctly handled by
re-running the same command. `retry_on: any` covers both. The risk
of `retry_on: any` is masking a *non-transient* failure — e.g., a
Playwright version that genuinely doesn't have a Linux build, or a
syntax error in the install command. Both fail deterministically on
every attempt and the action still surfaces three identical errors
in the log; the developer's diagnostic is the same as without retry,
just delayed by ~15 minutes once. Acceptable trade.

**Why not `retry_on: error` (non-zero only, no timeout):** the PR
#26 shape was a timeout, not a non-zero exit. Skipping timeout
retries would leave the original symptom uncovered. The whole
point of this change is to retry on timeout. So either `timeout` or
`any`, and `any` is the strict superset.

**Trade-off:** a single transient retry-on-success run shows up in
the logs as two attempts, the first ending in a non-zero exit. A
reader skimming the log might briefly think CI was failing. The
attempt-summary output the action emits at the end makes the actual
outcome obvious. Acceptable.

### Decision 5: Wrap the install step, not the install command, in `nick-fields/retry@v3`

**Choice:** Replace the step that runs `pnpm exec playwright install
--with-deps ${{ matrix.browser }}` with a step using `uses:
nick-fields/retry@v3` and passing the same command via the action's
`command` input. Keep the step name (`Install Playwright browser
(${{ matrix.browser }})`) so run-history greps continue to match
and the run-summary line for this step is unchanged.

**Why not a `timeout-minutes` step-level field plus a manual retry
loop in shell:** GitHub Actions step-level `timeout-minutes` kills
the step on timeout but does not retry. Reproducing retry semantics
in shell — `for i in 1 2 3; do timeout 5m … && break; done` — works
but loses per-attempt run-summary output and reimplements the
action's logic in YAML. The action is small, widely used, and
expresses intent in one place. Worth the one external dep.

**Why not `actions-marketplace/retry-step` or an
`alphaprinz/retry-action` clone:** the chosen action
(`nick-fields/retry@v3`) is the most-starred and most-maintained
of the family. Pinning the major version is sufficient — a `v3`
major-version freeze does not auto-pick a v4 that might change
semantics.

**Trade-off:** one more third-party action in the workflow.
Reviewed against the action's source — it is a small composite
action with no surprising network calls. Acceptable.

### Decision 6: Working directory stays `e2e/` (passed via the action's `command` input)

**Choice:** `pnpm exec playwright install --with-deps
${{ matrix.browser }}` runs from `e2e/`. The retry action accepts
the working directory via running the command through `bash -lc
"cd e2e && …"` OR by setting `working_directory` on the action if
supported. The exact wiring is a tasks.md detail; the requirement is
that `pnpm` resolves against `e2e/package.json`.

**Why:** unchanged from the current step. The install reads
`@playwright/test` from `e2e/package.json` and writes binaries to
`~/.cache/ms-playwright`. Both paths are independent of the cwd —
but `pnpm exec` is not, since it walks up the directory tree from
the cwd to find `node_modules/.bin/playwright`.

## Open Questions

- Do we additionally want a step-level `timeout-minutes` on the
  retry step itself, as a belt-and-braces guard against a bug in
  the retry action? Default answer is no — the action's
  per-attempt timeout and max_attempts already bound the wall-clock
  spend, and an outer `timeout-minutes` on the same step would
  double the budget. Cheap to revisit if the action's behaviour
  ever surprises us.

## Risks

- **`nick-fields/retry@v3` semantics drift in a future minor
  release.** Mitigation: the `v3` pin is a major-version freeze.
  The CI workflow is read on every PR — a behaviour change would
  surface on the first run after a version bump. **Severity:**
  low; mitigated by review.
- **`playwright install --with-deps` becomes non-idempotent in a
  future Playwright release** (e.g., a v2 of the apt step that
  writes lockfiles that conflict on a re-run). Mitigation: the
  Playwright team treats install idempotency as a stable
  contract, and the cache restore on attempt 2 short-circuits the
  binary half regardless. **Severity:** low.
- **The chosen 5-minute timeout proves too tight under sustained
  network throttling.** Mitigation: bumping `timeout_minutes` is
  a one-line change. The total budget — 3 × 5 = 15 minutes — is
  the meaningful number and stays well inside the 30-minute job
  cap. **Severity:** low.
- **Retries hide a genuine regression.** A future PR that breaks
  the install command (e.g., a typo) would now fail 3× instead
  of 1×, lengthening the feedback loop by ~10 minutes. Mitigation:
  the action surfaces all three attempts in the run log, so the
  reader sees identical failures and recognises the shape.
  **Severity:** low.

## Alternatives Considered

- **Option 3 — switch to the official Playwright container
  (`container: mcr.microsoft.com/playwright:vX.Y-jammy`).** Removes
  the install step entirely. Rejected for *this* change because it
  requires re-wiring Testcontainers to the host Docker socket (see
  Decision 1) and modifying the "Docker is available on the runner"
  requirement at `openspec/specs/ci/spec.md:184-198`. Recorded as a
  potential follow-up if hangs recur.
- **Option 2 — skip `--with-deps` on cache-hit.** Rejected: the
  hang is in the apt step, which the cache does not cover. See
  Decision 1.
- **Hand-rolled shell retry loop with `timeout` and `for`.**
  Rejected: reimplements the action's logic in YAML and loses
  per-attempt summary output. See Decision 5.
- **Increase the job-level `timeout-minutes` from 30 to 60.**
  Rejected: makes the problem twice as expensive without fixing
  it. The point is to bound the install, not to absorb its hang.
- **Add `paths-ignore:` to skip the e2e job on PRs that don't
  touch e2e code.** Rejected: violates the existing requirement at
  `openspec/specs/ci/spec.md:117-121` ("e2e job is not skipped by
  path filters"). Out of scope and orthogonal to the install hang.
- **Disable the firefox / webkit shards.** Rejected: violates the
  existing requirement at `openspec/specs/ci/spec.md:143-156`
  (chromium/firefox/webkit matrix is required). The matrix is the
  cross-engine safety net of this project.
