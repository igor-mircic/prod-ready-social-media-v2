## 1. Gradle cache on backend job

- [x] 1.1 In `.github/workflows/ci.yml`, on the **backend** job's `actions/setup-java@v4` step, add `cache: gradle` alongside the existing `distribution` and `java-version` fields.
- [x] 1.2 Verify the e2e job's `actions/setup-java@v4` step is left unchanged (no `cache: gradle` added — it does not run Gradle).

## 2. Playwright browser cache on e2e job

- [x] 2.1 In the e2e job, add an `actions/cache@v4` step between `Install e2e deps (with codegen via postinstall)` and `Install Playwright browser (${{ matrix.browser }})`.
- [x] 2.2 Configure the cache step with `path: ~/.cache/ms-playwright`, `key: playwright-${{ runner.os }}-${{ matrix.browser }}-${{ hashFiles('e2e/pnpm-lock.yaml') }}`, and `restore-keys: playwright-${{ runner.os }}-${{ matrix.browser }}-`.
- [x] 2.3 Leave the existing `pnpm exec playwright install --with-deps ${{ matrix.browser }}` step unchanged — it must run unconditionally (no `if:` guard on cache hit).

## 3. Local verification

- [x] 3.1 Run `actionlint` (or equivalent YAML/workflow linter) against `.github/workflows/ci.yml` to confirm the edited file is syntactically valid.
- [x] 3.2 Eyeball-diff the workflow file against `main` to confirm no unrelated steps were touched and indentation matches surrounding YAML.

## 4. PR and post-merge validation

- [x] 4.1 Open a PR from the change branch off `main` with the title "Cache Gradle deps and Playwright browsers in CI" and a body listing both cache additions, expected wall-clock impact, and the stale-cache tradeoff.
- [x] 4.2 On the PR's CI run, confirm both setup-java behavior and Playwright install behavior remain green (this run will be a cold cache for both — it should still pass).
- [x] 4.3 After merge to `main`, observe the next backend job's `setup-java` step reports a Gradle cache save, and the e2e job's `actions/cache@v4` step reports a save for each matrix shard.
- [x] 4.4 On the **second** post-merge run (with no Gradle/lockfile changes), confirm the backend job restores a Gradle cache hit and each e2e shard restores its Playwright cache hit.
