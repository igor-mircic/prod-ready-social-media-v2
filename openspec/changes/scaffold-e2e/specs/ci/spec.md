## ADDED Requirements

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

### Requirement: e2e job has Docker available so Testcontainers can boot Postgres

The e2e job SHALL run on a runner where Docker is available (e.g., `ubuntu-latest`, which includes Docker by default). The job SHALL NOT install or rely on a separate Postgres service container declared via the workflow's `services:` block — it SHALL let the Playwright `globalSetup` provision Postgres via Testcontainers.

#### Scenario: e2e job runs on a Docker-capable runner

- **WHEN** a reader opens the `e2e` job definition
- **THEN** `runs-on` is a runner that ships with Docker available (e.g., `ubuntu-latest`).

#### Scenario: No Postgres service container is declared in the workflow

- **WHEN** a reader inspects the `e2e` job
- **THEN** the job has no `services:` block declaring a Postgres container
- **AND** Postgres provisioning is delegated entirely to the harness's `globalSetup`.
