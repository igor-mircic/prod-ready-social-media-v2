## Why

A `.github/workflows/ci.yml` was added during `add-api-contract-codegen` without an OpenSpec capability or any requirements behind it, so the most important guardrail in the contract pipeline (the `openapi.json` drift check) is undocumented and unprotected against accidental removal. The workflow is also currently failing on the frontend job because `pnpm/action-setup@v4` cannot find a pnpm version pin — it defaults to reading `./package.json` at the repo root, but in this flat monorepo the pin lives in `frontend/package.json` under `packageManager`. Both the `scaffold-spring-backend` and `scaffold-frontend` designs explicitly deferred the CI workflow to "a separate change"; this proposal cashes in that deferral and fixes the failure in the same step.

## What Changes

- Introduce a `ci` capability that owns the contract for what CI guarantees: triggers, jobs, and the openapi drift check.
- Adopt the existing `.github/workflows/ci.yml` as the implementation of that capability — no new tooling, just spec-backing for what already exists.
- Fix the frontend job: add `package_json_file: frontend/package.json` to the `pnpm/action-setup@v4` `with:` block so the action reads the `packageManager` pin from `frontend/package.json` instead of failing on a missing root `package.json`. The pin remains a single source of truth (used by local dev / corepack already).
- Spec-level requirements lock in: CI runs on push to `main` and on every pull request; backend job runs `./gradlew test`; backend job regenerates `openapi/openapi.json` and fails on drift; frontend job installs with `--frozen-lockfile`, runs `pnpm test`, runs `pnpm build`; pnpm version is sourced from `frontend/package.json`'s `packageManager` field.

## Capabilities

### New Capabilities
- `ci`: GitHub Actions workflow that runs on every push to `main` and every pull request, gates merges on backend tests, frontend tests, frontend build, and the OpenAPI contract drift check between `backend/`'s generated spec and the committed `openapi/openapi.json`.

### Modified Capabilities
<!-- None. The fix to ci.yml is the implementation of the new `ci` capability, not a change to an existing capability's requirements. -->

## Impact

- **New file under spec**: `openspec/specs/ci/spec.md` (created on archive).
- **Modified file**: `.github/workflows/ci.yml` — single-line addition under the `pnpm/action-setup@v4` step.
- **No code changes** in `backend/` or `frontend/`. The pin in `frontend/package.json` (`packageManager: pnpm@10.33.2`) is unchanged.
- **No new dependencies, no new tooling.**
- **Unblocks**: future changes (e.g., e2e job, lint job, deploy job) can now extend a tracked capability instead of editing an untracked workflow.
