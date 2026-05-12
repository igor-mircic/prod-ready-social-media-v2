## Why

The previous change `cache-ci-deps` added `cache: gradle` to the backend job's `actions/setup-java@v4` block, expecting it to be the primary Gradle cache. Post-merge CI log inspection showed the workflow already runs `gradle/actions/setup-gradle@v4` immediately after, and that action caches Gradle home by default — it was already saving and restoring across runs before `cache-ci-deps` merged. The result is two competing Gradle cache mechanisms on the same job: one load-bearing (`setup-gradle@v4`), one redundant (`setup-java@v4`'s `cache: gradle`). Removing the redundant one shrinks the cache footprint, cuts a post-job upload step, and removes the misleading signal that `setup-java` owns Gradle caching here.

## What Changes

- Remove `cache: gradle` from the backend job's `actions/setup-java@v4` step in `.github/workflows/ci.yml`.
- Leave `gradle/actions/setup-gradle@v4` as the sole Gradle cache mechanism — its default settings already cover both restore and save of `~/.gradle/caches`, `~/.gradle/notifications`, and `~/.gradle/.setup-gradle`.
- E2e job's `setup-java@v4` is already uncached (the previous change correctly left it that way). No change there.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `ci`: the "Backend job caches Gradle dependencies" requirement (added by `cache-ci-deps`) changes which workflow step provides the caching. Caching itself is still required — the mechanism is now `gradle/actions/setup-gradle@v4`'s default behavior rather than `setup-java@v4`'s `cache: gradle` option, and `setup-java@v4` is required NOT to enable its own redundant Gradle cache.

## Impact

- **Affected files**: `.github/workflows/ci.yml` only (one-line removal).
- **Cache footprint**: reclaims ~7 MB of cache storage per backend run and eliminates one post-job tar/upload step.
- **No correctness change**: Gradle home was already being cached and restored by `setup-gradle@v4` before this; that behavior is unchanged.
- **No application or test code changes.**
