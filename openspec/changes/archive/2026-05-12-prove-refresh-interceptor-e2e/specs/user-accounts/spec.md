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
- a signup-continue test that completes signup, finds a link/button named "Continue to log in" on the success card, clicks it, and asserts navigation to `/login`;
- a not-found test that visits an unknown URL (unauthenticated) and asserts a 404 indicator is visible;
- a not-found test that visits an unknown URL (authenticated) and asserts a 404 indicator is visible;
- a routing test that, while unauthenticated, navigates directly to `/home` and asserts the URL is now `/login` and the Log-in form is visible;
- a refresh-on-401 test that, with the e2e backend booted with a short `app.auth.access-token-ttl`, signs up + logs in via the SPA, waits past the access-token TTL, then triggers an authenticated SPA action and asserts (a) the SPA stays on `/home`, (b) the action's UI outcome is visible, and (c) the network sequence on the trigger includes one `401` on the protected endpoint followed by exactly one `200` on `POST /api/v1/auth/refresh` followed by a successful retry of the original request;
- a logout-revocation test that captures the SPA's access token from the `POST /api/v1/auth/login` response, drives the SPA logout via the UI, then replays the captured access token against a protected backend endpoint and asserts the response is `401`;
- a concurrent-401 single-flight test that, with the e2e backend booted with a short `app.auth.access-token-ttl`, seeds the user with at least two posts via the e2e `apiClient`, signs up + logs in via the SPA, waits past the access-token TTL, then dispatches both `PostCard` `Delete` buttons' click events within the same page-side JS tick (e.g. via `page.evaluate` calling `.click()` on each delete button synchronously) so that two independent authenticated `DELETE /api/v1/posts/{id}` requests are fired concurrently through the SPA's Axios mutator. To keep both 401s overlapping in time across browsers whose network roundtrips can otherwise unwind the first 401→refresh→retry cycle before the second click's request even fires, the test SHALL also throttle the `POST /api/v1/auth/refresh` response by a fixed delay (e.g. ~500–1000ms via `page.route`) so that both 401-triggered `refreshOnce()` calls observe a non-null in-flight refresh promise. The test SHALL assert that exactly one `POST /api/v1/auth/refresh` reaches the wire across the parallel 401s, that both `DELETE` requests are retried and succeed after the single refresh, that both posts disappear from the rendered list, and that the SPA remains on `/home`;
- a refresh-401 logout test that, with the e2e backend booted with a short `app.auth.access-token-ttl`, signs up + logs in via the SPA, then overwrites the browser's `refresh_token` cookie with a value the backend will reject (e.g. an opaque bogus value the backend cannot match to a stored row) without modifying the SPA's in-memory `AuthContext`, waits past the access-token TTL, then triggers an authenticated SPA action. The test SHALL assert the network sequence shows the action's `401` followed by exactly one `401` on `POST /api/v1/auth/refresh`, and SHALL assert the SPA navigates to `/login` (i.e. the interceptor's refresh-failure handler cleared `AuthContext` and redirected).

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

#### Scenario: Concurrent-401 single-flight refresh test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a Playwright test that seeds at least two posts for a fresh user via the e2e `apiClient`, signs up + logs in via the SPA against an e2e backend booted with a short `app.auth.access-token-ttl` (e.g. `PT2S`), and lands on `/home` with both `PostCard`s and their `Delete` buttons visible
- **AND** waits for a duration strictly greater than the configured TTL so the access token held by the SPA's `AuthContext` is lapsed on the server
- **AND** dispatches both `Delete` buttons' click events within the same page-side JS tick (e.g. via `page.evaluate` iterating `button[aria-label="Delete post"]` elements and calling `.click()` on each synchronously), so that two independent `useDeletePost` mutations each fire an authenticated `DELETE /api/v1/posts/{id}` through the SPA's Axios mutator at nearly the same time
- **AND** throttles the `POST /api/v1/auth/refresh` response by a fixed delay (e.g. ~500–1000ms via `page.route`) so that both 401-triggered `refreshOnce()` calls observe the same in-flight refresh promise on every supported browser, regardless of per-browser variation in click-actuation latency
- **AND** asserts the captured network sequence contains exactly one `200` response on `POST /api/v1/auth/refresh` across the parallel 401s, not one refresh per failing request
- **AND** asserts both `DELETE /api/v1/posts/{id}` requests are retried after the single refresh and observed to succeed
- **AND** asserts both posts disappear from the rendered list after the retries settle
- **AND** asserts the SPA URL is still `/home` after the parallel retries settle
- **AND** the test passes against the harness.

#### Scenario: Refresh-401 logout test exists and passes

- **WHEN** a reader inspects `e2e/tests/`
- **THEN** there is a Playwright test that signs up + logs in a user via the SPA against an e2e backend booted with a short `app.auth.access-token-ttl` (e.g. `PT2S`)
- **AND** overwrites the browser context's `refresh_token` cookie with a value the backend will reject (e.g. via `page.context().addCookies(...)` with an opaque bogus value, preserving the original cookie's `path`, `httpOnly`, `sameSite`, and `secure` attributes) without modifying the SPA's in-memory `AuthContext`
- **AND** waits for a duration strictly greater than the configured TTL so the access token is lapsed on the server
- **AND** triggers an authenticated SPA action (e.g. composing a post via the existing composer)
- **AND** asserts the captured network sequence shows the triggered action returning `401` followed by exactly one `POST /api/v1/auth/refresh` that returns `401`
- **AND** asserts the SPA URL is `/login` after the failed refresh settles
- **AND** asserts the Log-in form (e.g. the heading with accessible name "Log in") is visible on `/login`
- **AND** the test passes against the harness.
