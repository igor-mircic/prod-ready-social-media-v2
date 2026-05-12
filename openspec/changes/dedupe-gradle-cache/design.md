## Context

`.github/workflows/ci.yml`'s backend job currently configures Gradle caching twice:

```yaml
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: 21
    cache: gradle                       # ← redundant (added by cache-ci-deps)

- uses: gradle/actions/setup-gradle@v4  # ← caches Gradle home by default
```

Logs from the first post-merge run of `cache-ci-deps` (commit `d343c18`) confirm both mechanisms ran independently:

- `setup-gradle@v4` reported a restore-key hit against the previous merge's cache (`gradle-home-v1|Linux-X64|backend[…]-d065892…`), then saved a fresh entry under the new commit's key.
- `setup-java@v4` reported `gradle cache is not found` (first run for its own key format) and saved its own ~7 MB tarball under `setup-java-Linux-x64-gradle-a9b6420…`.

On the re-run (same commit, second attempt), both restored cleanly:

- `setup-java@v4`: `Cache hit for: setup-java-Linux-x64-gradle-a9b6420…`
- `setup-gradle@v4`: cache hit on its `gradle-home-v1` key.

So both work, both write to overlapping paths under `~/.gradle/`, and both consume cache storage. Only `setup-gradle@v4` is needed.

## Goals / Non-Goals

**Goals:**
- Make `gradle/actions/setup-gradle@v4` the sole Gradle cache mechanism on the backend job.
- Remove the redundant `cache: gradle` option from the backend job's `setup-java@v4` step.
- Keep the spec accurate about which step provides Gradle caching, so future readers don't add the redundant line back.

**Non-Goals:**
- Switching the action version or configuration of `setup-gradle@v4` itself — its defaults are already correct.
- Touching any other cache (Playwright cache from `cache-ci-deps` is unaffected and stays exactly as merged).
- Modifying the e2e job's `setup-java@v4` (correctly uncached today; design choice preserved).
- Removing or reverting any other part of `cache-ci-deps`.

## Decisions

### 1. Rely on `gradle/actions/setup-gradle@v4`'s default cache, not `setup-java@v4`'s opt-in

`setup-gradle@v4`'s default cache key scheme (`gradle-home-v1|Linux-X64|backend[<hash>]-<sha>`) is more granular than `setup-java@v4`'s (`setup-java-Linux-x64-gradle-<hash>`):

- `setup-gradle@v4` keys include the commit SHA with a configuration-files hash as a restore-key prefix, so unrelated commits with identical Gradle files restore via the prefix and then re-save under the new SHA. That gives near-perfect hit rates without forcing a full re-resolve on every commit.
- `setup-java@v4`'s key is purely a hash of `*.gradle*` + `gradle-wrapper.properties`. Same hit shape for the common case, but with a smaller, less complete payload (it omits `~/.gradle/notifications` and `~/.gradle/.setup-gradle`).

Picking one mechanism: `setup-gradle@v4` wins because it's Gradle-specific, more granular, and was already in the workflow before `cache-ci-deps`. The `cache: gradle` on `setup-java@v4` adds nothing on top.

**Alternative considered:** keep both as a "defense in depth" double-cache. Rejected — both write to overlapping subpaths under `~/.gradle/`, so the loser-of-the-restore race just gets shadowed; the second restore can also re-overlay stale data on top of a fresh state. Two caches doing the same job aren't redundant in a useful way.

### 2. Spec says "caching is required, mechanism is `setup-gradle@v4`'s defaults"

The existing requirement (added by `cache-ci-deps`) currently reads as "`setup-java@v4`'s step SHALL enable Gradle caching (via the action's built-in `cache: gradle` option)". This change rewrites the requirement to mandate that:

- Gradle home (`~/.gradle/caches`, `~/.gradle/notifications`, `~/.gradle/.setup-gradle`) is cached across runs by `gradle/actions/setup-gradle@v4`'s default behavior.
- The backend job's `setup-java@v4` step does NOT enable its own `cache: gradle` option (to avoid the double-cache).
- The e2e job's `setup-java@v4` continues to have no Gradle caching (unchanged from `cache-ci-deps`).

This way the spec captures the lesson learned, not just the mechanic.

### 3. Pin version, trust defaults

`setup-gradle@v4` is already pinned to the major version. If a future v5 ships with caching disabled by default, that's a breaking change worth noticing — the version bump itself is the gate. We don't need an explicit `cache-disabled: false` belt-and-suspenders today; the action's logged config already shows `cache-disabled: false` and `cache-read-only: false` on every run.

## Risks / Trade-offs

- **Reliance on a third-party default** → Mitigated by pinning to `@v4`. A v5 with different defaults would require an explicit version bump on our side, which is the moment to re-evaluate. Action's runtime log already prints the cache configuration values, so a regression would be visible in CI output without us having to add assertions.
- **Brief cold-cache window after merge** → Not really; `setup-gradle@v4` keeps using the same key format it already was, so it'll keep hitting the same cache entries that exist today. Only the now-removed `setup-java-Linux-x64-gradle-…` entry will fall off (no replacement needed).

## Migration Plan

Workflow-only change with no runtime impact. After merge, the first backend run will simply skip the `setup-java@v4` cache step (no save, no restore) while `setup-gradle@v4` continues its normal save/restore cycle. Rollback is a one-line revert if anything surprising surfaces.
