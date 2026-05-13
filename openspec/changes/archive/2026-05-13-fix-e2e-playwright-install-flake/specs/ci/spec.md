## MODIFIED Requirements

### Requirement: E2E job caches Playwright browser binaries per matrix shard

The e2e job SHALL include an `actions/cache@v4` step that caches `~/.cache/ms-playwright`, scheduled before the Playwright install steps. The cache key SHALL include the matrix browser name and a hash of `e2e/pnpm-lock.yaml`, with a `restore-keys` prefix that omits the lockfile hash so partial hits are possible. The Playwright install MAY be expressed either as a single `playwright install --with-deps ${{ matrix.browser }}` step or as two separate steps (`playwright install ${{ matrix.browser }}` for the browser binaries, followed by `playwright install-deps ${{ matrix.browser }}` for the apt system packages); in either form the install SHALL run unconditionally — the browser-binary half is a no-op when binaries are present, and the apt-system-packages half is still needed because those packages are not covered by the cache. Every install step SHALL run inside a bounded retry wrapper that imposes a per-attempt timeout strictly less than the e2e job's `timeout-minutes`, retries on any non-success outcome (both per-attempt timeout and non-zero exit, because both shapes are caused by transient apt-mirror or CDN conditions and the install commands are idempotent), and bounds `max_attempts` such that the sum of `per_attempt_timeout × max_attempts` across all install steps remains strictly less than the e2e job's `timeout-minutes`. The retry wrapper for any install step that escalates to root via `sudo` (e.g., the apt-system-packages step) MUST be capable of terminating root-owned child processes — typically a shell `for` loop with `sudo timeout`, because Node-based wrapper actions running as the non-root runner user crash with `EPERM` when their per-attempt timeout fires on a sudo-escalated child and therefore cannot deliver true retry-on-hang semantics for those steps. The cache step itself SHALL NOT be wrapped or retried.

#### Scenario: Cache restores browser binaries on a hit

- **WHEN** the e2e job runs a matrix shard for which a cache entry exists under `playwright-<os>-<browser>-<lockfile-hash>`
- **THEN** `~/.cache/ms-playwright` is restored before `playwright install` runs
- **AND** `playwright install --with-deps ${{ matrix.browser }}` completes without re-downloading the browser binaries.

#### Scenario: Lockfile change re-keys but partial hit still helps

- **WHEN** `e2e/pnpm-lock.yaml` changes but a previous cache entry exists under the same `playwright-<os>-<browser>-` prefix
- **THEN** the cache step restores the most recent matching entry via `restore-keys`
- **AND** `playwright install` reconciles any missing or outdated binaries
- **AND** the job saves a fresh cache entry under the new lockfile-hashed key.

#### Scenario: Per-browser keys avoid cross-shard cache collisions

- **WHEN** the e2e matrix runs chromium, firefox, and webkit shards in parallel
- **THEN** each shard uses a distinct cache key that includes its `matrix.browser` value
- **AND** the three shards do not race to save under a shared key.

#### Scenario: Cold cache still passes

- **WHEN** the e2e job runs for the first time after this change merges (no cache entry yet)
- **THEN** the cache step records a miss without failing the job
- **AND** `playwright install --with-deps ${{ matrix.browser }}` downloads the browser as before
- **AND** the cache step saves a new entry at the end of the job.

#### Scenario: Every install step has a per-attempt timeout strictly less than the job timeout

- **WHEN** a reader inspects any Playwright install step in `.github/workflows/ci.yml` (whether the single `--with-deps` form or either of the split binaries/deps steps)
- **THEN** the step is wrapped in a retry mechanism that declares a per-attempt timeout
- **AND** that per-attempt timeout is strictly less than the e2e job's `timeout-minutes`
- **AND** the per-attempt timeout is large enough to absorb a normal cold run of that step on this repo's matrix (empirically, browser-binaries fit in under 3 minutes; apt-system-packages can require up to ~10 minutes on a slow mirror).

#### Scenario: A hanging install attempt is killed and retried

- **WHEN** an install attempt hangs (e.g., apt-get is blocked on an unreachable mirror) and exceeds the per-attempt timeout
- **THEN** the retry wrapper kills the attempt at its per-attempt timeout (using `sudo timeout` for steps that escalate to root, so the kill signal can reach root-owned children)
- **AND** the wrapper starts a fresh attempt
- **AND** the job does NOT reach the e2e job's `timeout-minutes` cliff on the install step.

#### Scenario: Total install budget is bounded under the job timeout

- **WHEN** every install step runs all of its `max_attempts` to their per-attempt timeout
- **THEN** the cumulative wall-clock time spent across all install steps is strictly less than the e2e job's `timeout-minutes`
- **AND** there is remaining time in the job budget for Playwright tests to execute when a subsequent attempt succeeds.

#### Scenario: Retry covers both hangs and non-zero exits

- **WHEN** an install attempt exits non-zero from a transient failure (e.g., apt `Failed to fetch …`, `Hash sum mismatch`, or a CDN-side TLS reset on the binary download) without exceeding the per-attempt timeout
- **THEN** the retry wrapper starts a fresh attempt
- **AND** the wrapper does NOT treat the non-zero exit as a permanent failure on the first attempt.

#### Scenario: Persistent failure surfaces a clear error after the bounded attempt count

- **WHEN** every attempt up to `max_attempts` fails (timeout or non-zero exit on each) for some install step
- **THEN** that install step fails the e2e job
- **AND** the run log shows one log section per attempt with each attempt's stderr
- **AND** the job did not silently wait out the job-level `timeout-minutes`.
