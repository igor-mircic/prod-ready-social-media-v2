## ADDED Requirements

### Requirement: Backend job caches Gradle dependencies

The backend job's `actions/setup-java@v4` step SHALL enable Gradle caching (via the action's built-in `cache: gradle` option) so that `~/.gradle/caches` and `~/.gradle/wrapper` are restored between runs. The cache key SHALL be derived from the repository's Gradle build files so that a change to any `*.gradle*` file or `gradle-wrapper.properties` invalidates the cache. No other job's `setup-java` block enables Gradle caching, because no other job invokes Gradle.

#### Scenario: Backend job restores Gradle cache on repeat runs

- **WHEN** the backend job runs on a commit whose Gradle build files are unchanged from a previous successful run
- **THEN** `~/.gradle/caches` and `~/.gradle/wrapper` are restored from the cache before `./gradlew test` executes
- **AND** the test step does not re-download already-resolved dependencies.

#### Scenario: Gradle build-file change invalidates the cache

- **WHEN** a commit modifies a `*.gradle*` file or `gradle-wrapper.properties`
- **THEN** the backend job's Gradle cache key changes
- **AND** the job re-resolves and saves a fresh cache entry under the new key.

#### Scenario: E2E job's setup-java does not enable Gradle caching

- **WHEN** the e2e job's `actions/setup-java@v4` step runs
- **THEN** it is configured without `cache: gradle`
- **AND** no Gradle cache is restored or saved on the e2e job.

### Requirement: E2E job caches Playwright browser binaries per matrix shard

The e2e job SHALL include an `actions/cache@v4` step that caches `~/.cache/ms-playwright`, scheduled before the `playwright install` step. The cache key SHALL include the matrix browser name and a hash of `e2e/pnpm-lock.yaml`, with a `restore-keys` prefix that omits the lockfile hash so partial hits are possible. The `playwright install --with-deps ${{ matrix.browser }}` invocation SHALL run unconditionally — `playwright install` is a no-op when binaries are present, and `--with-deps` still installs apt system packages that are not covered by the cache.

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
