## ADDED Requirements

### Requirement: e2e job runs inside the official Playwright container, version-pinned to `@playwright/test`

The e2e job in `.github/workflows/ci.yml` SHALL declare a `container:`
block whose `image` is `mcr.microsoft.com/playwright:v<X.Y.Z>-noble`
where `<X.Y.Z>` matches the `@playwright/test` version pinned in
`e2e/pnpm-lock.yaml`. The `-noble` suffix MUST match the Ubuntu base of
the workflow's runner (`ubuntu-latest`). The workflow SHALL include a
fail-fast step that compares the image tag against the
`@playwright/test` version installed in `e2e/pnpm-lock.yaml` and exits
non-zero on mismatch, so the two-source-of-truth pin cannot drift
silently. The e2e job SHALL NOT execute a `playwright install-deps`
step — the container ships every system library the three browsers
need at runtime.

#### Scenario: e2e job declares the version-pinned container

- **WHEN** a reader opens `.github/workflows/ci.yml`
- **THEN** the `e2e` job declares a `container:` block
- **AND** the `image` value is `mcr.microsoft.com/playwright:v<X.Y.Z>-noble`
  where `<X.Y.Z>` equals the `@playwright/test` version pinned in
  `e2e/pnpm-lock.yaml`.

#### Scenario: Drift between the container tag and `@playwright/test` fails the workflow

- **WHEN** the workflow tag of the Playwright container image does not
  match the `@playwright/test` version in `e2e/pnpm-lock.yaml`
- **THEN** the fail-fast step in the e2e job exits non-zero
- **AND** the e2e job fails before Playwright tests are invoked
- **AND** the run log shows both the image tag and the
  `@playwright/test` version that disagreed.

#### Scenario: No `playwright install-deps` step exists

- **WHEN** a reader inspects the e2e job's step list
- **THEN** no step invokes `playwright install-deps` (with or without
  a `sudo` wrapper)
- **AND** no step uses the `for attempt in 1 2; do sudo --preserve-env=PATH timeout …`
  shell pattern that the previous workflow used to retry that step.

#### Scenario: Container ships the browser binaries the matrix shard runs

- **WHEN** the e2e job runs a matrix shard (chromium, firefox, or
  webkit) and the container tag matches `@playwright/test`
- **THEN** the browser binary for that shard is already present in
  the container's `~/.cache/ms-playwright` (or equivalent path)
- **AND** the retained `playwright install ${{ matrix.browser }}`
  step is effectively a no-op (Playwright reports the browser as
  already installed).

## MODIFIED Requirements

### Requirement: e2e job has Docker available so Testcontainers can boot Postgres

The e2e job SHALL run on a runner where Docker is available (e.g.,
`ubuntu-latest`, which includes Docker by default). The job SHALL NOT
install or rely on a separate Postgres service container declared via
the workflow's `services:` block — it SHALL let the Playwright
`globalSetup` provision Postgres via Testcontainers.

When the e2e job runs inside a container (see the
"e2e job runs inside the official Playwright container" requirement
above), the host's Docker socket SHALL be bind-mounted into the
container via the container's `options:` field (e.g.,
`options: --volume /var/run/docker.sock:/var/run/docker.sock`), so the
Testcontainers client inside the e2e container can talk to the host's
Docker daemon and spawn the Postgres container as a sibling of the
e2e container. The spawned Postgres container SHALL be reachable from
the e2e container at the Testcontainers-assigned host port via the
host's loopback interface (the same way Testcontainers exposes
container ports on a non-containerised runner). The e2e job SHALL
NOT configure a nested Docker-in-Docker daemon — only the
socket-mount sibling-container pattern is in scope.

#### Scenario: e2e job runs on a Docker-capable runner

- **WHEN** a reader opens the `e2e` job definition
- **THEN** `runs-on` is a runner that ships with Docker available
  (e.g., `ubuntu-latest`).

#### Scenario: No Postgres service container is declared in the workflow

- **WHEN** a reader inspects the `e2e` job
- **THEN** the job has no `services:` block declaring a Postgres
  container
- **AND** Postgres provisioning is delegated entirely to the
  harness's `globalSetup`.

#### Scenario: Docker socket is mounted into the e2e container

- **WHEN** a reader inspects the e2e job's `container:` block
- **THEN** the `options:` field includes a bind-mount of
  `/var/run/docker.sock` from host to container.

#### Scenario: Testcontainers Postgres is reachable from inside the e2e container

- **WHEN** the harness's `globalSetup` calls Testcontainers to spawn
  Postgres while the e2e job runs inside the Playwright container
- **THEN** Testcontainers spawns the Postgres container via the
  host's Docker daemon (sibling of the e2e container)
- **AND** the harness reaches Postgres at the host's loopback on
  the Testcontainers-assigned port
- **AND** the harness completes its Flyway migrations and seed
  fixtures before the first Playwright test runs.

### Requirement: E2E job caches Playwright browser binaries per matrix shard

The e2e job SHALL include an `actions/cache@v4` step that caches
`~/.cache/ms-playwright`, scheduled before any Playwright install
step that may run inside the job. The cache key SHALL include the
matrix browser name and a hash of `e2e/pnpm-lock.yaml`, with a
`restore-keys` prefix that omits the lockfile hash so partial hits
are possible. When the e2e job runs inside the official Playwright
container (see the "e2e job runs inside the official Playwright
container" requirement above), the cache step is a defence-in-depth
surface for the rare drift case where the container's bundled
browser binaries do not match the `@playwright/test` version pinned
in `e2e/pnpm-lock.yaml`; on a clean pin the cache is unused. The
job SHALL include a `playwright install ${{ matrix.browser }}` step
that runs unconditionally (a no-op when the container's binaries
already match the pin; reconciles via the cache or downloads
otherwise). The `playwright install` step SHALL be wrapped in a
bounded `nick-fields/retry@v3` invocation with `timeout_minutes`
strictly less than the e2e job's `timeout-minutes`, `max_attempts`
chosen so the cumulative wall-clock budget across attempts remains
strictly less than the e2e job's `timeout-minutes`, and
`retry_on: any` to cover both transient hangs and non-zero exits.
The `playwright install` step SHALL NOT escalate to root via
`sudo`. The cache step itself SHALL NOT be wrapped or retried.

#### Scenario: Cache step is present and keyed per matrix shard

- **WHEN** a reader inspects the e2e job
- **THEN** the job declares an `actions/cache@v4` step whose `path`
  is `~/.cache/ms-playwright`
- **AND** the cache `key` includes `${{ matrix.browser }}` and the
  hash of `e2e/pnpm-lock.yaml`
- **AND** the `restore-keys` includes a prefix that omits the
  lockfile hash.

#### Scenario: Clean pin — cache step is a no-op, no download runs

- **WHEN** the e2e job runs a matrix shard with the container tag
  matching `@playwright/test`
- **THEN** the `playwright install ${{ matrix.browser }}` step
  reports the browser as already installed
- **AND** no browser binary is downloaded from the CDN.

#### Scenario: Drifted pin — cache restore covers the gap

- **WHEN** the e2e job runs a matrix shard where the container tag
  is older than the `@playwright/test` version pinned in
  `e2e/pnpm-lock.yaml`, and a cache entry under
  `playwright-<os>-<browser>-<lockfile-hash>` exists
- **THEN** the cache step restores the cached binaries before
  `playwright install` runs
- **AND** `playwright install ${{ matrix.browser }}` reconciles
  from the cache without a fresh CDN download.

#### Scenario: Cold cache during drift — `playwright install` downloads

- **WHEN** the e2e job runs with a drifted pin and no matching
  cache entry exists
- **THEN** `playwright install ${{ matrix.browser }}` downloads
  the missing browser binary
- **AND** the cache step saves a fresh entry under the new
  lockfile-hashed key at the end of the job.

#### Scenario: `playwright install` step has a per-attempt timeout strictly less than the job timeout

- **WHEN** a reader inspects the e2e job's `playwright install`
  step
- **THEN** the step is wrapped in `nick-fields/retry@v3` with
  `timeout_minutes` strictly less than the e2e job's
  `timeout-minutes`
- **AND** `max_attempts` is bounded so the cumulative budget
  (`timeout_minutes × max_attempts`) is strictly less than the
  e2e job's `timeout-minutes`
- **AND** the step does NOT invoke `sudo`.

#### Scenario: Hanging install attempt is killed and retried

- **WHEN** a `playwright install` attempt hangs (e.g., CDN
  unresponsive on a cold-cache download) and exceeds the
  per-attempt timeout
- **THEN** the retry wrapper kills the attempt at its
  per-attempt timeout
- **AND** the wrapper starts a fresh attempt
- **AND** the job does NOT reach the e2e job's
  `timeout-minutes` cliff on the install step.

#### Scenario: Retry covers both hangs and non-zero exits

- **WHEN** a `playwright install` attempt exits non-zero from a
  transient failure (e.g., CDN-side TLS reset on the binary
  download) without exceeding the per-attempt timeout
- **THEN** the retry wrapper starts a fresh attempt
- **AND** the wrapper does NOT treat the non-zero exit as a
  permanent failure on the first attempt.

#### Scenario: Persistent failure surfaces a clear error after the bounded attempt count

- **WHEN** every attempt up to `max_attempts` fails (timeout or
  non-zero exit on each) for the `playwright install` step
- **THEN** the install step fails the e2e job
- **AND** the run log shows one log section per attempt with
  each attempt's stderr
- **AND** the job did not silently wait out the job-level
  `timeout-minutes`.
