## 1. Workflow edit

- [x] 1.1 In `.github/workflows/ci.yml`, on the **backend** job's `actions/setup-java@v4` step, remove the `cache: gradle` line. Leave `distribution: temurin` and `java-version: 21` in place. Leave the `gradle/actions/setup-gradle@v4` step immediately below it untouched.
- [x] 1.2 Verify the e2e job's `actions/setup-java@v4` step is unchanged (no `cache: gradle`; it already had none).

## 2. Local verification

- [x] 2.1 Run `actionlint .github/workflows/ci.yml` to confirm the edited file is syntactically valid.
- [x] 2.2 Eyeball-diff against main to confirm the diff is exactly the one-line removal and nothing else changed.

## 3. PR and post-merge validation

- [x] 3.1 Open a PR off main titled "Dedupe Gradle cache on backend CI job" with a body explaining the redundancy discovered during cache-ci-deps post-merge log inspection.
- [x] 3.2 On the PR's CI run, confirm the backend job still passes and that the `setup-java@v4` step no longer emits any `Cache saved with the key: setup-java-Linux-x64-gradle-…` line, while `gradle/actions/setup-gradle@v4` continues to log a `gradle-home-v1|…` save/restore.
- [x] 3.3 After merge to main, observe the next backend run's logs and confirm only one Gradle cache mechanism is active (only `setup-gradle@v4`'s `gradle-home-v1` keys appear).
