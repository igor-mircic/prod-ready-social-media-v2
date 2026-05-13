## Context

The e2e job in `.github/workflows/ci.yml` runs on `ubuntu-latest` and
installs every dependency it needs at job start. The slowest installer is
Playwright's `install-deps` step, which calls `apt-get install` for the
system libraries the three browsers (chromium, firefox, webkit) need at
runtime. The list is large: gstreamer + libmbedcrypto7t64 + libflite1 plus
the soundfont packages for audio testing. On a typical webkit shard run
the apt step alone burns ~2 minutes; combined with normal runner load
variance, that pushes the wall-clock between the harness's `loginViaApi`
and the next `apiClient.*` call past the harness's
`APP_AUTH_ACCESS_TOKEN_TTL=PT2S` window, surfacing as 401 flakes
(see `feed.spec.ts:171`, `follows.spec.ts:52` on the recent PR #29 rerun).

The e2e suite already caches the **browser binaries** themselves via
`actions/cache@v4` on `~/.cache/ms-playwright`, keyed on
`e2e/pnpm-lock.yaml`, and the cache reliably hits (PR #29 logs:
`Cache hit for: playwright-Linux-webkit-...`). What is not cached is the
apt-installed system libraries; those have no clean cache surface (the
existing `actions/cache@v4` for `~/.cache/ms-playwright` covers the
Playwright-managed downloads only, not the system-wide `/usr/lib/...`
shared-object install).

Microsoft publishes an official Playwright Docker image at
`mcr.microsoft.com/playwright:v<version>-noble` that ships:

- the browser binaries for chromium, firefox, webkit,
- every system library those browsers need at runtime,
- Node.js (matching the version the matching Playwright npm release was
  tested against),
- a non-root `pwuser` for runtime use.

Pinning that image to the same `@playwright/test` version
(currently 1.59.1) lets the e2e job skip `apt-get install` entirely and
start running tests within seconds. The complication this design has to
address is Testcontainers — the e2e harness's `globalSetup` spawns a
Postgres via Testcontainers, which needs Docker available to the test
process. When the job moves into a container, "Docker available" requires
mounting the host's Docker socket into the job container (the standard
hosted-runner Docker-in-Docker pattern).

## Goals / Non-Goals

**Goals:**

- The webkit shard's wall-clock between login and the first
  authenticated API call drops by ~2 minutes (the entire
  `install-deps` step is gone).
- All three matrix shards (chromium, firefox, webkit) run inside the
  same Playwright image, so their pre-test latency is uniform; there is
  no per-browser apt-deps difference.
- The slice-3 invariant "the e2e job has Docker available so the
  harness's globalSetup can spawn Testcontainers Postgres" is
  preserved — without declaring a `services:` Postgres block.
- The `~/.cache/ms-playwright` cache step continues to work as a
  defense in depth for the version-drift edge case (container image
  and `@playwright/test` pin out of sync), without becoming the
  load-bearing path.
- The change is invisible to the test code, the harness, the
  apiClient, and local-dev workflows. The only file modified is
  `.github/workflows/ci.yml` (plus the eventual spec sync).

**Non-Goals:**

- Fixing the apiClient's 2-second access-token-TTL flake at the
  source. A separate proposal teaches the apiClient to refresh on
  401.
- Containerising the `backend` or `frontend` jobs.
- Authoring a custom slim Docker image stripping browsers other
  matrix shards don't run.
- Removing the `~/.cache/ms-playwright` cache step.
- Switching the e2e runner from `ubuntu-latest` to anything else.

## Decisions

### Decision 1: Use Microsoft's official Playwright image, version-pinned to `@playwright/test`

**Chosen:** `container: image: mcr.microsoft.com/playwright:v1.59.1-noble`
on the e2e job. The `v1.59.1` tag is sourced from the
`@playwright/test@1.59.1` version pinned in `e2e/pnpm-lock.yaml`. The
`-noble` suffix matches the Ubuntu 24.04 base the project's `ubuntu-latest`
runner is on today.

**Alternative A: floating `v1.59`-prefix tag (Microsoft does not publish
this).** Microsoft only publishes exact-version tags + a `latest` tag.
Reading `latest` would couple CI behaviour to whichever version Microsoft
last published, with no relationship to the `@playwright/test` the
project has installed. Rejected.

**Alternative B: roll a custom slim Dockerfile that strips browsers a
matrix shard does not need.** Microsoft's image is ~1.5GB compressed; a
custom slim image (e.g., chromium-only for the chromium shard) could
drop ~500MB. Cost: a Dockerfile, a registry, a publish pipeline, and
ongoing maintenance to track Microsoft's image. Benefit: ~30 seconds
saved per shard on the pull step. Not worth the maintenance for a
learning-project monorepo. Rejected, recorded as a known follow-up if
the pull cost ever dominates.

**Alternative C: keep the host runner; cache `/var/cache/apt`.** Caching
the .deb files speeds up the network download but not the dpkg
installation; the install-deps step would still cost ~30 to 60 seconds.
Doesn't get rid of the sudo-retry wrapper either. Rejected.

**Why the version pin must match `@playwright/test`:** Playwright is a
two-part product — npm package + browser binaries (and the system
libraries the binaries need). The published image versions browser
binaries to match the npm package. Mismatched versions trigger the
"Looks like Playwright Test or Playwright was just installed or updated.
Please run the following command to download new browsers:
`pnpm exec playwright install`" warning at test time — which would
re-introduce the download we're trying to remove. The pin is therefore
load-bearing.

### Decision 2: Retain the `playwright install <browser>` step, drop the `install-deps` step

**Chosen:** Inside the container, the `Install Playwright browser
binaries` step continues to run (`pnpm exec playwright install
${{ matrix.browser }}`). The `Install Playwright system deps` step is
deleted along with its `for attempt in 1 2; do sudo timeout …` wrapper.

The `install` step is a no-op when the container image already ships
the matching browser binaries (the common case). It becomes load-bearing
only if `@playwright/test` is bumped ahead of the container image (or
vice versa), in which case it reconciles from the cache or downloads.

**Alternative A: drop both steps; rely on the image entirely.** Works
on the clean pin. Breaks the day a developer bumps `@playwright/test`
and forgets to bump the image tag — tests would fail with a confusing
"browser executable not found" error rather than a quick reinstall.
The retained `install` step is the safety net. Rejected.

**Alternative B: drop only the binaries step; keep `install-deps`.**
Symmetric of (A) but worse — `install-deps` is the slow step we are
trying to retire. Rejected.

### Decision 3: Mount the host Docker socket so Testcontainers continues to work

**Chosen:** Add `options: --volume /var/run/docker.sock:/var/run/docker.sock`
to the container configuration. Testcontainers' default behaviour is to
connect to `/var/run/docker.sock`; with the host socket bind-mounted into
the container, the Testcontainers client inside the e2e job talks to
the host's Docker daemon, which spawns the Postgres container as a
**sibling** of the e2e container (not nested). The two containers share
the host's default Docker bridge network; the e2e harness's
`globalSetup` reads `POSTGRESQL_PORT` from the Testcontainers-assigned
host port, the JDBC URL is built against `localhost:<port>` (host
loopback), and Testcontainers' Ryuk reaper cleans up after the run.

**Alternative A: declare a `services: postgres` block in the e2e job.**
The slice-3 spec explicitly forbids this — the harness's `globalSetup`
is what owns Postgres provisioning, so flyway migrations and seed-data
fixtures land in one place. Rejected.

**Alternative B: install a Docker-in-Docker daemon inside the
Playwright container.** Significantly more complex (dind requires
`--privileged`), introduces an extra Docker daemon process inside the
container, slower than socket-mount. Rejected.

**Alternative C: switch from Testcontainers to a workflow-level
`services:` Postgres.** Conflicts with the slice-3 spec; would also
break the e2e harness's local-dev parity (developers run e2e against
Testcontainers locally, so CI behaviour matching local matters).
Rejected.

**Failure mode preserved:** the slice-3 spec's "no Postgres service
container is declared in the workflow" scenario remains true — the
job has no `services:` block.

**Permission caveat:** the official Playwright image runs as the
`pwuser` user (uid 1000) by default. Testcontainers writes a few
artifact files (e.g., `~/.testcontainers.properties`); the home
directory is writable by `pwuser` in the image, so no permission
fixup is needed. The Docker socket has group `docker` on the host;
inside the container `pwuser` may not be a member of `docker`, so
we set `options: --user root` if the empirical first run shows a
permission denied on `/var/run/docker.sock`. Empirical first run
is part of the implementation tasks.

### Decision 4: Retain the `~/.cache/ms-playwright` cache step

**Chosen:** The existing `actions/cache@v4` step that restores
`~/.cache/ms-playwright` carries over unchanged. On the clean pin
(image matches `@playwright/test`), the cache is unused — the
container has the binaries already. On a drift (rare), the cache
provides graceful recovery without a fresh CDN download.

**Alternative: drop the cache step.** Simplest YAML, removes one
moving part. Cost: a `@playwright/test` bump that lands without a
matching image bump would re-download the browser binaries on every
shard until the image bump catches up. Recoverable but
embarrassing-on-pull-request. Rejected; the cache step is cheap.

### Decision 5: Keep the existing `setup-java@v4`, `setup-node@v4`, `pnpm/action-setup@v4` steps

**Chosen:** The Playwright image ships Node; it does not ship
the JDK. The e2e harness runs the backend bootJar, which needs
Java. `setup-java@v4` continues to run inside the container.

`setup-node@v4` is retained because it sets up the pnpm cache
directory in a way that matches the frontend job's setup
(consistency); the container's Node binary is what is actually
used at test time, but the `setup-node` action is harmless. If
empirical CI runs show the action conflicts with the
container's Node (e.g., PATH ordering), the action becomes a
candidate for removal — a low-priority follow-up.

`pnpm/action-setup@v4` reads `e2e/package.json`'s
`packageManager` field (a slice-3 invariant); preserved.

## Risks / Trade-offs

- **Risk:** Microsoft retires the `v1.59.1-noble` tag. → **Mitigation:**
  Microsoft retains historical tags indefinitely on `mcr.microsoft.com`;
  no recorded retirements of Playwright image tags exist. If retirement
  ever happens, the workflow's image tag is a one-line change.

- **Risk:** `pwuser` cannot access `/var/run/docker.sock` (group `docker`
  not present in the container). → **Mitigation:** Set
  `options: --user root` on the container if empirical first run
  surfaces the permission error. Both shapes documented in the
  implementation tasks.

- **Risk:** Testcontainers' Ryuk reaper has known caveats when running
  in a container with socket-mount — specifically, if the e2e
  container exits abruptly, Ryuk may leak Postgres containers. →
  **Mitigation:** GitHub Actions cleans up all sibling containers on
  workflow completion regardless of Ryuk's state; the leak window is
  bounded by the runner lifetime, and hosted runners are ephemeral.
  No production impact.

- **Risk:** The Playwright image is ~1.5GB compressed; pulling adds
  ~30 to 60 seconds per matrix leg on a cold runner. → **Mitigation:**
  GitHub's hosted runners cache the most recent layer of `mcr.*`
  images at the runner level; a warm runner sees a 5-second pull.
  Net: even with a cold pull on every leg, the apt-step savings
  outweigh the image-pull cost.

- **Risk:** Local dev parity — developers who run e2e locally do
  NOT use the container. They install Playwright system deps via
  `pnpm exec playwright install --with-deps` themselves. The
  documented dev loop in `e2e/README.md` already covers this. No
  change.

- **Risk:** Docker socket mount surface — if the e2e container is
  ever compromised by hostile test code, it could escape the
  container via the Docker socket. For a hosted runner running
  trusted in-house e2e tests this is acceptable; production
  deployments would gate this with stricter isolation. Recorded
  trade-off.

- **Trade-off accepted:** Two-source-of-truth pin (`@playwright/test`
  in `e2e/pnpm-lock.yaml` AND the `vX.Y.Z-noble` tag in the
  workflow YAML). A bump of one without the other is a known
  hazard. Mitigation: the implementation tasks include a CI
  assertion (a job step) that compares the two and fails fast on
  drift. Cheap; one shell line.
