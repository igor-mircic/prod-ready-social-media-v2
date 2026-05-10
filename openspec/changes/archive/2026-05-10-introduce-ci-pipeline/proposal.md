## Why

A `.github/workflows/ci.yml` was added during `add-api-contract-codegen` without an OpenSpec capability or any requirements behind it, so the most important guardrail in the contract pipeline (the `openapi.json` drift check) is undocumented and unprotected against accidental removal. The workflow is also currently failing on the frontend job because `pnpm/action-setup@v4` cannot find a pnpm version pin — it defaults to reading `./package.json` at the repo root, but in this flat monorepo the pin lives in `frontend/package.json` under `packageManager`. Both the `scaffold-spring-backend` and `scaffold-frontend` designs explicitly deferred the CI workflow to "a separate change"; this proposal cashes in that deferral and fixes the failure in the same step.

## What Changes

- Introduce a `ci` capability that owns the contract for what CI guarantees: triggers, jobs, and the openapi drift check.
- Adopt the existing `.github/workflows/ci.yml` as the implementation of that capability — spec-backing for what already exists, plus the bug fixes needed to make it actually pass on `main` and on PRs.
- Fix the frontend job: add `package_json_file: frontend/package.json` to the `pnpm/action-setup@v4` `with:` block so the action reads the `packageManager` pin from `frontend/package.json` instead of failing on a missing root `package.json`. The pin remains a single source of truth (used by local dev / corepack already).
- Fix the backend job: replace the never-validated headless-`codegen`-profile design with a Postgres service container so the springdoc-openapi gradle plugin can boot the full Spring context, hit `/v3/api-docs`, and run the drift check against a real DB. Remove the dead `codegen` profile from `application.yaml` and the `customBootRun.args` override from `build.gradle.kts`.
- Spec-level requirements lock in: CI runs on push to `main` and on every pull request; backend job runs `./gradlew test`; backend job regenerates `openapi/openapi.json` and fails on drift; frontend job installs with `--frozen-lockfile`, runs `pnpm test`, runs `pnpm build`; pnpm version is sourced from `frontend/package.json`'s `packageManager` field.

## Capabilities

### New Capabilities
- `ci`: GitHub Actions workflow that runs on every push to `main` and every pull request, gates merges on backend tests, frontend tests, frontend build, and the OpenAPI contract drift check between `backend/`'s generated spec and the committed `openapi/openapi.json`.

### Modified Capabilities
<!-- None. The fix to ci.yml is the implementation of the new `ci` capability, not a change to an existing capability's requirements. -->

## Impact

- **New file under spec**: `openspec/specs/ci/spec.md` (created on archive).
- **Modified file**: `.github/workflows/ci.yml` — `package_json_file:` addition under the `pnpm/action-setup@v4` step (frontend fix), and a Postgres `services:` block on the backend job (backend fix).
- **Modified file**: `backend/src/main/resources/application.yaml` — removed the `codegen` profile (dead code; never worked end-to-end, see D5).
- **Modified file**: `backend/build.gradle.kts` — removed the `customBootRun { args.set(...) }` block; `generateOpenApiDocs` now boots with default profiles against a real DB.
- **No production code changes** in `backend/` (only the dead-code removal above) or `frontend/`. The pin in `frontend/package.json` (`packageManager: pnpm@10.33.2`) is unchanged.
- **New tooling on CI runner**: a `postgres:16` service container on the backend job (no new build dependencies, no new test dependencies).
- **Unblocks**: future changes (e.g., e2e job, lint job, deploy job) can now extend a tracked capability instead of editing an untracked workflow.
