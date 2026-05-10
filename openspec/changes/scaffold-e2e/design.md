## Context

The repo currently has three layers under test in isolation. The backend has its own JUnit/Spring tests; the frontend has vitest + MSW (which mocks the backend); CI runs both, plus an OpenAPI drift check. None of those exercise a real browser against a real backend against a real database, so wiring-level regressions (CORS, proxy paths, server-side validation surfacing as user-visible errors, real DB constraints triggering 4xx, accessibility regressions) can land green.

The signup flow is the first feature implemented end-to-end on both sides — a `POST /api/v1/auth/signup` endpoint backed by Flyway-managed `users` table on the backend, and a signup form using the Orval-generated React Query mutation hook on the frontend. Standing up the e2e harness now bounds the scaffolding decision: the harness only needs to test smoke + signup on day one, but its shape sets the tone for everything that comes after.

The user has an explicit "production-grade from day one, no shortcuts" stance: real production builds, full browser matrix, required CI check, accessibility scans, semantic locators, no `waitForTimeout`. Several decisions follow directly from that stance and are not re-litigated below; this document records the decisions where the production-grade stance still left genuine alternatives.

## Goals / Non-Goals

**Goals:**

- Stand up a Playwright harness that runs the production-built frontend against the production-built backend against a real Postgres, in both local and CI execution.
- Cover the signup flow end-to-end: happy path, duplicate-email conflict (real 409 from a real DB), and field validation (real 400). Plus a smoke test for `/` and `/actuator/health`.
- Establish conventions that scale: semantic locators, no implicit waits, axe-playwright a11y scan on every visited page, simple helper functions over premature page-object abstractions.
- Make the e2e job a required CI check on every PR, with a chromium/firefox/webkit matrix and trace/video/screenshot artifacts uploaded on failure.
- Keep `e2e/` decoupled from `frontend/`: standalone Node project, own lockfile, own pnpm pin, its own Orval codegen reading the same `openapi/openapi.json`.
- Keep deployment-topology decisions out of this change.

**Non-Goals:**

- Deciding whether production will run "Spring serves SPA" or "split nginx + Spring". The harness uses `vite preview` + standalone JAR purely as a test arrangement.
- Visual regression testing.
- Mobile viewport matrix.
- Login/logout/session tests — no login feature exists yet; in-scope only when login lands.
- Per-worker or per-test database schema isolation. Within a single run, tests share one Postgres and isolate via UUID-based unique data; each *new run* gets a fresh container.
- Page-object class hierarchies. One feature does not justify a class taxonomy.
- Modifying backend code. The harness drives the existing Spring Boot JAR via standard environment variables.

## Decisions

### Decision 1: Topology — defer, use a "test-only" arrangement

The harness serves the frontend via `vite preview` (Vite's first-party "production-build, locally" tool) on its own port and runs the backend as `java -jar` on its own port. The frontend's `vite.config.ts` gains a `preview.proxy` block mirroring `server.proxy`, so `/api/v1/**` and `/actuator/**` requests from the served SPA are forwarded to the backend during tests.

**Rationale:** A real production deployment will ultimately pick "Spring serves the SPA from the same JAR" or "split nginx/CDN serves the SPA, Spring serves only the API". Either choice has follow-on consequences (CORS surface, build pipeline, infra). Since `infra/` does not exist yet, the harness sidesteps the choice by using a test-time arrangement that does not commit to either. `vite preview` is not a production server, but it serves real production-built artifacts and is a well-understood Vite primitive — using it here is a transparent test-time scaffold, not a production claim.

**Alternatives considered:**

- *Spring serves the SPA*: simplest, no proxy needed, but commits the project to a deployment shape before `infra/` decides.
- *Split arrangement with nginx in a sidecar container during e2e*: more production-shaped, but redundant complexity for tests that don't yet care about CORS.
- *Run frontend `vite dev`*: rejected per the user's no-shortcuts stance — `vite dev` is not the artifact CI ships.

### Decision 2: Database isolation — Testcontainers from the e2e harness

Playwright `globalSetup` boots a Postgres container via Testcontainers, captures its random-port connection string, and exports it into the backend process as `SPRING_DATASOURCE_URL` / `SPRING_DATASOURCE_USERNAME` / `SPRING_DATASOURCE_PASSWORD`. The backend's existing Flyway migration runs on startup against the fresh container. `globalTeardown` stops the container.

Within a single run, tests share that one container and isolate from each other via UUID-based unique emails (e.g., `user-${randomUUID()}@example.test`). Across runs, every run gets a fresh container.

**Rationale:** The e2e harness owns its world. The harness orchestrates its own dependencies rather than assuming the dev `docker-compose.yml` is already running. UUID-per-test inside a per-run container gives true clean state at the run boundary (no cross-run contamination) and pragmatic isolation within the run (no cross-test collisions on UNIQUE constraints), without requiring backend changes.

**Alternatives considered:**

- *Per-worker postgres schema*: rigorous, but requires real Spring/Flyway wiring (request routing of schema, schema-per-startup, etc.) — backend code changes that go beyond the spirit of this change.
- *Test-only DB-reset endpoint guarded by profile*: fast, but adds a backdoor in the production-shaped backend, which is exactly the kind of shortcut the "no shortcuts" stance rejects.
- *Unique-email only, against the dev docker-compose Postgres*: state accumulates across runs and the harness would not own its own dependency lifecycle. Rejected.

### Decision 3: Workspace shape — standalone `e2e/`, NOT a pnpm workspace with `frontend/`

`e2e/` is its own Node project: own `package.json`, own `pnpm-lock.yaml`, own `node_modules`, own pnpm version pinned via `packageManager`. Typed API helpers come from a *second* Orval codegen running inside `e2e/` against the same `openapi/openapi.json`. The OpenAPI document is the single contract; both `frontend/` and `e2e/` regenerate independently. CI's existing OpenAPI drift check guarantees the contract stays in sync with the backend.

**Rationale:** Real-world production e2e suites (Grafana, Mattermost, Sentry, Element, Playwright's own templates) overwhelmingly use a standalone shape. Coupling `e2e/` into a workspace with `frontend/` would (a) make it harder to run e2e against deployed environments later, (b) invalidate e2e's CI cache on unrelated frontend lockfile churn, (c) force TypeScript/Node/Vite version alignment that e2e should be free to evolve independently, and (d) weaken the "tests own their world" property.

The "shared types" benefit of a workspace is *not* a coupling argument — both consumers can derive types from the same source (the OpenAPI document) without sharing a workspace.

**Alternatives considered:**

- *pnpm workspace with `frontend/`*: gives shared types via direct import, but pays all the coupling costs above for a benefit that's already achievable via a second Orval codegen.
- *No typed API client in e2e at all (raw `fetch` + hand-typed responses)*: would force test authors to keep types in sync manually, defeating the contract-driven discipline the rest of the codebase already enforces.

### Decision 4: CI shape — sequential build → e2e (Option A)

The existing `backend` and `frontend` jobs continue to run in parallel with each other. A new `e2e` job is added with `needs: [backend, frontend]`. The backend job uploads the built JAR via `actions/upload-artifact`; the frontend job uploads `frontend/dist/`. The e2e job downloads both and runs Playwright against them. Browser matrix (chromium, firefox, webkit) is a `strategy.matrix` on the e2e job.

**Rationale:** This mirrors how a real release pipeline works: build once, then test the artifact you'll ship. It removes the "did the e2e job test the same JAR the backend job did?" ambiguity and avoids redundant compilation work. It also gives the e2e job a clean, fast, deterministic shape — its input is "a JAR and a `dist/`", not "a checkout that might not match what the build jobs produced."

**Alternatives considered:**

- *Option B: e2e builds backend + frontend internally, runs in parallel with the build jobs*: faster on green PRs, but pays redundant build cost and complicates artifact provenance. Rejected.
- *Path-filtered runs (skip e2e on docs-only PRs)*: rejected per the user's no-shortcuts stance.
- *Advisory (non-required) e2e check while suite is young*: rejected per the same stance.

### Decision 5: Test conventions — semantic locators, no `waitForTimeout`, helpers over POMs

Tests use `getByRole`, `getByLabel`, `getByText` for locators. `data-testid` is allowed only as a last resort and never as the primary strategy. There is no use of `page.waitForTimeout`; tests rely on Playwright's auto-waiting locators and explicit `expect(...).toBeVisible()` / `expect(...).toHaveURL(...)` style waits.

A11y discipline: every visited page is scanned with axe-playwright before assertions complete. Violations fail the test. This is enforced via a Playwright fixture or a `test.beforeEach` helper, not via per-test boilerplate.

Test structure: simple helper functions (e.g., `signupAs(page, { email, password, displayName })`) live in `e2e/src/helpers/`. No page-object class hierarchy. With one feature under test, a class taxonomy is premature abstraction.

**Rationale:** Locator semantics, wait discipline, and a11y baselines are easy to add now and painful to retrofit later. POM hierarchies are easy to add later when there are 10+ flows; adding them now would lock in a structure with no real evidence of what it should look like.

### Decision 6: Test scope on day one — smoke + signup, nothing more

Day-one tests cover only the user flows that actually exist:

- Smoke: `GET /` returns 200 and the SPA root mounts; `GET /actuator/health` returns 200.
- Signup happy path: fill the form with valid input, submit, assert the success state renders, then verify the user exists by calling `POST /api/v1/auth/signup` again with the same email and asserting a 409 (i.e., the user really was persisted — no DB queries from the test).
- Signup duplicate email: pre-create a user via the typed API client, then drive the form with the same email, assert the form renders the ProblemDetail's `detail`.
- Signup validation: drive the form with each invalid case (short password, malformed email, oversized displayName), assert the inline error appears and no network request fires.

**Rationale:** A production-grade e2e suite that tests no real flow is theater. Signup is the only flow implemented end-to-end, so it is the only flow worth testing. Future flows (login, posts, feed) get e2e coverage as those features land.

## Risks / Trade-offs

- **CI wall-clock time grows.** A cold Spring Boot startup plus three browsers plus axe scans adds minutes to every PR pipeline. → Mitigation: chromium/firefox/webkit run in parallel matrix legs; backend JAR and frontend dist are reused from upstream jobs (no rebuild); Playwright reuses the same backend/frontend instance across all tests in one matrix leg via `globalSetup`.
- **`vite preview` is not a production server.** Using it for tests embeds a small fiction (the SPA is served by something different in CI than it will be in prod). → Mitigation: the fiction is bounded — only static-asset serving differs, and the API surface (which is what the tests actually verify) goes through the same proxy semantics that real production will use. When `infra/` lands and picks a topology, the e2e harness updates to match, and the test suite itself does not need to change.
- **Testcontainers requires Docker in CI.** GitHub-hosted runners ship with Docker, so this works out of the box, but a future move to runners without Docker (or to corporate runners with Docker policy restrictions) would break the harness. → Mitigation: documented as a hard requirement in `e2e/README.md`. If the constraint changes, the harness migrates to a service container (`services:` in the workflow) rather than Testcontainers — same connection-string flow.
- **Per-run fresh DB but shared-within-run.** A long-running suite that adds many features will eventually have tests that assume "no users exist" preconditions and break under shared state. → Mitigation: not a problem for day-one scope; revisit when the suite has its first such test (likely an admin-listing or feed-empty-state scenario) by introducing per-test schema or per-test DB cleanup at *that* time, not pre-emptively.
- **Two Orval codegens to keep aligned.** `frontend/` and `e2e/` both run Orval against `openapi/openapi.json`, in slightly different configurations (frontend → React Query hooks; e2e → fetch-based client for API helpers). → Mitigation: the `openapi.json` itself is the single source of truth; CI's existing drift check guarantees it matches the backend. Each consumer's Orval config is small and self-contained, and both run as `postinstall` scripts so no manual sync step exists.
- **No login means signup tests cannot verify "user can actually log in afterward".** → Mitigation: accepted. Signup-only is the honest scope today. The follow-on change that introduces login extends e2e to assert signup-then-login.

## Migration Plan

This is a greenfield addition — no migration needed. The change lands in a single PR:

1. Create `e2e/` with all scaffolding files.
2. Add `preview.proxy` to `frontend/vite.config.ts`.
3. Extend `.github/workflows/ci.yml` with the e2e job and required-check expectation.
4. CI runs the new job for the first time on the PR itself, exercising the harness against the very change that introduces it.

Rollback: revert the PR. No backend or frontend runtime changes; nothing to un-deploy.

## Open Questions

None at this time. Outstanding decisions deferred deliberately to future changes:

- Production deployment topology (decided in a future `infra/` change).
- Per-test DB isolation strategy (decided when the first test that needs it lands).
- Login / session-based test fixtures (decided when login lands).
