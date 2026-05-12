## MODIFIED Requirements

### Requirement: E2E tests cover auth/session edge cases

The `e2e/` project SHALL include the following Playwright tests (one or more `*.spec.ts` files under `e2e/tests/`), each driving the UI end-to-end against the production-built frontend and the real backend (no MSW):

- a session test that signs up + logs in a user, reloads the page, and asserts the user is still on `/home`;
- a session test that signs up + logs in + logs out a user, reloads the page, and asserts the user remains on `/login` (no spurious re-hydration);
- an errors test that submits a valid email with the wrong password and asserts an inline `role="alert"` is visible;
- an errors test that submits a never-registered email and asserts the rendered error text is byte-for-byte identical to the wrong-password test's error text (no email enumeration);
- an errors test that submits an empty form and asserts no `POST /api/v1/auth/login` request is sent;
- a routing test that signs up + logs in a user, then navigates to `/login` and asserts the URL is now `/home`;
- a routing test that signs up + logs in a user, then navigates to `/signup` and asserts the URL is now `/home`;
- a routing test that, while unauthenticated, navigates directly to `/home` and asserts the URL is now `/login` and the Log-in form is visible;
- a signup-continue test that completes signup, finds a link/button named "Continue to log in" on the success card, clicks it, and asserts navigation to `/login`;
- a not-found test that visits an unknown URL (unauthenticated) and asserts a 404 indicator is visible;
- a not-found test that visits an unknown URL (authenticated) and asserts a 404 indicator is visible;
- a refresh-on-401 test that, with the e2e backend booted with a short `app.auth.access-token-ttl`, signs up + logs in via the SPA, waits past the access-token TTL, then triggers an authenticated SPA action and asserts (a) the SPA stays on `/home`, (b) the action's UI outcome is visible, and (c) the network sequence on the trigger includes one `401` on the protected endpoint followed by exactly one `200` on `POST /api/v1/auth/refresh` followed by a successful retry of the original request;
- a logout-revocation test that captures the SPA's access token from the `POST /api/v1/auth/login` response, drives the SPA logout via the UI, then replays the captured access token against a protected backend endpoint and asserts the response is `401`.

The exploratory probe file `e2e/tests/auth-edge-probes.spec.ts` SHALL be deleted.

#### Scenario: Session reload test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that logs in via the UI, reloads the page, and asserts the user remains on `/home`
- **AND** the test passes against the harness.

#### Scenario: Email-enumeration regression-guard test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that drives the login form with a wrong password for an existing account and captures the rendered error text
- **AND** the same test (or a sibling) drives the login form with an email that was never registered and asserts the rendered error text is byte-for-byte identical to the wrong-password case
- **AND** the test passes against the harness.

#### Scenario: /login and /signup redirect tests exist and pass

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that logs in via the UI, navigates to `/login`, and asserts the URL is `/home`
- **AND** there is a test that logs in via the UI, navigates to `/signup`, and asserts the URL is `/home`
- **AND** both tests pass against the harness.

#### Scenario: Signup-continue test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that completes signup via the UI, locates a link or button with the accessible name "Continue to log in" on the success card, clicks it, and asserts the URL is `/login`
- **AND** the test passes against the harness.

#### Scenario: Not-found tests exist and pass

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a test that visits a non-existent URL while unauthenticated and asserts a "not found" indicator is visible
- **AND** there is a test that visits a non-existent URL while authenticated and asserts a "not found" indicator is visible
- **AND** both tests pass against the harness.

#### Scenario: Probe file is deleted

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** the file `auth-edge-probes.spec.ts` does not exist.

#### Scenario: Unauth /home redirect test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a Playwright test that, starting from a fresh unauthenticated browser context, navigates directly to `/home` via `page.goto`
- **AND** asserts the URL is `/login` after the navigation settles
- **AND** asserts the Log-in form (e.g. the `heading` with accessible name "Log in", or the `button` with name "Log in") is visible
- **AND** the test passes against the harness.

#### Scenario: Refresh-on-401 test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a Playwright test that signs up + logs in a user via the SPA against an e2e backend booted with a short `app.auth.access-token-ttl` (e.g. `PT2S`)
- **AND** waits for a duration strictly greater than the configured TTL so the access token held by the SPA's `AuthContext` is lapsed on the server
- **AND** triggers an authenticated SPA action that hits a protected backend endpoint (e.g. composing a post via the existing composer)
- **AND** asserts the SPA URL is still `/home` after the action settles
- **AND** asserts the UI outcome of the action is visible (e.g. the new `PostCard` is rendered for a composed post)
- **AND** asserts the network sequence observed on the trigger contains exactly one `401` response on the protected endpoint followed by exactly one `200` response on `POST /api/v1/auth/refresh` followed by a successful retry of the originally-failing request
- **AND** the test passes against the harness.

#### Scenario: Logout-revocation test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a Playwright test that signs up a user and, while driving the SPA login form, captures the `accessToken` value returned by the `POST /api/v1/auth/login` response (via `page.on('response', ...)` or equivalent)
- **AND** asserts the captured token is a non-empty string
- **AND** drives the SPA logout via the UI button labeled "Log out" and confirms the SPA lands on `/login`
- **AND** replays the captured token through the e2e `apiClient` against a protected backend endpoint (e.g. `GET /api/v1/users/{userId}/posts` or `GET /api/v1/auth/me`) with an `Authorization: Bearer <captured-token>` header
- **AND** asserts the replay's response status is `401`
- **AND** the test passes against the harness.
