## Why

Every CI run re-downloads Gradle dependencies on the backend job and Playwright browser binaries on each of the three e2e matrix shards (chromium, firefox, webkit). These are the two largest sources of unproductive wall-clock time on the workflow today, with no functional value — the lockfiles already pin exact versions, so the bytes fetched are identical across runs until a dependency bump lands.

## What Changes

- Add `cache: gradle` to the **backend** job's `actions/setup-java@v4` step so `~/.gradle/caches` and `~/.gradle/wrapper` are restored between runs, keyed off the Gradle build files.
- Add an `actions/cache@v4` step in the **e2e** matrix job, before `pnpm exec playwright install`, that caches `~/.cache/ms-playwright` with a per-browser key derived from `e2e/pnpm-lock.yaml`.
- Leave the e2e job's `actions/setup-java@v4` block uncached — it sets up a JRE to run the pre-built backend JAR but never invokes Gradle, so a Gradle cache there would never be populated or read.
- Always run `playwright install --with-deps ${{ matrix.browser }}` (no conditional skip on cache hit): `playwright install` is a no-op when binaries are already present, and `--with-deps` still needs to install apt system packages on each fresh runner.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `ci`: CI workflow gains caching for Gradle dependencies on the backend job and Playwright browser binaries on the e2e job. Job behavior and gating semantics are unchanged — only the install-time cost shifts.

## Impact

- **Affected files**: `.github/workflows/ci.yml` only.
- **Wall-clock savings**: Gradle dependency restore replaces multi-minute resolution + download on the backend job. Playwright cache saves ~30s per shard × 3 parallel shards on the e2e job.
- **Tradeoff**: Stale-cache debugging is a small ongoing tax when a transitive dep on the runner diverges from the committed lockfile. Mitigated by lockfile-hash cache keys with `restore-keys` for partial hits, so any lockfile change invalidates only the affected cache.
- **No application or test code changes.** The previously-merged `add-user-profile` change is not touched; its tests are not rerun as part of this change.
