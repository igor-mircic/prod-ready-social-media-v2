# containerize-e2e-job

## Why

The e2e job's slowest step today is `playwright install-deps webkit`, which
`apt-get install`s the gstreamer + libmbedcrypto7t64 + libflite1 + audio /
soundfont system libraries webkit needs at runtime. On a typical run that
step alone burns ~2 minutes (visible in PR #29's failing webkit shard at
7m16s vs the prior commit's 3m58s). The browser **binaries** are already
cached via `actions/cache@v4` on `~/.cache/ms-playwright` and the cache is
hitting; the apt step is not covered by that cache and re-installs every
run. That extra 2 minutes of wall-clock is what occasionally pushes the
webkit shard past the e2e harness's `APP_AUTH_ACCESS_TOKEN_TTL=PT2S`
window, surfacing as 401 flakes (e.g., `feed.spec.ts:171`,
`follows.spec.ts:52`).

Microsoft publishes an official Playwright Docker image
(`mcr.microsoft.com/playwright:v<version>-noble`) that ships **both** the
browser binaries and every system library the three browsers need at
runtime. Pinning that image to the same `@playwright/test` version the
project uses (currently `1.59.1`, pinned in `e2e/pnpm-lock.yaml`) lets the
e2e job skip `apt-get install` entirely and start running tests within
seconds of job start.

This change is **CI-only**. It does not touch the e2e tests, the access
token TTL, or the apiClient. The complementary fix — making the apiClient
resilient to expired access tokens — is a separate proposal so the two
concerns land on independent timelines.

## What Changes

- **CI — `e2e` job runs inside the official Playwright container.** Add
  `container:` to the e2e job in `.github/workflows/ci.yml` pointing at
  `mcr.microsoft.com/playwright:v1.59.1-noble`, version-pinned to match
  the `@playwright/test` version installed in `e2e/pnpm-lock.yaml`.
- **CI — the `Install Playwright system deps` step is removed.** The
  container already ships every system library the three browsers need;
  re-installing them is pure waste. Removing the step also retires the
  `sudo --preserve-env=PATH timeout … pnpm exec playwright install-deps`
  retry-loop wrapper that exists today only because that step is flaky
  on the apt mirror.
- **CI — the `Install Playwright browser binaries` step is retained but
  simplified.** When the container's bundled binaries already match the
  installed `@playwright/test` version (the common case after a clean
  pin), `playwright install <browser>` is effectively a no-op (a
  second-level "already installed" check). If the project bumps
  `@playwright/test` ahead of the container image (or vice versa), the
  step reconciles the missing binaries from the cache or downloads
  them. The step keeps its `nick-fields/retry@v3` wrapper since the
  rare cold-cache download path can still hit the same transient
  network conditions the wrapper was added for; the sudo-children
  hazard the slice-3 spec calls out does not apply because this step
  never escalates to root.
- **CI — the `~/.cache/ms-playwright` cache step is retained.** The
  cache becomes load-bearing only when the container image drifts from
  the project's Playwright pin; on the common-case clean pin the cache
  is unused. Cost of retaining it is one `actions/cache@v4` step;
  benefit is graceful behaviour during version drift without a
  workflow edit. The cache step's current key shape (per-browser plus
  `e2e/pnpm-lock.yaml` hash, with a lockfile-less restore-key prefix)
  carries over unchanged.
- **CI — Testcontainers preservation: Docker socket is mounted into
  the container.** The slice-3 invariant that the e2e job has Docker
  available so the Playwright `globalSetup` can spawn a Testcontainers
  Postgres is preserved by adding `options: --volume
  /var/run/docker.sock:/var/run/docker.sock` to the container
  configuration. Inside the Playwright container the Testcontainers
  client then talks to the host's Docker daemon, which spawns the
  Postgres container as a sibling of the e2e container (the standard
  hosted-runner DinD pattern). The job continues to NOT declare a
  `services:` Postgres block.
- **CI — the e2e job's pre-container setup steps are simplified.**
  `actions/setup-node@v4`, `actions/setup-java@v4`, and
  `pnpm/action-setup@v4` continue to run inside the container; the
  container ships its own Node binary which matches the version the
  project would otherwise install, so the explicit `setup-node` step
  is retained only for the pnpm cache directory plumbing the
  `setup-node` action does on top of the Node binary. The Java setup
  step is retained because the e2e harness invokes the backend
  bootJar (Java runtime). No fundamental change to which tools the
  job uses.

### Explicit non-goals (deferred to follow-ups)

- **Fixing the apiClient's lack of token refresh.** The 2-second
  access-token TTL flake has a separate root cause: the e2e
  apiClient is raw `fetch` with no refresh, and a CI run slower
  than 2 seconds between login and an API call returns 401. A
  separate proposal SHALL teach the apiClient to refresh on 401.
  This proposal narrows the flake window by making CI faster but
  does not close it.
- **Containerising the `backend` or `frontend` jobs.** Those jobs
  are fast (under 1 minute combined apt) and have no DinD
  complication; no payoff vs the e2e job.
- **Replacing the Playwright image with a slimmer custom image.**
  Microsoft's image is ~1.5GB compressed. A custom slim image that
  strips browsers the matrix shard does not run would save pull
  time but adds a Dockerfile + registry maintenance burden. Not
  worth it for three browsers on a hosted runner with adequate
  pull bandwidth.
- **Removing the `~/.cache/ms-playwright` cache step.** Retained
  for the version-drift edge case; revisiting depends on observed
  pull-vs-cache cost balance.

## Capabilities

### Modified Capabilities

- `ci` — modifies one requirement (the existing "E2E job caches
  Playwright browser binaries per matrix shard" requirement, whose
  detailed wording about a `playwright install-deps` step and a
  sudo-aware retry wrapper no longer reflects the e2e job's shape
  after this change) and modifies one requirement (the existing
  "e2e job has Docker available" requirement, which now must spell
  out the Docker-socket bind-mount that keeps Testcontainers
  working when the job runs inside a container).

### Touched-but-not-modified Capabilities (cited for clarity)

- `e2e` — no changes. Playwright config, test code, fixtures, and
  the harness's globalSetup are all untouched. The container
  switch is invisible to the test suite.
- `backend`, `frontend`, `posts`, `follows`, `feed`,
  `user-accounts`, `observability`, `api-contract`,
  `monorepo-layout` — no changes. The container switch lives
  entirely inside one CI job.

## Impact

- **CI:** Modified — `.github/workflows/ci.yml`'s e2e job declares
  a `container:` block, drops the `Install Playwright system deps`
  step, simplifies the `Install Playwright browser binaries` step
  (keeps the retry wrapper, drops the sudo-aware variant), and
  mounts the host Docker socket so Testcontainers continues to
  work.
- **Docker images pulled by CI:** New —
  `mcr.microsoft.com/playwright:v1.59.1-noble` pulled once per
  matrix leg per run (cached at runner level by GitHub's Docker
  pull-through cache). ~1.5 GB compressed.
- **OpenSpec specs:**
  - Modified at archive time: `openspec/specs/ci/spec.md` — the
    "E2E job caches Playwright browser binaries per matrix shard"
    requirement is rewritten to remove the `install-deps` /
    sudo-retry language; the "e2e job has Docker available"
    requirement is rewritten to spell out the Docker-socket
    bind-mount.
- **Backend, frontend, e2e test code:** No changes.
- **Dependencies (npm / Gradle):** No changes.
- **Database:** No migrations. No schema changes.
- **Local dev loop:** No changes. Developers still run e2e
  locally via `pnpm exec playwright test`; the container switch
  affects CI only.
