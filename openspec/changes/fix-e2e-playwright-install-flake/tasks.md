# fix-e2e-playwright-install-flake — tasks

## 1. CI workflow: wrap the install step in `nick-fields/retry@v3`

- [x] 1.1 Open `.github/workflows/ci.yml`. Locate the `Install
  Playwright browser (${{ matrix.browser }})` step in the `e2e` job
  (currently at lines 160-162).
- [x] 1.2 Replace the step body with a `uses: nick-fields/retry@v3`
  invocation. Keep the step `name:` identical to the current value
  (`Install Playwright browser (${{ matrix.browser }})`) so existing
  run-history greps still match and the run-summary line is
  unchanged.
- [x] 1.3 Configure the action's inputs:
  - `timeout_minutes: 10` — per-attempt timeout. Per `design.md`
    Decision 2 (revised from 5 after PR #27 attempt 1 hit the
    5-min cap on a slow-but-progressing firefox/webkit cold install).
  - `max_attempts: 2` — bounded retry count. Per `design.md`
    Decision 3 (revised from 3 to keep total budget 2×10=20min under
    the 30-min job timeout).
  - `retry_on: any` — retry on both timeout and non-zero exit.
    Per `design.md` Decision 4.
  - `command: cd e2e && pnpm exec playwright install --with-deps
    ${{ matrix.browser }}` — the cwd-change is inlined because the
    action does not honour the surrounding step's `working-directory`.
    Per `design.md` Decision 6.
- [x] 1.4 Do NOT add a step-level `timeout-minutes:` on the wrapping
  step. The action's `timeout_minutes × max_attempts` budget already
  bounds the wall-clock spend, and an outer `timeout-minutes` would
  double the budget. Per `design.md` Open Question 1.
- [x] 1.5 Do NOT touch the `Cache Playwright browsers
  (${{ matrix.browser }})` step at lines 152-159. Its key,
  restore-keys, and path are correct as-is and are explicitly
  preserved by the modified spec requirement.
- [x] 1.6 Do NOT touch any other step in the `e2e` job. In particular,
  the `Run Playwright (${{ matrix.browser }})` step is unchanged.

## 2. Local sanity check on the workflow file

- [x] 2.1 Run `actionlint` (or equivalent YAML/Actions linter) on
  `.github/workflows/ci.yml` and confirm there are no syntax or
  schema warnings introduced by the new step.
- [x] 2.2 Visually confirm the diff against the existing workflow:
  exactly one step (the install step) changed; no `runs-on`,
  `services`, `strategy`, or other job-level change.

## 3. CI smoke: green-path run

- [ ] 3.1 Push the workflow change on a draft PR. Confirm the e2e job
  runs to completion on all three shards (chromium, firefox, webkit).
- [ ] 3.2 In the run summary for each shard, confirm the install
  step shows exactly one attempt (no retry triggered on the happy
  path) and completes in under ~3 minutes per shard.
- [ ] 3.3 Confirm the Playwright suite still runs and produces the
  usual artifacts (the `Upload Playwright artifacts` step at lines
  168-177 is unaffected).

## 4. CI smoke: forced-failure verification (revert before merge)

- [ ] 4.1 On a throwaway commit on the same draft PR, replace the
  `command:` value temporarily with `cd e2e && bash -c 'sleep 600'`
  (or any command guaranteed to outlast `timeout_minutes`).
- [ ] 4.2 Push and observe one shard's run. Confirm:
  - the step is killed at ~5 minutes per attempt (not 30 minutes
    of silent waiting);
  - `nick-fields/retry@v3` runs the second and third attempts;
  - the step fails after attempt 3, with three attempt log
    sections visible in the run-summary expansion;
  - the e2e job fails at roughly the 15-minute mark, well below
    the 30-minute job-level cliff.
- [ ] 4.3 Revert the forced-failure commit before requesting review.
  The final state of the PR must match step 1's diff exactly — no
  `sleep`, no stray test command.

## 5. CI smoke: forced non-zero-exit verification (revert before merge)

- [ ] 5.1 On a throwaway commit, temporarily replace the `command:`
  with `cd e2e && bash -c 'exit 1'`.
- [ ] 5.2 Push and observe one shard. Confirm:
  - the step retries on the immediate non-zero exit (i.e.,
    `retry_on: any` covers non-timeout failures, per Decision 4);
  - attempts 2 and 3 also fail fast with `exit 1`;
  - the job fails in seconds, not minutes — proving the retry
    wrapper does not introduce extra wall-clock cost on a
    deterministic failure.
- [ ] 5.3 Revert the forced-failure commit.

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
