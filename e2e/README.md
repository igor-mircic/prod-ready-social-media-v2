# e2e

Playwright end-to-end harness for the production-built frontend talking to the
production-built backend over a Testcontainers-managed Postgres. Standalone
Node project — not a member of any pnpm workspace.

## Prerequisites

- **Docker** running locally (Testcontainers spawns a Postgres container per run).
- **Node** at the version pinned in `e2e/.nvmrc` (mirrored by `engines.node` in
  `package.json`). Use `nvm use` from this directory.
- **pnpm** — version pinned via `packageManager` in `package.json`. Corepack
  picks it up automatically; `npm install -g corepack@latest && corepack enable`
  if you need to bootstrap.
- **Java 21+** on `PATH` for running the backend JAR.
- A built backend JAR at `../backend/build/libs/*.jar` (run `./gradlew bootJar`
  in `backend/`) and a built frontend at `../frontend/dist/` (run `pnpm build`
  in `frontend/`).

## Install

```sh
pnpm install
```

`postinstall` runs `orval` to regenerate the typed API client under
`src/api/generated/` from `../openapi/openapi.json`. The generated directory is
git-ignored.

You also need Playwright browser bundles the first time:

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
```

## Run the suite

```sh
pnpm test
```

This runs all tests across every configured browser (chromium, firefox, webkit).
The Playwright `globalSetup`:

1. Boots a Postgres container via Testcontainers.
2. Spawns the backend JAR with `SPRING_DATASOURCE_*` pointed at that container
   and waits until `/actuator/health` reports `UP`.
3. Spawns `vite preview` against `../frontend/dist/` and waits for `GET /`.

`globalTeardown` reverses the order.

### Run a single browser

```sh
pnpm exec playwright test --project=chromium
```

### Run a single test file

```sh
pnpm exec playwright test tests/signup.happy.spec.ts
```

## Inspect a CI failure

When the e2e job fails on CI, the workflow uploads
`e2e/playwright-report/` and `e2e/test-results/` as a workflow artifact named
`playwright-<browser>-<run-id>`.

1. Open the failed run in GitHub Actions and download the artifact for the
   browser whose leg failed.
2. Unzip it locally.
3. Open the trace for the failing test:

   ```sh
   npx playwright show-trace path/to/test-results/<test>/trace.zip
   ```

The trace UI lets you scrub the timeline, inspect every DOM snapshot, and
replay every network request the test made — typically enough to pinpoint a
failure without re-running the suite.

The `test-results/` directory also contains video and screenshot artifacts for
each failing test.

## Conventions

- **Locators**: `getByRole`, `getByLabel`, `getByText`. No `data-testid`, no
  CSS selectors as primary strategy.
- **Waits**: rely on Playwright auto-waiting locators and `expect` matchers.
  No `page.waitForTimeout`.
- **Accessibility**: `@axe-core/playwright` scans every visited page via the
  shared `test` fixture in `src/fixtures/test.ts`. Violations fail the test.
- **API setup**: pre-conditions (e.g., "a user already exists") are built via
  the typed API client (`src/helpers/apiClient.ts`), not by driving the UI.
- **Helpers over POMs**: simple functions in `src/helpers/`, no class
  hierarchies.

## Layout

```
e2e/
├── orval.config.ts             # Codegen config (reads ../openapi/openapi.json)
├── playwright.config.ts        # Playwright projects, fixtures, lifecycle
├── src/
│   ├── api/generated/          # Orval output (gitignored)
│   ├── fixtures/
│   │   ├── axe.ts              # axe-playwright runner
│   │   ├── baseURL.ts          # state-file-driven baseURL resolver
│   │   └── test.ts             # project-wide `test` export
│   ├── helpers/
│   │   ├── apiClient.ts        # Typed fetch client over the Orval SDK
│   │   └── signup.ts           # randomSignupInput, signupViaApi
│   └── setup/
│       ├── postgres.ts         # Testcontainers Postgres
│       ├── backend.ts          # java -jar orchestration
│       ├── frontend.ts         # vite preview orchestration
│       ├── global-setup.ts     # Postgres → backend → frontend
│       ├── global-teardown.ts  # frontend → backend → Postgres
│       └── state.ts            # JSON state file shared across lifecycle
└── tests/
    ├── smoke.spec.ts
    ├── signup.happy.spec.ts
    ├── signup.duplicate.spec.ts
    └── signup.validation.spec.ts
```
