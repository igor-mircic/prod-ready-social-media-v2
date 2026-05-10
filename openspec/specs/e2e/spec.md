# e2e Specification

## Purpose
TBD - created by syncing change scaffold-e2e. Update Purpose after archive.

## Requirements
### Requirement: E2E module is a standalone Node project at the repo root

The repo SHALL contain an `e2e/` directory at the top level holding a standalone Node project that is NOT a member of any pnpm workspace and does NOT share dependencies with `frontend/`. The project SHALL declare its own `package.json`, commit its own `pnpm-lock.yaml`, and pin its own pnpm version via the `packageManager` field. The project SHALL pin its supported Node version via both `.nvmrc` and `engines.node` in `package.json`.

#### Scenario: e2e directory exists with its own project files

- **WHEN** a reader inspects the repo
- **THEN** `e2e/package.json`, `e2e/pnpm-lock.yaml`, `e2e/.nvmrc`, and `e2e/tsconfig.json` exist
- **AND** there is no `pnpm-workspace.yaml` at the repo root that includes `e2e`
- **AND** `e2e/package.json` does NOT declare `frontend` or any other in-repo package as a dependency.

#### Scenario: pnpm version and Node version are pinned

- **WHEN** a reader opens `e2e/package.json`
- **THEN** the `packageManager` field is set to a specific pnpm version (e.g., `pnpm@<version>`)
- **AND** the `engines.node` field declares a constraint compatible with `e2e/.nvmrc`.

### Requirement: Playwright is the e2e test framework

The `e2e/` project SHALL use Playwright (`@playwright/test`) as the test framework, configured via `e2e/playwright.config.ts`. The configuration SHALL declare a `globalSetup` and `globalTeardown` script and SHALL set `forbidOnly: true` so that focused tests cannot land in the suite.

#### Scenario: Playwright config exists and references global lifecycle scripts

- **WHEN** a reader opens `e2e/playwright.config.ts`
- **THEN** the config sets `globalSetup` to a TypeScript file under `e2e/`
- **AND** sets `globalTeardown` to a TypeScript file under `e2e/`
- **AND** sets `forbidOnly: true`.

#### Scenario: Playwright is the only test runner

- **WHEN** a reader inspects `e2e/package.json`
- **THEN** `@playwright/test` is declared as a `devDependency`
- **AND** no other test runner (e.g., vitest, jest, mocha) is declared.

### Requirement: A typed API client is generated from `openapi/openapi.json`

The `e2e/` project SHALL include an `orval.config.ts` that reads `../openapi/openapi.json` and emits a typed fetch-based API client into `e2e/src/api/generated/`. The generated directory SHALL be ignored by git. The project SHALL run codegen automatically as part of `pnpm install` via a `postinstall` script. The generated client SHALL be consumed by test helpers for API-level setup (such as pre-creating users) and assertions (such as confirming server-side state without raw SQL).

#### Scenario: Orval config points at the shared OpenAPI document

- **WHEN** a reader opens `e2e/orval.config.ts`
- **THEN** the config reads its OpenAPI input from `../openapi/openapi.json`
- **AND** writes its output under `e2e/src/api/generated/`.

#### Scenario: Codegen runs on install

- **WHEN** a developer runs `pnpm install` inside `e2e/` from a clean clone
- **THEN** the `postinstall` script invokes `orval`
- **AND** `e2e/src/api/generated/` is populated.

#### Scenario: Generated output is not committed

- **WHEN** the repo is inspected
- **THEN** `e2e/.gitignore` excludes `src/api/generated/`
- **AND** no files under `e2e/src/api/generated/` are tracked by git.

### Requirement: Playwright `globalSetup` boots Postgres, backend, and frontend before tests run

Before any test executes, `globalSetup` SHALL: (1) start a Postgres container via Testcontainers and capture its connection URL, username, and password; (2) start the backend by invoking `java -jar` against `backend/build/libs/<jar>` with `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, and `SPRING_DATASOURCE_PASSWORD` set from the container's connection info, and wait until `GET /actuator/health` returns 200; (3) start the frontend by invoking `vite preview` against `frontend/dist/` and wait until `GET /` returns 200. `globalTeardown` SHALL stop the frontend, the backend, and the Postgres container, in that order.

#### Scenario: globalSetup orchestrates the full stack

- **WHEN** Playwright runs the suite
- **THEN** `globalSetup` starts a Postgres container via Testcontainers
- **AND** spawns `java -jar` for the backend with `SPRING_DATASOURCE_URL` pointed at the container
- **AND** waits for `GET /actuator/health` to return 200 before continuing
- **AND** spawns `vite preview` for the frontend against `frontend/dist/`
- **AND** waits for `GET /` on the preview server to return 200 before tests start.

#### Scenario: globalTeardown stops everything it started

- **WHEN** the test run completes (success or failure)
- **THEN** `globalTeardown` stops the `vite preview` process
- **AND** stops the backend `java` process
- **AND** stops the Postgres container.

### Requirement: The harness uses production-built artifacts, not development servers

The harness SHALL run the frontend's production build via `vite preview` against `frontend/dist/`, NOT the Vite dev server. The harness SHALL run the backend as `java -jar` against the JAR produced by `./gradlew bootJar`, NOT `./gradlew bootRun`. The harness SHALL NOT start either application in a development-only mode.

#### Scenario: Frontend is served by vite preview, not vite dev

- **WHEN** the harness's frontend orchestration code is inspected
- **THEN** the spawned command is `vite preview` (or `pnpm exec vite preview`)
- **AND** is NOT `vite` (dev) or `vite dev`.

#### Scenario: Backend is run as a JAR, not via bootRun

- **WHEN** the harness's backend orchestration code is inspected
- **THEN** the spawned command is `java -jar <path-to-jar>`
- **AND** is NOT `./gradlew bootRun`.

### Requirement: Each run gets a fresh Postgres; tests within a run isolate via UUID-based unique data

The harness SHALL provision a fresh Postgres container for every run, so cross-run state cannot leak. Within a single run, tests SHALL share that one container and SHALL isolate from each other by using UUID-based unique values for any field that participates in a uniqueness constraint (e.g., `email`).

#### Scenario: Each run starts a fresh container

- **WHEN** the harness runs twice in succession
- **THEN** each run boots its own Postgres container
- **AND** state from the first run is not visible to the second run.

#### Scenario: Tests use UUID-based unique emails

- **WHEN** a test creates a signup
- **THEN** the email passed to the form is constructed from `randomUUID()` (e.g., `user-<uuid>@example.test`)
- **AND** no two tests share the same email value.

### Requirement: Tests use semantic locators

Tests SHALL select elements using semantic Playwright locators (`getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`, `getByAltText`). Tests SHALL NOT use `data-testid`-based locators or CSS-selector-based locators (`page.locator('.foo')`, `page.locator('#bar')`) as the primary strategy.

#### Scenario: Suite uses semantic locators

- **WHEN** a reader greps the test suite under `e2e/tests/`
- **THEN** all matched element selections use `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`, or `getByAltText`
- **AND** there are no calls to `page.locator(...)` with a CSS selector
- **AND** there are no `getByTestId` calls.

### Requirement: Tests do not use `waitForTimeout`

Tests SHALL NOT call `page.waitForTimeout` or any other fixed-duration sleep. All waits SHALL rely on Playwright's auto-waiting locators (e.g., `expect(locator).toBeVisible()`, `expect(page).toHaveURL(...)`) or on event-based waits (`waitFor`, `waitForResponse`, `waitForLoadState`).

#### Scenario: No fixed-duration sleeps appear in the suite

- **WHEN** a reader greps the test suite under `e2e/`
- **THEN** there are no calls to `page.waitForTimeout(...)`
- **AND** there are no calls to a `setTimeout`-based sleep helper.

### Requirement: Every visited page is scanned with axe-playwright

The harness SHALL run an axe-playwright accessibility scan on every page that a test visits, before the test completes. Any axe violation SHALL fail the test. The scan SHALL be configured via a Playwright fixture or a `test.beforeEach`/`test.afterEach` hook so individual tests do not need to invoke it explicitly.

#### Scenario: Axe scan runs without per-test boilerplate

- **WHEN** a reader inspects an individual test file under `e2e/tests/`
- **THEN** the test does NOT manually call axe
- **AND** the project's Playwright fixtures or hooks invoke axe automatically on every page navigation.

#### Scenario: Axe violations fail the test

- **WHEN** a tested page contains an axe-detected accessibility violation
- **THEN** the test fails with an error sourced from the axe report
- **AND** the violation details are visible in the Playwright trace.

### Requirement: Tests run on chromium, firefox, and webkit

The Playwright configuration SHALL define three projects, one each for chromium, firefox, and webkit, using Playwright's official browser bundles. The full suite SHALL pass on all three browsers; failure on any one browser is a suite failure.

#### Scenario: Three browser projects are configured

- **WHEN** a reader opens `e2e/playwright.config.ts`
- **THEN** the `projects` array contains an entry whose `use.browserName` is `chromium`
- **AND** an entry whose `use.browserName` is `firefox`
- **AND** an entry whose `use.browserName` is `webkit`.

### Requirement: Failure artifacts (trace, video, screenshot) are produced for failing tests

The Playwright configuration SHALL be set so that on test failure a trace (`trace.zip`), a video, and a screenshot are produced. On test pass these SHALL NOT be retained (or shall be retained on retry only), to avoid bloating CI artifacts.

#### Scenario: Trace, video, screenshot are configured for failure

- **WHEN** a reader opens `e2e/playwright.config.ts`
- **THEN** `use.trace` is set to `on-first-retry` or `retain-on-failure`
- **AND** `use.video` is set to `on-first-retry` or `retain-on-failure`
- **AND** `use.screenshot` is set to `only-on-failure`.

### Requirement: Day-one test scope covers smoke and signup only

The suite SHALL include exactly the following user-flow tests on day one and no others:

- a smoke test asserting `GET /` renders the SPA root and `GET /actuator/health` returns 200;
- a signup happy-path test that fills the form with valid input, submits, asserts the success state renders, and verifies via the typed API client that the user is now persisted;
- a signup duplicate-email test that pre-creates a user via the typed API client and then drives the form with the same email, asserting the form renders the ProblemDetail's `detail` text;
- a signup validation test that drives the form with each invalid input case (short password, malformed email, oversized displayName) and asserts an inline error appears and no network request is fired.

#### Scenario: Smoke test exists

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a smoke test asserting both `/` and `/actuator/health` respond as required.

#### Scenario: Signup happy path test exists

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that fills the signup form with valid input, submits, asserts the success state renders, and uses the typed API client to confirm the user exists.

#### Scenario: Signup duplicate-email test exists

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that pre-creates a user via the typed API client and then drives the form with the same email, asserting the rendered error text matches the ProblemDetail's `detail`.

#### Scenario: Signup validation test exists

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that drives the form with a short password, a malformed email, and an oversized displayName
- **AND** asserts an inline error appears for each
- **AND** asserts no network request is fired while the form is invalid.

### Requirement: Test setup uses the typed API client where possible; UI is reserved for the behavior under test

For preconditions not under test (such as "a user already exists" for the duplicate-email test), the suite SHALL build state by calling the typed API client directly. The suite SHALL drive the UI only for the behavior the test is verifying.

#### Scenario: Duplicate-email test uses the API client to pre-create the user

- **WHEN** a reader opens the signup duplicate-email test
- **THEN** the existing-user precondition is created by calling the typed API client (signup mutation) directly
- **AND** the form is then driven through the UI for the behavior under test.

### Requirement: README documents how to run the suite locally and how to read CI failure artifacts

The `e2e/` project SHALL contain a `README.md` documenting the prerequisites (Docker available locally, Node at the pinned version, pnpm), the commands to run the suite (`pnpm install`, `pnpm test`), and the procedure for downloading and inspecting Playwright trace artifacts from a failed CI run.

#### Scenario: README covers local-run and CI-failure-debug paths

- **WHEN** a reader opens `e2e/README.md`
- **THEN** the file lists Docker, Node (with the pinned version or pointer to `.nvmrc`), and pnpm as prerequisites
- **AND** documents `pnpm install` as the install path
- **AND** documents `pnpm test` (or equivalent) as the run path
- **AND** describes how to download Playwright trace, video, and screenshot artifacts from a CI run and how to open the trace with `npx playwright show-trace`.
