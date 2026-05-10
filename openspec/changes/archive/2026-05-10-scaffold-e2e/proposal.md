## Why

Today nothing tests the real frontend talking to the real backend talking to a real database. The frontend's vitest suite mocks the backend with MSW, and the backend's tests don't exercise a browser. A regression in the wiring between the layers — CORS, proxy paths, generated client/server schema drift, real database constraints surfacing as 4xx responses, accessibility breakage — would slip through. The signup flow is now implemented end-to-end on both sides, so it is the right moment to stand up an e2e harness and verify the whole stack from a user's perspective.

The harness is being scaffolded production-grade from day one: tests run against the frontend's production build (`vite preview`) and the backend's actual JAR (`java -jar`), backed by a fresh Postgres provisioned per run via Testcontainers. No `vite dev`, no `bootRun`, no chromium-only matrix, no path-filtered CI, no skipped accessibility scans.

## What Changes

- Add a new top-level `e2e/` directory: a standalone Node project (own `package.json`, own `pnpm-lock.yaml`, own pnpm version pin) housing Playwright, Testcontainers, and the test suite.
- Generate a typed API client inside `e2e/` from the same `openapi/openapi.json` via Orval. Two consumers (frontend, e2e), one contract; no workspace coupling.
- Orchestrate the full stack from Playwright `globalSetup`: Testcontainers Postgres → backend JAR → `vite preview` → tests; teardown reverses the order.
- Implement day-one test scope: a smoke test, a signup happy path, a signup duplicate-email path that exercises a real 409 against a real DB, and signup field-validation cases. Every visited page is scanned with axe-playwright.
- Enforce production-grade test conventions: semantic locators (`getByRole`, `getByLabel`) only, no `waitForTimeout`, simple helper functions over page-object class hierarchies.
- Extend the CI workflow with a new e2e job that depends on the existing backend and frontend jobs, consumes their built artifacts, runs a chromium/firefox/webkit browser matrix, and uploads Playwright trace/video/screenshot artifacts on failure. The job is a required check on every PR.
- Add `preview.proxy` to the frontend's `vite.config.ts` mirroring the existing `server.proxy`, so `vite preview` can forward `/api/v1` and `/actuator` to the backend during e2e runs.

Out of scope for this change (deliberately): visual regression, mobile viewport matrix, login/logout flows (no login feature exists yet), per-worker DB schema isolation, page-object class hierarchies, and any commitment to a production deployment topology (Spring-serves-SPA vs split nginx+Spring) — that decision belongs to a future `infra/` change.

## Capabilities

### New Capabilities
- `e2e`: end-to-end test harness — directory layout, Playwright configuration, Testcontainers-driven Postgres, JAR-based backend, `vite preview` frontend, browser matrix, semantic-locator and a11y discipline, signup + smoke test scenarios, and failure-artifact retention.

### Modified Capabilities
- `monorepo-layout`: `e2e/` now contains real content (it was previously reserved as an empty-by-policy placeholder).
- `ci`: a new e2e job is added with dependencies on the backend and frontend jobs, a browser matrix, artifact upload on failure, and required-check status.
- `frontend-scaffold`: `vite.config.ts` gains a `preview.proxy` block mirroring `server.proxy`, enabling production-build serving with API forwarding.

## Impact

- **New code**: `e2e/` directory (Playwright + Testcontainers harness, Orval-generated API client, test suite, README).
- **Modified code**: `frontend/vite.config.ts` (add `preview.proxy`); `.github/workflows/ci.yml` (new `e2e` job, artifact upload between jobs, browser matrix).
- **No backend code changes**: Spring Boot already honours `SPRING_DATASOURCE_URL` and supports running as a JAR. The harness drives configuration entirely through environment variables.
- **New dev dependencies** (in `e2e/` only): `@playwright/test`, `testcontainers`, `@axe-core/playwright`, `orval`, TypeScript toolchain. None added to `frontend/` or `backend/`.
- **CI runtime**: a new e2e job adds wall-clock time to PR pipelines (Spring Boot cold-start + browser matrix). Trade-off accepted as a "no shortcuts" decision.
- **Deployment topology**: deliberately not committed — the harness uses `vite preview` + standalone JAR purely as a test-time arrangement and does not pre-empt the future `infra/` decision.
