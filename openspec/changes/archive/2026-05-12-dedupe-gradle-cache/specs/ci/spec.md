## MODIFIED Requirements

### Requirement: Backend job caches Gradle dependencies

The backend job SHALL cache Gradle home (`~/.gradle/caches`, `~/.gradle/notifications`, and `~/.gradle/.setup-gradle`) across runs via `gradle/actions/setup-gradle@v4`'s default caching behavior, so that repeat builds restore previously-resolved dependencies without re-downloading them. The backend job's `actions/setup-java@v4` step SHALL NOT enable its own `cache: gradle` option, because doing so creates a redundant second cache covering overlapping paths under `~/.gradle/`. No other job's `setup-java@v4` block enables Gradle caching, because no other job invokes Gradle.

#### Scenario: Backend job restores Gradle cache on repeat runs

- **WHEN** the backend job runs on a commit whose Gradle home cache key matches a previous successful run (via `setup-gradle@v4`'s `gradle-home-v1` key or its restore-key prefix)
- **THEN** `~/.gradle/caches`, `~/.gradle/notifications`, and `~/.gradle/.setup-gradle` are restored from the cache before `./gradlew test` executes
- **AND** the test step does not re-download already-resolved dependencies.

#### Scenario: Gradle build-file change still benefits from restore-keys

- **WHEN** a commit modifies a `*.gradle*` file or `gradle-wrapper.properties`
- **THEN** `setup-gradle@v4` may still restore a partial cache via its restore-key prefix
- **AND** the job re-resolves only what is missing and saves a fresh cache entry under the new key.

#### Scenario: Backend `setup-java@v4` does not double-cache Gradle

- **WHEN** a reader inspects the backend job's `actions/setup-java@v4` step
- **THEN** it is configured WITHOUT `cache: gradle`
- **AND** no `setup-java-…-gradle-…` cache entry is saved or restored by the backend job.

#### Scenario: E2E job's setup-java does not enable Gradle caching

- **WHEN** the e2e job's `actions/setup-java@v4` step runs
- **THEN** it is configured without `cache: gradle`
- **AND** no Gradle cache is restored or saved on the e2e job.
