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

### Decision 2: 10-minute per-attempt timeout (revised from 5)

**Choice:** `timeout_minutes: 10` on each attempt.

**Original choice and why it was wrong:** the first draft of this
design picked 5 minutes, on the assumption that empirical green
runs landed in the 1m20s–2m40s range. PR #27 attempt 1 invalidated
that assumption: firefox and webkit shards hit the 5-minute
per-attempt timeout while `apt-get` was *actively downloading*
(~48 MB of media-codec packages — `libcodec2-1.2`, `libavcodec60`,
`fonts-wqy-zenhei`, etc.) from a slow Azure mirror. The download
was making forward progress, just slowly. 5 minutes is not "~2×
the happy-path upper bound" — it is right at the upper bound under
adverse mirror conditions, which clips a substantial fraction of
real runs.

**Why 10:** absorbs the slow-but-still-progressing case that 5
minutes did not. A 48-MB apt fetch at the observed throttled rate
(~150 KB/s mid-run) needs ~5 minutes just for the download phase;
add unpack/configure on top and the cold path on firefox/webkit
realistically runs 6–8 minutes on a slow day. 10 minutes leaves
2 minutes of headroom over that.

**Why not 8:** 8 × 2 = 16 minute budget fits comfortably, but the
2-minute headroom over the observed 6–8 minute slow-path is the
margin that prevents repeat false-positive timeouts. Spending
an extra 4 minutes of worst-case budget (20 vs 16) for that margin
is worth it — see Decision 3.

**Why not 15:** the value of a tight per-attempt timeout *is* fast
failure. With `max_attempts: 2` (see Decision 3), 15 × 2 = 30
minutes equals the job timeout, leaving zero headroom for tests.

**Trade-off:** a true mirror hang now takes 10 minutes per attempt
to detect instead of 5. Acceptable because the bounded retry runs
*one* more attempt after that, vs. the original 30-minute cliff
which yielded zero retries.

### Decision 3: 2 attempts total (revised from 3)

**Choice:** `max_attempts: 2`.

**Original choice and why it was revised:** the first draft picked
3, paired with 5-minute attempts, for a 15-minute total budget.
Revising Decision 2 to 10 minutes per attempt forced a paired
revision here: 3 × 10 = 30 minutes equals the job timeout, leaving
no room for tests. Dropping to 2 attempts gives a 20-minute total
install budget and preserves 10 minutes of headroom for the
Playwright suite (which runs in 6–8 minutes per shard, comfortably
under the headroom).

**Why 2 is enough:** the cases retry meaningfully covers are
*transient* — a single mirror flake on one attempt followed by a
healthy mirror on the next is exactly the recovery pattern we
want. The case 3 attempts would have caught — two consecutive
flakes followed by a healthy third — is rarer and, in the rare
runs where it does occur, a human re-run of the workflow
recovers it. We pay 20 minutes of CI time on a true triple-failure
day instead of 30; the trade is acceptable.

**Trade-off:** in the narrow regime of "two consecutive attempts
both hit transient apt failures," CI fails and requires a human
re-run. Outcome matches pre-change behaviour, reached at ~20
minutes instead of 30, with two diagnostic attempt-logs to inspect.

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

### Decision 5: Split the install into two steps; use `nick-fields/retry@v3` for binaries and a shell `sudo timeout` loop for deps

**Choice (revised after PR #27 attempts 1–2):** Replace the single
`pnpm exec playwright install --with-deps ${{ matrix.browser }}`
step with two separate steps:

1. **Browser binaries** — `pnpm exec playwright install
   ${{ matrix.browser }}`. Wrapped by `nick-fields/retry@v3` with
   `timeout_minutes: 3` and `max_attempts: 2`. This half talks to
   the Playwright CDN as the runner user; no `sudo` is involved,
   so the action's per-attempt timeout can actually kill the
   user-owned child process.
2. **System dependencies** — `pnpm exec playwright install-deps
   ${{ matrix.browser }}`, which shells out to `sudo apt-get`
   internally. Wrapped by a shell `for attempt in 1 2; do … done`
   loop where each attempt is `sudo --preserve-env=PATH timeout
   --signal=TERM --kill-after=30s 10m pnpm exec playwright
   install-deps ${{ matrix.browser }}`. The wrapping `sudo` runs
   `timeout` as root, so when `timeout`'s budget fires it can
   signal its root-owned child (`pnpm` → `playwright` → `apt-get`)
   without `EPERM`.

**Why the split, and not a single retry-action step:** PR #27
attempts 1 and 2 demonstrated that `nick-fields/retry@v3` crashes
with `Error: kill EPERM` when its per-attempt timeout fires on a
sudo-escalated child. The action's Node runtime runs as the
runner user; the apt-get process running under sudo has
real-UID=0; the kernel rejects a non-root `process.kill` to a
root target. Net effect with the action-only approach: timeout
is respected (single-attempt hard cap), but **no retry happens**
— only one attempt ever runs, regardless of `max_attempts`. That
contradicts the modified spec requirement's "retry on hang"
scenario, so it is not acceptable as the implementation.

**Why the shell loop is acceptable here even though Decision 5's
earlier draft rejected it:** the earlier rejection was on the
grounds that a shell loop reimplements the action's logic and
loses per-attempt run-summary output. With the EPERM finding in
hand, the action *cannot* produce a correct per-attempt summary
for the sudo'd step (it crashes on the kill), so the trade-off
flips: a shell loop with explicit `::group::` markers gives clear
per-attempt logs in the run summary, and a shell loop with `sudo
timeout` is the only mechanism that can correctly enforce the
timeout-then-retry semantics the spec requires for an apt-driven
install. The action remains the right tool for the non-sudo'd
binaries step; the loop is the right tool for the sudo'd deps
step. The cost is two different mechanisms in one workflow
file; the spec body explicitly admits both forms.

**Why not run the unified `playwright install --with-deps` under
a single `sudo timeout` loop:** doing so would make the binary
download run as root, with binaries landing under `/root/.cache/`
(or, with `--preserve-env=HOME`, in `/home/runner/.cache/` but
root-owned). Either ownership shape complicates the `actions/cache`
restore/save cycle, which expects user-owned files in
`/home/runner/.cache/ms-playwright`. The split keeps the binary
half user-owned (clean cache semantics) and confines `sudo` to
the apt half (which writes into `/usr` and never touches the
binary cache directory).

**Why not `actions-marketplace/retry-step` or an
`alphaprinz/retry-action` clone:** every Node-based retry action
shares the same EPERM defect for sudo'd children — it is a
kernel-level signalling rule, not an `nick-fields/retry@v3`
implementation bug. Switching brands would not help. The action
is retained for the binaries step because the binaries step has
no sudo and works correctly.

**Trade-off:** two install steps instead of one, and two
different retry mechanisms. The workflow file is slightly more
complex; the spec body explicitly permits this shape.

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
- **`nick-fields/retry@v3` cannot kill a sudo'd child** —
  empirically observed on PR #27 attempt 1: when the action's
  per-attempt timeout fired on a slow `apt-get`, the action's
  Node process tried to `process.kill(pid, SIGTERM)` on a sudo'd
  apt process (real-UID=root after `setuid(0)`) and crashed with
  `kill EPERM` instead of starting the retry. Net effect: timeout
  *is* respected (the step does end at the per-attempt cap), but
  no retry happens — only a single attempt runs before the action
  errors out. Implications:
  - The "killed and retried" scenario in the spec delta is only
    satisfied for non-sudo failure modes (e.g., a non-zero exit
    from `playwright install` itself, or a hang on a non-sudo'd
    child). For a sudo'd `apt-get` hang, the per-attempt cap fires
    once and the step fails — strictly better than the 30-minute
    cliff (which is the goal of the change) but worse than the
    ideal multi-attempt recovery.
  - The conservative mitigation in this change (10-min ceiling)
    is sufficient for the observed failure mode (slow-but-
    progressing mirror, no actual hang). If true `apt-get` hangs
    recur and the lack of retry on that path becomes a problem,
    the follow-up is to split the install into two steps:
    `playwright install <browser>` (user-owned, retry-action-wrapped)
    and `playwright install-deps <browser>` (sudo'd, wrapped in a
    shell `for` loop with `sudo timeout --kill-after=...` so the
    kill signal originates as root and can reach the root child).
    Recorded under Decision 5 as a deferred path.

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
