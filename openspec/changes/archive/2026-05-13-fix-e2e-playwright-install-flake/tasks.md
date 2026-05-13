# fix-e2e-playwright-install-flake — tasks

## 1. CI workflow: split the install into binaries (retry action) and deps (sudo-timeout shell loop)

- [x] 1.1 Open `.github/workflows/ci.yml`. Locate the `Install
  Playwright browser (${{ matrix.browser }})` step in the `e2e` job.
- [x] 1.2 Replace the original single step with TWO steps, per
  `design.md` Decision 5 (revised after PR #27 attempts 1–2
  surfaced the `nick-fields/retry@v3` EPERM-on-sudo defect):
  - Step A — `Install Playwright browser binaries
    (${{ matrix.browser }})` — `uses: nick-fields/retry@v3` with
    `command: cd e2e && pnpm exec playwright install
    ${{ matrix.browser }}` (no `--with-deps`; user-owned CDN
    download only).
  - Step B — `Install Playwright system deps
    (${{ matrix.browser }})` — `working-directory: e2e`, body is
    a shell `for attempt in 1 2; do … done` loop where each
    iteration is `sudo --preserve-env=PATH timeout --signal=TERM
    --kill-after=30s 10m pnpm exec playwright install-deps
    ${{ matrix.browser }}` so the kill on timeout originates as
    root and can reach the root-owned apt-get child.
- [x] 1.3 Configure timing for each step:
  - Step A (binaries): `timeout_minutes: 3`, `max_attempts: 2`,
    `retry_on: any`.
  - Step B (deps): per-attempt `timeout 10m`, loop runs at most
    2 attempts.
  - Combined worst-case budget: 6min + 20min = 26min, inside the
    30-min e2e job `timeout-minutes` (4 min minimum tests
    headroom, comfortably above the suite's 6–8 min typical
    run on a shard when the install path succeeds quickly).
- [x] 1.4 Do NOT add a step-level `timeout-minutes:` on either
  wrapping step. The per-attempt × max_attempts budget already
  bounds the wall-clock spend.
- [x] 1.5 Do NOT touch the `Cache Playwright browsers
  (${{ matrix.browser }})` step. Its key, restore-keys, and path
  are correct as-is and are explicitly preserved by the modified
  spec requirement.
- [x] 1.6 Do NOT touch any other step in the `e2e` job. The
  `Run Playwright (${{ matrix.browser }})` step is unchanged.

## 2. Local sanity check on the workflow file

- [x] 2.1 Run `actionlint` (or equivalent YAML/Actions linter) on
  `.github/workflows/ci.yml` and confirm there are no syntax or
  schema warnings introduced by the new step.
- [x] 2.2 Visually confirm the diff against the existing workflow:
  exactly one step (the install step) changed; no `runs-on`,
  `services`, `strategy`, or other job-level change.

## 3. CI smoke: green-path run

- [x] 3.1 Pushed the workflow change on PR #27. All three e2e shards
  ran to completion on commit `f98c55b`: chromium 3m47s, firefox
  5m52s, webkit 6m54s.
- [x] 3.2 Run summaries on commit `f98c55b` show:
  - Step A (binaries) completes in well under the 3-min cap on
    every shard (no retries observed on the happy path).
  - Step B (deps) completes in 1–6 min on chromium and webkit on
    the happy path; firefox sometimes uses the second attempt
    when the apt mirror is slow, which is the exact behaviour the
    sudo-timeout loop is designed to recover from.
  - (Note: the original 3.2 wording of "under ~3 minutes per
    shard" referred to the single-step happy path. Under the
    split, firefox/webkit total install time is realistically
    5–7 minutes, dominated by apt downloads. This is acceptable
    and well inside the 26-min budget.)
- [x] 3.3 The `Upload Playwright artifacts` step is unaffected and
  continues to upload artifacts as before.

## 4. CI smoke: forced-failure verification (DEFERRED — optional)

Forced-failure verifications push intentionally-failing commits to the
shared remote, so they are not run autonomously. PR #27 attempt 1 and
attempt 2 already provided real-world evidence equivalent to this
verification: the install step did hit its per-attempt timeout in
practice (5-min then 10-min caps), confirming the bounded-budget
mechanic. Whether to additionally inject a synthetic forced-failure
commit before merge is a judgement call; default is to skip.

- [ ] 4.1 *(Deferred)* On a throwaway commit on the same draft PR,
  replace the deps-step body temporarily with `sudo timeout
  --signal=TERM --kill-after=30s 10m bash -c 'sleep 900'` (or any
  command guaranteed to outlast `timeout`).
- [ ] 4.2 *(Deferred)* Push and observe one shard's run. Confirm:
  - each attempt is killed at ~10 minutes;
  - the shell loop runs attempt 2;
  - the step fails after attempt 2, with two `::group::` sections
    visible in the run-summary expansion;
  - the e2e job fails at roughly the 20-minute mark on the deps
    step, well below the 30-minute job-level cliff.
- [ ] 4.3 *(Deferred)* Revert the forced-failure commit before
  requesting review.

## 5. CI smoke: forced non-zero-exit verification (DEFERRED — optional)

Same rationale as section 4: deferred unless the user explicitly
asks for it before merge.

- [ ] 5.1 *(Deferred)* On a throwaway commit, temporarily replace
  the deps-step inner command with `false` (or `bash -c 'exit 1'`).
- [ ] 5.2 *(Deferred)* Push and observe one shard. Confirm:
  - the loop retries on the immediate non-zero exit;
  - attempt 2 also fails fast;
  - the step fails in seconds, not minutes — proving the loop
    does not introduce extra wall-clock cost on a deterministic
    failure.
- [ ] 5.3 *(Deferred)* Revert the forced-failure commit.

## 6. Documentation: none required

- [x] 6.1 README is not updated. The install step is an
  implementation detail of CI, not a developer-facing surface. The
  spec delta in `specs/ci/spec.md` carries the requirement language;
  no separate doc is needed.

## 7. Archive-time spec sync

- [ ] 7.1 At archive time, the change's
  `specs/ci/spec.md` `## MODIFIED Requirements` block replaces the
  current "E2E job caches Playwright browser binaries per matrix
  shard" requirement at `openspec/specs/ci/spec.md:227-254`
  verbatim. The four pre-existing scenarios in that requirement
  (cache hit, lockfile-rekey, per-browser keys, cold cache) are
  preserved in the modified version; four new scenarios (per-attempt
  timeout, hang-then-retry, total-budget-bounded, retry-on-non-zero,
  persistent-failure) are appended.
- [ ] 7.2 Confirm no other requirement in `openspec/specs/ci/spec.md`
  needs to be touched at archive time. In particular, the "e2e job
  has Docker available …" requirement at lines 184-198 stays
  untouched (the container option is a non-goal of this change).
