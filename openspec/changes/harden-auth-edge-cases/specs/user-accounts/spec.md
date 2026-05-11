## ADDED Requirements

### Requirement: Frontend hydrates AuthContext from the refresh cookie on app mount

The `frontend/` project SHALL fire a single `POST /api/v1/auth/refresh` call on `AuthProvider` mount, before rendering any protected route. On a 200 response the SPA SHALL update the access token via the existing refresh-success handler, then call `GET /api/v1/auth/me` and store the returned principal in `AuthContext.currentUser`. On a 401 (or any non-2xx) response the SPA SHALL leave `AuthContext` in its unauthenticated state. During the in-flight window between mount and the resolution of the refresh + `/me` calls, `AuthContext` SHALL expose a `booting: true` flag; once both calls have settled the flag SHALL flip to `false`. The boot-time refresh SHALL share the existing single-flight `refreshOnce()` slot used by the response interceptor, so a concurrent boot-time refresh and a 401-triggered refresh never both fire.

#### Scenario: Successful boot-time refresh keeps the user signed in

- **WHEN** the SPA mounts in a browser where the HttpOnly `refresh_token` cookie is still valid
- **THEN** the SPA fires exactly one `POST /api/v1/auth/refresh`
- **AND** on 200 fires exactly one `GET /api/v1/auth/me`
- **AND** `AuthContext.currentUser` is set to the principal returned by `/me`
- **AND** `AuthContext.booting` flips from `true` to `false`
- **AND** `ProtectedRoute` renders the protected children (it does NOT redirect to `/login`).

#### Scenario: Boot-time refresh failure leaves the SPA unauthenticated

- **WHEN** the SPA mounts in a browser with no `refresh_token` cookie, or whose cookie corresponds to an expired or revoked refresh-token row
- **THEN** the SPA fires `POST /api/v1/auth/refresh` once
- **AND** the response is 401
- **AND** `AuthContext.currentUser` remains `null`
- **AND** `AuthContext.booting` flips from `true` to `false`
- **AND** `ProtectedRoute` redirects to `/login` if the user was attempting to visit a protected route.

#### Scenario: Boot-time refresh and 401-triggered refresh share one in-flight slot

- **WHEN** the SPA mounts at the same moment a protected query is already in flight and returns 401
- **THEN** at most one `POST /api/v1/auth/refresh` is sent
- **AND** both refresh callers observe the same resolved access token (or the same failure).

### Requirement: ProtectedRoute does not bounce while AuthContext is booting

The `frontend/src/features/auth/ProtectedRoute.tsx` SHALL read `AuthContext.booting` in addition to `currentUser`. While `booting` is `true` the component SHALL render a neutral placeholder (e.g., a "Loading…" message) and SHALL NOT navigate. Once `booting` is `false`, the component SHALL behave per the existing rule: render children when `currentUser` is non-null, otherwise redirect to `/login`.

#### Scenario: Mid-hydration render does not redirect

- **WHEN** the SPA mounts at `/home` and `AuthContext.booting` is `true`
- **THEN** `ProtectedRoute` renders the placeholder
- **AND** the location stays at `/home` (no navigation to `/login` is performed).

#### Scenario: Post-hydration unauthenticated render redirects

- **WHEN** `AuthContext.booting` transitions to `false` and `currentUser` is `null`
- **THEN** `ProtectedRoute` navigates to `/login`.

### Requirement: /login redirects already-authenticated users to /home

The `frontend/` project SHALL guard the `/login` route so that, when `AuthContext.currentUser` is non-null (and `AuthContext.booting` is `false`), the SPA SHALL render `<Navigate to="/home" replace />` instead of the login form.

#### Scenario: Authenticated user visiting /login is redirected

- **WHEN** an authenticated user navigates to `/login`
- **THEN** the SPA navigates to `/home`
- **AND** the login form is not rendered.

#### Scenario: Unauthenticated user visiting /login sees the form

- **WHEN** an unauthenticated user navigates to `/login`
- **THEN** the SPA renders the login form
- **AND** does not navigate away.

### Requirement: /signup redirects already-authenticated users to /home

The `frontend/` project SHALL guard the `/signup` route so that, when `AuthContext.currentUser` is non-null (and `AuthContext.booting` is `false`), the SPA SHALL render `<Navigate to="/home" replace />` instead of the signup form.

#### Scenario: Authenticated user visiting /signup is redirected

- **WHEN** an authenticated user navigates to `/signup`
- **THEN** the SPA navigates to `/home`
- **AND** the signup form is not rendered.

#### Scenario: Unauthenticated user visiting /signup sees the form

- **WHEN** an unauthenticated user navigates to `/signup`
- **THEN** the SPA renders the signup form
- **AND** does not navigate away.

### Requirement: Signup success state offers a visible path to /login

The `frontend/src/features/signup/SignupForm.tsx` success state ("Account created") SHALL render a visible navigation affordance to `/login`. The affordance SHALL be either a `<Link to="/login">` or a `<button>` whose accessible name is "Continue to log in" (case-insensitive). Clicking the affordance SHALL navigate the SPA to `/login`. The success state SHALL NOT auto-redirect; the user controls the transition.

#### Scenario: Success card shows a "Continue to log in" link

- **WHEN** a signup submission resolves with 201 and the success state renders
- **THEN** the rendered card contains a link or button with the accessible name "Continue to log in" (case-insensitive).

#### Scenario: Clicking the affordance navigates to /login

- **WHEN** the user clicks the "Continue to log in" affordance on the signup success card
- **THEN** the SPA navigates to `/login`.

### Requirement: Unknown URLs render an explicit NotFound page

The `frontend/src/App.tsx` router SHALL replace the catch-all `*` route with a route that renders a dedicated `NotFoundPage` component. The component SHALL render a visible "Not found" heading (text matching `/not found|404/i`) and SHALL render a link back to `/`. The page SHALL be reachable for both authenticated and unauthenticated users (i.e., it is not wrapped in `ProtectedRoute`).

#### Scenario: Unknown URL renders the 404 page for an unauthenticated user

- **WHEN** an unauthenticated user navigates to a URL that matches no defined route (e.g., `/this-does-not-exist`)
- **THEN** the SPA renders the `NotFoundPage`
- **AND** a heading or text element matching `/not found|404/i` is visible
- **AND** the SPA does NOT navigate to `/login`.

#### Scenario: Unknown URL renders the 404 page for an authenticated user

- **WHEN** an authenticated user navigates to a URL that matches no defined route
- **THEN** the SPA renders the `NotFoundPage`
- **AND** a heading or text element matching `/not found|404/i` is visible
- **AND** the SPA does NOT navigate to `/home`.

#### Scenario: NotFound page links back to root

- **WHEN** the `NotFoundPage` is rendered
- **THEN** the rendered output contains a link whose target is `/`.

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
- a not-found test that visits an unknown URL (authenticated) and asserts a 404 indicator is visible.

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

## MODIFIED Requirements

### Requirement: Frontend AuthContext holds the access token in memory only

The `frontend/` project SHALL include a React context at `frontend/src/features/auth/AuthContext.tsx` that holds `{accessToken, user}` in memory only — it SHALL NOT read from or write to `localStorage`, `sessionStorage`, or any cookie that JavaScript can read. On `AuthProvider` mount the context SHALL attempt boot-time hydration via a single `POST /api/v1/auth/refresh` followed (on success) by `GET /api/v1/auth/me`; until that flow settles, the context SHALL expose a `booting: true` flag.

#### Scenario: Access token is not persisted to web storage

- **WHEN** a reader greps the source tree for `localStorage` or `sessionStorage` references that touch the access token
- **THEN** there are no such references in the auth context, the login flow, or the API client.

#### Scenario: Reload triggers a boot-time refresh attempt

- **WHEN** the user reloads the page
- **THEN** the auth context's `accessToken` is initially absent and `booting` is `true`
- **AND** `AuthProvider` fires `POST /api/v1/auth/refresh` exactly once on mount
- **AND** on success the auth context is hydrated with the new access token and the principal from `GET /api/v1/auth/me`
- **AND** on failure the auth context remains unauthenticated
- **AND** in either case `booting` flips to `false` after the boot-time flow settles.

### Requirement: Frontend ProtectedRoute redirects unauthenticated users

The `frontend/` project SHALL include a `ProtectedRoute` wrapper at `frontend/src/features/auth/ProtectedRoute.tsx` that, after `AuthContext.booting` has settled to `false`, renders its children only when the auth context holds a current user, and otherwise redirects to `/login`. While `AuthContext.booting` is `true` the component SHALL render a neutral placeholder and SHALL NOT navigate.

#### Scenario: Unauthenticated visit redirects to /login

- **WHEN** an unauthenticated user navigates to a route wrapped in `ProtectedRoute`
- **AND** `AuthContext.booting` is `false`
- **THEN** the SPA navigates to `/login`
- **AND** the protected children are not rendered.

#### Scenario: Authenticated visit renders the children

- **WHEN** the auth context holds a current user
- **AND** `AuthContext.booting` is `false`
- **AND** the user navigates to a route wrapped in `ProtectedRoute`
- **THEN** the children are rendered.

#### Scenario: Booting state renders a placeholder, not a redirect

- **WHEN** the SPA mounts at a route wrapped in `ProtectedRoute`
- **AND** `AuthContext.booting` is `true`
- **THEN** the component renders a neutral placeholder
- **AND** the SPA does NOT navigate to `/login`
- **AND** the SPA does NOT render the protected children yet.

### Requirement: Routing redirects based on auth state

The `frontend/` project's router SHALL define routes `/login`, `/signup`, `/home` (the latter wrapped in `ProtectedRoute`), and a `NotFoundPage` route for any URL that matches no defined route. The router SHALL configure `/` to redirect to `/home` when the auth context holds a current user, otherwise to `/login`. The `/login` and `/signup` routes SHALL each be wrapped in a guard that, when `AuthContext.currentUser` is non-null and `AuthContext.booting` is `false`, redirects to `/home`.

#### Scenario: Root redirects authenticated user to /home

- **WHEN** an authenticated user navigates to `/`
- **THEN** the SPA redirects to `/home`.

#### Scenario: Root redirects unauthenticated user to /login

- **WHEN** an unauthenticated user navigates to `/`
- **THEN** the SPA redirects to `/login`.

#### Scenario: Authenticated user is redirected away from /login

- **WHEN** an authenticated user navigates to `/login`
- **THEN** the SPA navigates to `/home`.

#### Scenario: Authenticated user is redirected away from /signup

- **WHEN** an authenticated user navigates to `/signup`
- **THEN** the SPA navigates to `/home`.

#### Scenario: Unknown URL renders the NotFound page

- **WHEN** any user navigates to a URL that matches no defined route
- **THEN** the SPA renders the `NotFoundPage`
- **AND** does NOT redirect to `/home` or `/login`.

### Requirement: Vitest tests cover the login form and the refresh interceptor

The `frontend/` project SHALL include Vitest tests that override the generated MSW handlers to cover: a successful login (200, asserts auth context updated and redirect to `/home`), a failed login (401 ProblemDetail, asserts the detail is rendered), a transparent refresh (a protected call returns 401, the refresh handler returns 200, the original call is retried and resolves), a refresh-failure flow (the refresh handler returns 401, asserts the auth context is cleared and the SPA navigates to `/login`), a successful boot-time hydration (`/auth/refresh` returns 200 and `/auth/me` returns 200, asserts `AuthContext.currentUser` is populated and `booting` flips to `false`), and a failed boot-time hydration (`/auth/refresh` returns 401, asserts `AuthContext.currentUser` remains `null` and `booting` flips to `false`).

#### Scenario: Login success path

- **WHEN** the test mounts the login form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 200 and an access-token payload
- **THEN** the test asserts the auth context is updated and the SPA navigates to `/home`.

#### Scenario: Login 401 path

- **WHEN** the test mounts the login form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 401 and a `ProblemDetail` body
- **THEN** the test asserts the `ProblemDetail`'s `detail` is rendered.

#### Scenario: Refresh interceptor transparently retries

- **WHEN** the test fires an authenticated call
- **AND** the MSW handler for that call responds with 401 on the first invocation and 200 on retry
- **AND** the MSW handler for `/refresh` responds with 200 and a new access token
- **THEN** the test asserts the original call ultimately resolves with the 200 outcome
- **AND** the auth context's `accessToken` was updated to the new token.

#### Scenario: Refresh interceptor gives up and redirects on /refresh 401

- **WHEN** the test fires an authenticated call
- **AND** the MSW handler for that call responds with 401
- **AND** the MSW handler for `/refresh` also responds with 401
- **THEN** the test asserts the auth context is cleared
- **AND** the SPA navigates to `/login`.

#### Scenario: Boot-time hydration success path

- **WHEN** the test mounts `AuthProvider`
- **AND** the MSW handler for `POST /auth/refresh` responds with 200 and a fresh access token
- **AND** the MSW handler for `GET /auth/me` responds with 200 and a principal payload
- **THEN** the test asserts `AuthContext.currentUser` is populated with the principal
- **AND** `AuthContext.booting` is observed to flip from `true` to `false`.

#### Scenario: Boot-time hydration failure path

- **WHEN** the test mounts `AuthProvider`
- **AND** the MSW handler for `POST /auth/refresh` responds with 401
- **THEN** the test asserts `AuthContext.currentUser` remains `null`
- **AND** `AuthContext.booting` is observed to flip from `true` to `false`
- **AND** `GET /auth/me` is NOT called.
