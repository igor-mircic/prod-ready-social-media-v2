## MODIFIED Requirements

### Requirement: E2E job caches Playwright browser binaries per matrix shard

The e2e job SHALL include an `actions/cache@v4` step that caches `~/.cache/ms-playwright`, scheduled before the `playwright install` step. The cache key SHALL include the matrix browser name and a hash of `e2e/pnpm-lock.yaml`, with a `restore-keys` prefix that omits the lockfile hash so partial hits are possible. The `playwright install --with-deps ${{ matrix.browser }}` invocation SHALL run unconditionally — `playwright install` is a no-op when binaries are present, and `--with-deps` still installs apt system packages that are not covered by the cache. The install invocation SHALL run inside a bounded retry wrapper that imposes a per-attempt timeout strictly less than the e2e job's `timeout-minutes` and a small bounded `max_attempts` such that the worst-case total install budget remains strictly less than the e2e job's `timeout-minutes`. The wrapper SHALL retry on any non-success outcome (both per-attempt timeout and non-zero exit), because both shapes are caused by transient apt-mirror conditions and the install command is idempotent. The cache step itself SHALL NOT be wrapped or retried.

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

#### Scenario: Install step has a per-attempt timeout strictly less than the job timeout

- **WHEN** a reader inspects the install step in `.github/workflows/ci.yml`
- **THEN** the step is wrapped in a retry action that declares a per-attempt timeout
- **AND** that per-attempt timeout is strictly less than the e2e job's `timeout-minutes`
- **AND** the per-attempt timeout is large enough to absorb a normal cold install (which empirically completes in under 3 minutes on this repo's matrix).

#### Scenario: A hanging install attempt is killed and retried

- **WHEN** the first install attempt hangs (e.g., apt-get is blocked on an unreachable mirror) and exceeds the per-attempt timeout
- **THEN** the retry wrapper kills the first attempt at its per-attempt timeout
- **AND** the wrapper starts a fresh attempt
- **AND** the job does NOT reach the e2e job's `timeout-minutes` cliff on the install step.

#### Scenario: Total install budget is bounded under the job timeout

- **WHEN** all retry attempts at the configured `max_attempts` value run to their per-attempt timeout
- **THEN** the cumulative wall-clock time spent in the install step is strictly less than the e2e job's `timeout-minutes`
- **AND** there is remaining time in the job budget for Playwright tests to execute when subsequent attempts succeed.

#### Scenario: Retry covers both hangs and non-zero exits

- **WHEN** an install attempt exits non-zero from a transient apt failure (e.g., `Failed to fetch …`, `Hash sum mismatch`) without exceeding the per-attempt timeout
- **THEN** the retry wrapper starts a fresh attempt
- **AND** the wrapper does NOT treat the non-zero exit as a permanent failure on the first attempt.

#### Scenario: Persistent failure surfaces a clear error after the bounded attempt count

- **WHEN** every attempt up to `max_attempts` fails (timeout or non-zero exit on each)
- **THEN** the install step fails the e2e job
- **AND** the run log shows one log section per attempt with each attempt's stderr
- **AND** the job did not silently wait out the job-level `timeout-minutes`.
