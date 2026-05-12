## Context

`.github/workflows/ci.yml` runs three jobs on every push and pull request: `backend`, `frontend`, and `e2e` (matrix over chromium/firefox/webkit). pnpm caching is already configured on both `setup-node` steps via `cache: pnpm`. Two dependency channels are still uncached:

1. **Gradle.** The backend job's `actions/setup-java@v4` block has no `cache:` field, so each run resolves and downloads the full Gradle dependency graph and any wrapper distribution under `~/.gradle/`.
2. **Playwright browsers.** The e2e job runs `pnpm exec playwright install --with-deps ${{ matrix.browser }}` once per matrix shard. Browser binaries land in `~/.cache/ms-playwright` and are re-downloaded fresh each run because the runner image does not persist them.

Playwright is pinned at `1.59.1` in `e2e/pnpm-lock.yaml`. The e2e job's `setup-java` block exists so the JRE is available to launch the pre-built backend JAR; it does not invoke Gradle.

## Goals / Non-Goals

**Goals:**
- Cache `~/.gradle/caches` and `~/.gradle/wrapper` on the backend job so repeat runs skip dependency download and most of the resolution phase.
- Cache `~/.cache/ms-playwright` on the e2e job so each matrix shard restores its browser binaries instead of downloading them.
- Keep the diff minimal and surgical — only the cache wiring changes, no unrelated step edits.

**Non-Goals:**
- Caching anything in the `frontend` job (pnpm is already cached; nothing else is large).
- Caching Gradle on the e2e job's `setup-java` block — that JDK only runs the pre-built JAR.
- Caching apt-installed system packages from `--with-deps`. They are outside `~/.cache/ms-playwright` and re-resolving them is cheap.
- Skipping `playwright install` on cache hit. `playwright install` is a no-op when binaries are present, so unconditional invocation is both simpler and safer.
- Modifying or rerunning any tests from the previously-merged `add-user-profile` change.

## Decisions

### 1. `cache: gradle` on backend job's `setup-java@v4` only

Set `cache: gradle` on the `actions/setup-java@v4` step inside the `backend` job. This delegates to the built-in Gradle caching path: `~/.gradle/caches` and `~/.gradle/wrapper`, keyed off `**/*.gradle*` and `**/gradle-wrapper.properties` under the working directory.

**Alternative considered:** `gradle/actions/setup-gradle@v4` (already present below the `setup-java` step) supports its own caching configuration. Reason to prefer the `setup-java` built-in: it's a one-line change with the same effective cache scope, no need to pass options to the `setup-gradle` action, and it matches the same pattern as the existing `cache: pnpm` on `setup-node`.

**Why not on the e2e job's `setup-java`:** That job only runs the pre-built JAR — it never executes `./gradlew`. There is nothing to populate `~/.gradle/caches` with, so the cache would store empty state and restore nothing useful. Adding `cache: gradle` there is dead code.

### 2. Per-browser Playwright cache key

Cache `~/.cache/ms-playwright` with:

```
key: playwright-${{ runner.os }}-${{ matrix.browser }}-${{ hashFiles('e2e/pnpm-lock.yaml') }}
restore-keys: |
  playwright-${{ runner.os }}-${{ matrix.browser }}-
```

The e2e job is a parallel matrix over three browsers, and each shard installs only its own browser. A shared (cross-browser) cache key would have all three shards racing to save the same key with a single-browser payload — the winner's save would force the other two shards to download their browser on the next run anyway. Per-browser keys make each shard's cache stand on its own.

**Alternative considered:** extract the resolved Playwright version from `e2e/pnpm-lock.yaml` (`@playwright/test@1.59.1` line) and use that as the key suffix instead of the lockfile hash. Rejected because (a) per-browser scoping already keeps caches small enough that lockfile-hash invalidation costs at most one shard re-download, and (b) lockfile-hash needs no extra workflow step. The version-string approach was only attractive when a single shared key was on the table.

### 3. `restore-keys` fallback for partial hits

With `restore-keys: playwright-${{ runner.os }}-${{ matrix.browser }}-`, a lockfile change that bumps an unrelated e2e dependency still gets a partial hit. `playwright install` then either confirms the binaries are already correct (no-op) or downloads only what the new version requires. Either way, the cache save at the end of the job re-keys to the new lockfile hash.

### 4. Cache step placement

The cache step goes between `Install e2e deps` and `Install Playwright browser` — after pnpm deps are in place (so the install step's environment is fully ready), and before `playwright install` (so a hit can short-circuit the download).

## Risks / Trade-offs

- **Stale-cache debugging** → Lockfile-hash keys make invalidation predictable: any change to `e2e/pnpm-lock.yaml` mints a new key. Backend Gradle uses the same pattern via `setup-java`'s built-in. When a transitive dep on the runner appears to mismatch the lockfile, the standard fix is a one-time `gh cache delete` for the affected key, then re-run.
- **Cache save races on matrix jobs** → Per-browser keys eliminate this for Playwright. Gradle is on a single non-matrix job, so no race.
- **Cache miss on first run after this change** → Expected and one-time. Each cache populates on the first post-merge run and then accelerates subsequent runs.
- **`--with-deps` still runs apt** → System packages are reinstalled on every shard. Acceptable: apt install on GitHub-hosted runners with the standard package set is fast (~10s), and caching apt state introduces more failure surface than it would save.

## Migration Plan

This is a workflow-only change with no runtime or schema impact. The first push after merge will populate caches; subsequent runs benefit. Rollback is `git revert` of a single commit if a cache key proves problematic — there is no state outside GitHub's cache layer to clean up.
