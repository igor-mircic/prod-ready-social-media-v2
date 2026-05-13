# ci Specification

## Purpose
GitHub Actions workflow that runs on every push to `main` and every pull request, gating merges on backend tests, frontend tests, frontend build, and an OpenAPI contract drift check between the backend's generated spec and the committed `openapi/openapi.json`.
## Requirements
### Requirement: CI runs on every push to `main` and every pull request

The repository SHALL include a GitHub Actions workflow that triggers on every push to the `main` branch and on every pull request targeting any branch. The workflow SHALL run to completion (success or failure) before any merge is considered green.

#### Scenario: Push to main triggers CI

- **WHEN** a commit is pushed to the `main` branch
- **THEN** the GitHub Actions workflow runs
- **AND** its result is reported on the commit.

#### Scenario: Opening a pull request triggers CI

- **WHEN** a pull request is opened, reopened, or synchronized (a new commit is pushed to its head branch)
- **THEN** the GitHub Actions workflow runs
- **AND** its result is reported on the pull request as a check.

### Requirement: Backend job runs the backend test suite

CI SHALL include a backend job that runs `./gradlew test` from the `backend/` directory using Java 21 (Temurin distribution). The job SHALL fail if any backend test fails.

#### Scenario: Backend tests pass

- **WHEN** all tests in `backend/` pass under Java 21
- **THEN** the backend job's test step succeeds.

#### Scenario: Backend test failure fails CI

- **WHEN** any test in `backend/` fails
- **THEN** the backend job fails
- **AND** the overall workflow result is failure
- **AND** the failure blocks merge of the pull request (when run in PR context).

### Requirement: Backend job fails on `openapi/openapi.json` drift

CI SHALL regenerate `openapi/openapi.json` from the backend code on every run and SHALL fail the backend job if the regenerated file differs from the committed file. The failure message SHALL tell the contributor exactly how to regenerate the spec locally.

#### Scenario: Committed spec matches regenerated spec

- **WHEN** the backend job regenerates `openapi/openapi.json` via `./gradlew generateOpenApiDocs --no-configuration-cache`
- **AND** the regenerated file is byte-identical to the committed `openapi/openapi.json`
- **THEN** the drift-check step succeeds.

#### Scenario: Stale committed spec fails CI with an actionable message

- **WHEN** a backend change modifies a controller, DTO, or validation annotation in a way that changes the OpenAPI surface
- **AND** the contributor commits the change without regenerating `openapi/openapi.json`
- **THEN** the drift-check step fails
- **AND** the failure message tells the contributor to run `./gradlew generateOpenApiDocs --no-configuration-cache` from `backend/` and commit the result.

### Requirement: Frontend job installs, tests, and builds

CI SHALL include a frontend job that installs dependencies with `pnpm install --frozen-lockfile` (which runs the `postinstall` script and produces `frontend/src/api/generated/`), then runs `pnpm test`, then runs `pnpm build`. The job SHALL fail if any of those steps fail.

#### Scenario: Frontend pipeline passes

- **WHEN** `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build` all succeed in `frontend/`
- **THEN** the frontend job succeeds.

#### Scenario: Frontend test failure fails CI

- **WHEN** any vitest test in `frontend/` fails
- **THEN** the frontend job fails
- **AND** the overall workflow result is failure.

#### Scenario: Frontend type-check failure fails CI

- **WHEN** `pnpm build` fails because of a TypeScript type error (including in Orval-generated code that no longer matches a hand-written caller)
- **THEN** the frontend job fails
- **AND** the overall workflow result is failure.

### Requirement: pnpm version is sourced from `frontend/package.json`'s `packageManager` field

The frontend job's pnpm version SHALL be sourced from the `packageManager` field of `frontend/package.json`. The workflow SHALL NOT pin pnpm to a literal version string in `.github/workflows/ci.yml`. There SHALL be exactly one place in the repository that names the pnpm version.

#### Scenario: pnpm version is read from frontend/package.json

- **WHEN** the `pnpm/action-setup` step runs
- **THEN** it reads the pnpm version from `frontend/package.json`'s `packageManager` field
- **AND** it does NOT receive a literal `version:` input in the workflow YAML.

#### Scenario: Bumping the pnpm version requires editing only one file

- **WHEN** a contributor changes the `packageManager` field of `frontend/package.json` to a new pnpm version
- **AND** does not edit `.github/workflows/ci.yml`
- **THEN** the next CI run uses the new pnpm version
- **AND** local `corepack`-aware tooling also uses the new pnpm version.

#### Scenario: Missing pnpm version pin fails CI loudly

- **WHEN** the `packageManager` field is removed from `frontend/package.json` (or the workflow is misconfigured to read from a non-existent file)
- **THEN** the frontend job fails at the `pnpm/action-setup` step with a clear "no pnpm version specified" error
- **AND** does not silently fall back to a default version.

### Requirement: CI runs an end-to-end test job that depends on the backend and frontend jobs

CI SHALL include an `e2e` job that has `needs: [backend, frontend]`, so that it runs only after both upstream jobs succeed. The job SHALL fail if any e2e test fails. The job SHALL be a required check on every pull request — the workflow SHALL NOT skip it via path filters or run it in advisory (non-blocking) mode.

#### Scenario: e2e job declares dependency on backend and frontend

- **WHEN** a reader opens `.github/workflows/ci.yml`
- **THEN** there is an `e2e` job
- **AND** its `needs` field includes both `backend` and `frontend`.

#### Scenario: e2e failure fails the workflow and blocks merge

- **WHEN** any e2e test fails
- **THEN** the e2e job fails
- **AND** the overall workflow result is failure
- **AND** the failure blocks merge of the pull request.

#### Scenario: e2e job is not skipped by path filters

- **WHEN** a reader inspects the `e2e` job definition
- **THEN** the job has no `paths:` or `paths-ignore:` filter narrowing when it runs
- **AND** the job runs on every pull request to which the workflow itself runs.

### Requirement: Backend and frontend jobs upload their built artifacts for the e2e job to consume

The backend job SHALL produce its bootJar and upload it as a workflow artifact (e.g., via `actions/upload-artifact`) so the e2e job can download it. The frontend job SHALL produce `frontend/dist/` and upload it similarly. The e2e job SHALL download both artifacts and run Playwright against them, NOT rebuild them.

#### Scenario: Backend uploads the bootJar artifact

- **WHEN** the backend job completes successfully
- **THEN** the job has uploaded `backend/build/libs/<jar>` as a workflow artifact with a stable name (e.g., `backend-jar`).

#### Scenario: Frontend uploads the dist artifact

- **WHEN** the frontend job completes successfully
- **THEN** the job has uploaded `frontend/dist/` as a workflow artifact with a stable name (e.g., `frontend-dist`).

#### Scenario: e2e job consumes the uploaded artifacts

- **WHEN** the e2e job runs
- **THEN** it downloads both the backend JAR and the frontend dist artifacts before invoking Playwright
- **AND** it does NOT run `./gradlew bootJar` or `pnpm build` itself.

### Requirement: e2e job runs a chromium/firefox/webkit browser matrix

The e2e job SHALL be configured with a `strategy.matrix` over `browser: [chromium, firefox, webkit]`, so each browser runs as a parallel matrix leg. All three matrix legs SHALL be required for the workflow to succeed; failure on any one browser fails the workflow.

#### Scenario: Three browser matrix legs are configured

- **WHEN** a reader opens `.github/workflows/ci.yml`
- **THEN** the `e2e` job declares a `strategy.matrix` with browser values `chromium`, `firefox`, and `webkit`.

#### Scenario: Failure on a single browser fails the workflow

- **WHEN** the chromium leg passes but the firefox leg fails
- **THEN** the workflow result is failure
- **AND** merge is blocked.

### Requirement: e2e job uploads Playwright trace, video, and screenshot artifacts on failure

When the e2e job fails, it SHALL upload Playwright's failure artifacts (trace ZIPs, videos, screenshots) as a workflow artifact so a contributor can download them and reproduce the failure locally with `npx playwright show-trace`. The upload step SHALL run regardless of test outcome (`if: always()` or equivalent) so artifacts from failures are not lost.

#### Scenario: Failure artifacts upload step exists and runs on failure

- **WHEN** a reader inspects the `e2e` job
- **THEN** the job declares a step that uploads Playwright artifacts (e.g., `playwright-report/`, `test-results/`)
- **AND** the step runs even when prior steps fail (`if: always()` or `if: failure()`).

#### Scenario: Artifacts are downloadable from a failed run

- **WHEN** the e2e job fails on a pull request
- **THEN** the run summary lists the Playwright artifact
- **AND** a contributor can download it from the GitHub Actions UI.

### Requirement: e2e job uses the pnpm version pinned in `e2e/package.json`

The e2e job's pnpm version SHALL be sourced from the `packageManager` field of `e2e/package.json` (mirroring how the frontend job sources pnpm from `frontend/package.json`). The workflow SHALL NOT pin pnpm to a literal version string in `.github/workflows/ci.yml` for the e2e job.

#### Scenario: e2e job reads pnpm version from e2e/package.json

- **WHEN** the `pnpm/action-setup` step in the `e2e` job runs
- **THEN** it reads the pnpm version from `e2e/package.json`'s `packageManager` field
- **AND** it does NOT receive a literal `version:` input in the workflow YAML.

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

