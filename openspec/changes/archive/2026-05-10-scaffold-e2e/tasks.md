## 1. Workspace bootstrap

- [x] 1.1 Create the `e2e/` directory at the repo root.
- [x] 1.2 Create `e2e/package.json` with `name`, `private: true`, `type: "module"`, a `packageManager` field pinning a specific pnpm version, and an `engines.node` constraint.
- [x] 1.3 Add `e2e/.nvmrc` with the Node version that mirrors `engines.node`.
- [x] 1.4 Add `e2e/tsconfig.json` configured for Node 22 + ESM with strict TypeScript settings.
- [x] 1.5 Add `e2e/.gitignore` excluding `node_modules/`, `src/api/generated/`, `playwright-report/`, `test-results/`, and `.playwright/`.
- [x] 1.6 Run `pnpm install` once inside `e2e/` to produce the initial `pnpm-lock.yaml`; commit the lockfile.

## 2. Dependencies

- [x] 2.1 Add `@playwright/test` to `e2e/package.json` `devDependencies`.
- [x] 2.2 Add `testcontainers` (the Node Testcontainers package) to `e2e/package.json` `devDependencies`.
- [x] 2.3 Add `@axe-core/playwright` to `e2e/package.json` `devDependencies`.
- [x] 2.4 Add `orval` to `e2e/package.json` `devDependencies`.
- [x] 2.5 Add `typescript`, `@types/node` to `e2e/package.json` `devDependencies`.
- [x] 2.6 Run `pnpm install`; verify Playwright CLI works (`pnpm exec playwright --version`).
- [x] 2.7 Run `pnpm exec playwright install --with-deps chromium firefox webkit` once locally to confirm browser bundles install.

## 3. API client codegen

- [x] 3.1 Create `e2e/orval.config.ts` configured to read `../openapi/openapi.json` and emit a typed fetch-based client to `e2e/src/api/generated/`.
- [x] 3.2 Add a `postinstall: "orval"` script in `e2e/package.json` so codegen runs automatically on `pnpm install`.
- [x] 3.3 Re-run `pnpm install` and confirm `e2e/src/api/generated/` is populated and ignored by git.
- [x] 3.4 Add a sanity test import in a TypeScript scratch file confirming the generated client types are usable; remove the scratch file afterwards.

## 4. Playwright config and stack orchestration

- [x] 4.1 Create `e2e/playwright.config.ts` with `globalSetup`, `globalTeardown`, `forbidOnly: true`, `use.trace: 'retain-on-failure'`, `use.video: 'retain-on-failure'`, `use.screenshot: 'only-on-failure'`, and a `projects` array for chromium/firefox/webkit.
- [x] 4.2 Create `e2e/src/setup/postgres.ts` that uses `testcontainers` to start a Postgres container, exposes `start()`/`stop()` helpers, and writes the connection info into a JSON state file under `.playwright/` so `globalTeardown` can reach it.
- [x] 4.3 Create `e2e/src/setup/backend.ts` that spawns `java -jar` against `../backend/build/libs/<jar>` (path resolved via a glob), passes `SPRING_DATASOURCE_URL`/`SPRING_DATASOURCE_USERNAME`/`SPRING_DATASOURCE_PASSWORD` from the Postgres container, and exposes a `start()`/`stop()` interface that polls `/actuator/health` until 200.
- [x] 4.4 Create `e2e/src/setup/frontend.ts` that spawns `pnpm --dir ../frontend exec vite preview --port <picked-port>` against `../frontend/dist/` and polls `GET /` until 200.
- [x] 4.5 Create `e2e/src/setup/global-setup.ts` that orchestrates Postgres → backend → frontend startup in order and writes resolved URLs into the state file.
- [x] 4.6 Create `e2e/src/setup/global-teardown.ts` that reads the state file and stops frontend → backend → Postgres in order.
- [x] 4.7 Resolve `baseURL` for Playwright tests from the state file (e.g., via a fixture in `e2e/src/fixtures/baseURL.ts`) so tests target the dynamically picked vite preview port.

## 5. Frontend `vite.config.ts` change

- [x] 5.1 Edit `frontend/vite.config.ts` to add a `preview.proxy` block mirroring the existing `server.proxy`: forward `/api/v1` (with `changeOrigin: true`) and `/actuator` to `http://localhost:8080`.
- [x] 5.2 Verify locally: build the frontend (`pnpm build`), start the backend, start `vite preview`, and confirm in-browser requests to `/api/v1/auth/signup` and `/actuator/health` reach the backend.

## 6. Test fixtures and helpers

- [x] 6.1 Create `e2e/src/fixtures/axe.ts`, a Playwright fixture that runs an `@axe-core/playwright` scan on every page navigation via `page.on('framenavigated', ...)` (or via a `test.afterEach`) and fails the test on any violation.
- [x] 6.2 Wire the axe fixture into a project-wide `test` export at `e2e/src/fixtures/test.ts` so all tests use it by default.
- [x] 6.3 Create `e2e/src/helpers/apiClient.ts` exporting a typed fetch client built on top of the Orval-generated SDK and the resolved baseURL.
- [x] 6.4 Create `e2e/src/helpers/signup.ts` exporting `randomSignupInput()` (returns valid signup data with a UUID-based email and reasonable defaults) and `signupViaApi(client, input)` (calls the typed signup mutation).

## 7. Tests

- [x] 7.1 Add `e2e/tests/smoke.spec.ts` asserting `GET /` returns 200 and the SPA root mounts (e.g., a stable accessible heading is visible) and `GET /actuator/health` returns 200.
- [x] 7.2 Add `e2e/tests/signup.happy.spec.ts`: navigate to the signup page, fill the form via `getByRole`/`getByLabel`, submit, assert the success state renders, and verify via the typed API client that a duplicate-signup attempt returns 409.
- [x] 7.3 Add `e2e/tests/signup.duplicate.spec.ts`: pre-create a user via `signupViaApi`, then drive the form with the same email, assert the inline error renders the ProblemDetail's `detail`.
- [x] 7.4 Add `e2e/tests/signup.validation.spec.ts`: drive the form with each invalid case (short password, malformed email, oversized displayName), assert an inline error appears for each, and assert no network request is fired (using `page.on('request', ...)` to track signup requests).
- [x] 7.5 Run the full suite locally (`pnpm test`) on chromium and confirm all four tests pass.
- [x] 7.6 Run the full suite locally on firefox and webkit; fix any browser-specific issues.

## 8. CI integration

- [x] 8.1 Edit `.github/workflows/ci.yml`: in the existing `backend` job, add a step that uploads `backend/build/libs/*.jar` as the `backend-jar` artifact via `actions/upload-artifact`.
- [x] 8.2 In the existing `frontend` job, add a step that uploads `frontend/dist/` as the `frontend-dist` artifact.
- [x] 8.3 Add a new `e2e` job with `needs: [backend, frontend]` and `runs-on: ubuntu-latest`.
- [x] 8.4 In the `e2e` job, add `strategy.matrix.browser: [chromium, firefox, webkit]` and `fail-fast: false`.
- [x] 8.5 In the `e2e` job, add steps to: checkout, set up Java 21, set up Node, set up pnpm via `pnpm/action-setup` reading from `e2e/package.json`'s `packageManager` field, download both upstream artifacts to their expected paths (`backend/build/libs/`, `frontend/dist/`), `pnpm install` inside `e2e/`, install Playwright browsers (`pnpm exec playwright install --with-deps ${{ matrix.browser }}`), and run tests for the matrix browser only (`pnpm exec playwright test --project=${{ matrix.browser }}`).
- [x] 8.6 In the `e2e` job, add an `if: always()` final step that uploads `e2e/playwright-report/` and `e2e/test-results/` as a workflow artifact named `playwright-${{ matrix.browser }}-${{ github.run_id }}`.
- [x] 8.7 Update branch-protection expectations / merge-gating to require the `e2e` matrix legs as required checks (document this in the PR description if branch protection is configured outside the repo).

## 9. Documentation

- [x] 9.1 Create `e2e/README.md` documenting prerequisites (Docker available locally, Node at the pinned version, pnpm), the install command (`pnpm install`), the run command (`pnpm test`), how to run a single browser (`pnpm exec playwright test --project=chromium`), and how to download a CI artifact and open the trace with `npx playwright show-trace`.
- [x] 9.2 Update the repo root `README.md` to mention `e2e/` as an existing top-level directory housing the Playwright end-to-end harness; remove `e2e/` from the "reserved for future" list.

## 10. Verification

- [x] 10.1 Run the full e2e suite locally (`pnpm test` in `e2e/`) on chromium, firefox, and webkit and confirm green.
- [x] 10.2 Open a PR; confirm the new `e2e` job runs on all three browsers, all matrix legs are green, and a forced failure produces the trace/video/screenshot artifact correctly.
- [x] 10.3 Run `openspec validate scaffold-e2e --strict` and confirm the change validates.
