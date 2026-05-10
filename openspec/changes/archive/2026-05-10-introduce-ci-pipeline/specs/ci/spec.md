## ADDED Requirements

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
