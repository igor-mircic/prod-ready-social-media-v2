## 1. Fix the failing frontend job

- [x] 1.1 Edit `.github/workflows/ci.yml`: under the `pnpm/action-setup@v4` step in the `frontend` job, add a `with:` block containing `package_json_file: frontend/package.json`.
- [x] 1.2 Verify the workflow YAML is valid (no other steps changed; `cache-dependency-path: frontend/pnpm-lock.yaml` on the `actions/setup-node@v4` step is still present and correct).

## 2. Verify the fix

- [ ] 2.1 Push the branch and open a pull request to trigger CI.
- [ ] 2.2 Confirm the `frontend` job's `pnpm/action-setup@v4` step succeeds (no "No pnpm version is specified" error).
- [ ] 2.3 Confirm the `frontend` job's install / test / build steps run and pass.
- [ ] 2.4 Confirm the `backend` job (test + openapi drift check) is unaffected and passes.

## 3. Validate the proposal artifacts

- [x] 3.1 Run `openspec validate introduce-ci-pipeline` and confirm no errors.
- [x] 3.2 Confirm `openspec/changes/introduce-ci-pipeline/specs/ci/spec.md` is present and the `## ADDED Requirements` section contains all five requirements named in the design.

## 4. Archive

- [ ] 4.1 Once the PR is reviewed and CI is green, archive the change (`openspec archive introduce-ci-pipeline`), which creates `openspec/specs/ci/spec.md` from the delta and moves the change folder under `openspec/changes/archive/`.
- [ ] 4.2 Update `openspec/specs/ci/spec.md`'s `## Purpose` line from the post-archive `TBD` placeholder to a one-line description of the `ci` capability (matching the convention used by the other capabilities in `openspec/specs/`).
