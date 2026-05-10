## ADDED Requirements

### Requirement: Token tables are created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V2__create_auth_tokens.sql` that creates two tables to persist authentication tokens, both keyed by a unique hash of the opaque token string.

#### Scenario: Access-token table is created

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** an `auth_access_tokens` table exists
- **AND** has a primary key column `id` of type `UUID`
- **AND** has a `user_id` column of type `UUID NOT NULL` referencing `users(id)`
- **AND** has a `token_hash` column of type `TEXT NOT NULL` with a `UNIQUE` constraint and an index
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` with a default of `now()`
- **AND** has an `expires_at` column of type `TIMESTAMPTZ NOT NULL`
- **AND** has a `revoked_at` column of type `TIMESTAMPTZ NULL`.

#### Scenario: Refresh-token table is created

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** an `auth_refresh_tokens` table exists
- **AND** has the same column set as `auth_access_tokens`
- **AND** additionally has a `replaced_by` column of type `UUID NULL` that references `auth_refresh_tokens(id)`.

#### Scenario: Token-hash columns are indexed for lookup

- **WHEN** a reader inspects the migration
- **THEN** both `auth_access_tokens.token_hash` and `auth_refresh_tokens.token_hash` have a unique index suitable for O(1) lookup on the request path.

### Requirement: Tokens are persisted as hashes, never as plaintext

The backend SHALL store SHA-256 hashes of access and refresh tokens in `auth_access_tokens.token_hash` and `auth_refresh_tokens.token_hash`. The plaintext token SHALL only exist in memory long enough to return it to the caller (and, for the refresh token, to set the `Set-Cookie` header).

#### Scenario: Access-token hash is stored, not the plaintext

- **WHEN** the login endpoint mints an access token and persists the row
- **THEN** the value written to `auth_access_tokens.token_hash` is the SHA-256 hash of the plaintext token, hex- or base64-encoded
- **AND** is not equal to the plaintext token returned in the response body.

#### Scenario: Refresh-token hash is stored, not the plaintext

- **WHEN** the login or refresh endpoint mints a refresh token and persists the row
- **THEN** the value written to `auth_refresh_tokens.token_hash` is the SHA-256 hash of the plaintext token
- **AND** is not equal to the plaintext token set in the `Set-Cookie` header.

#### Scenario: Plaintext tokens are not logged

- **WHEN** the login, refresh, or logout flow runs at any log level
- **THEN** no log line includes the plaintext access token or the plaintext refresh token.

### Requirement: Token TTLs are configurable

The backend SHALL read access-token and refresh-token lifetimes from `application.yml` keys `app.auth.access-token-ttl` and `app.auth.refresh-token-ttl`, parsed as ISO-8601 durations, with defaults of `PT15M` and `P30D` respectively.

#### Scenario: Defaults are PT15M and P30D

- **WHEN** the backend starts with no overrides for the auth-TTL keys
- **THEN** newly minted access tokens have `expires_at = created_at + 15 minutes`
- **AND** newly minted refresh tokens have `expires_at = created_at + 30 days`.

#### Scenario: Overrides are honored

- **WHEN** `application.yml` (or an environment override) sets `app.auth.access-token-ttl=PT1H`
- **THEN** newly minted access tokens have `expires_at = created_at + 1 hour`.

### Requirement: Login endpoint mints an access token and a refresh token

The backend SHALL expose `POST /api/v1/auth/login` accepting a JSON body of `email` and `password`. On success, the endpoint SHALL verify the password against the stored bcrypt hash, mint an access token and a refresh token, persist their hashed rows, and return `200 OK` with a JSON body containing `accessToken` and `expiresIn` (seconds), and SHALL set the refresh token as a cookie via `Set-Cookie`.

#### Scenario: Successful login returns an access token and sets a refresh cookie

- **WHEN** a client posts a valid `{email, password}` to `POST /api/v1/auth/login` for an existing user whose password matches
- **THEN** the response status is 200
- **AND** the response body contains exactly the fields `accessToken` (string) and `expiresIn` (integer seconds)
- **AND** the response includes a `Set-Cookie: refresh_token=…; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/refresh; Max-Age=…` header
- **AND** a new row exists in `auth_access_tokens` whose `token_hash` matches the SHA-256 of the returned `accessToken`
- **AND** a new row exists in `auth_refresh_tokens` whose `token_hash` matches the SHA-256 of the cookie value.

#### Scenario: Login is publicly reachable

- **WHEN** a client posts to `POST /api/v1/auth/login` without any prior credentials
- **THEN** the request is accepted and processed (no authentication is required to log in).

### Requirement: Login does not reveal whether an email is registered

The login endpoint SHALL respond with the same `401 ProblemDetail` for "no such user" and "wrong password," so that an unauthenticated caller cannot enumerate registered emails by probing.

#### Scenario: Wrong password returns 401

- **WHEN** a client posts a login request whose email exists in `users` but whose password does not match the stored hash
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` whose `detail` describes invalid credentials in generic terms (does not mention the password specifically).

#### Scenario: Unknown email returns the same 401

- **WHEN** a client posts a login request whose email does not exist in `users`
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` whose `detail` is identical to the wrong-password case.

#### Scenario: Malformed login body is rejected with 400

- **WHEN** a client posts a login request whose `email` or `password` is missing or empty
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing the failing field(s).

### Requirement: Refresh endpoint rotates the refresh token and returns a new access token

The backend SHALL expose `POST /api/v1/auth/refresh` that reads the `refresh_token` cookie, validates the corresponding `auth_refresh_tokens` row is present and `revoked_at IS NULL` and `expires_at > now()`, then SHALL atomically (a) set `revoked_at = now()` on the existing row, (b) insert a new `auth_refresh_tokens` row with `replaced_by` pointing at the new row's id from the old row, (c) mint a new access token, and SHALL return `200 OK` with `{accessToken, expiresIn}` and `Set-Cookie` for the new refresh token.

#### Scenario: Refresh happy path

- **WHEN** a client calls `POST /api/v1/auth/refresh` with a valid `refresh_token` cookie
- **THEN** the response status is 200
- **AND** the response body contains a new `accessToken`
- **AND** the response includes a `Set-Cookie: refresh_token=…` for a new refresh token
- **AND** the previous refresh-token row has `revoked_at` set
- **AND** the previous refresh-token row's `replaced_by` points at the new refresh-token row's id
- **AND** a new access-token row exists in `auth_access_tokens`.

#### Scenario: Refresh with a missing cookie returns 401

- **WHEN** a client calls `POST /api/v1/auth/refresh` without a `refresh_token` cookie
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

#### Scenario: Refresh with an expired cookie returns 401

- **WHEN** a client calls `POST /api/v1/auth/refresh` with a `refresh_token` cookie whose row has `expires_at <= now()`
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`
- **AND** no new tokens are minted.

#### Scenario: Refresh with a revoked cookie returns 401

- **WHEN** a client calls `POST /api/v1/auth/refresh` with a `refresh_token` cookie whose row has `revoked_at IS NOT NULL`
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`
- **AND** no new tokens are minted.

### Requirement: Logout revokes both the caller's access token and the refresh cookie's token

The backend SHALL expose `POST /api/v1/auth/logout`, which SHALL require authentication (i.e. a valid `Authorization: Bearer <token>` header). On success, the endpoint SHALL set `revoked_at = now()` on the `auth_access_tokens` row identified by the `Authorization` header AND on the `auth_refresh_tokens` row identified by the `refresh_token` cookie (if present), SHALL clear the refresh cookie via `Set-Cookie: refresh_token=; Max-Age=0; Path=/api/v1/auth/refresh`, and SHALL return `204 No Content`.

#### Scenario: Logout revokes both tokens

- **WHEN** an authenticated client posts to `POST /api/v1/auth/logout` with a valid Bearer access token and a `refresh_token` cookie
- **THEN** the response status is 204
- **AND** the access-token row has `revoked_at` set
- **AND** the refresh-token row has `revoked_at` set
- **AND** the response includes `Set-Cookie: refresh_token=; Max-Age=0; …` to clear the cookie.

#### Scenario: A subsequent request with the old access token is rejected

- **WHEN** the same client (after logout) calls a protected endpoint with the now-revoked access token
- **THEN** the response status is 401.

#### Scenario: A subsequent refresh with the old refresh cookie is rejected

- **WHEN** the same client (after logout) calls `POST /api/v1/auth/refresh` with the now-revoked refresh cookie
- **THEN** the response status is 401.

#### Scenario: Logout without a Bearer token returns 401

- **WHEN** a client posts to `POST /api/v1/auth/logout` without an `Authorization` header
- **THEN** the response status is 401.

### Requirement: Current-user endpoint returns the authenticated principal

The backend SHALL expose `GET /api/v1/auth/me`, which SHALL require authentication and SHALL return `200 OK` with a JSON body containing `id`, `email`, `displayName`, and `createdAt` for the authenticated user — the same shape as the signup response.

#### Scenario: /me with a valid access token returns the user

- **WHEN** a client calls `GET /api/v1/auth/me` with a valid `Authorization: Bearer <token>` header
- **THEN** the response status is 200
- **AND** the response body contains exactly the fields `id`, `email`, `displayName`, `createdAt`.

#### Scenario: /me without a token returns 401

- **WHEN** a client calls `GET /api/v1/auth/me` with no `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

#### Scenario: /me with an expired token returns 401

- **WHEN** a client calls `GET /api/v1/auth/me` with an `Authorization: Bearer <token>` whose row has `expires_at <= now()`
- **THEN** the response status is 401.

#### Scenario: /me with a revoked token returns 401

- **WHEN** a client calls `GET /api/v1/auth/me` with an `Authorization: Bearer <token>` whose row has `revoked_at IS NOT NULL`
- **THEN** the response status is 401.

### Requirement: Refresh cookie has hardened attributes

The backend SHALL set the `refresh_token` cookie with the following attributes on every issuing response (login and refresh): `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/auth/refresh`, and `Max-Age` equal to the configured refresh-token TTL in seconds.

#### Scenario: Cookie attributes are present

- **WHEN** a reader inspects any `Set-Cookie: refresh_token=…` header issued by login or refresh
- **THEN** the header includes `HttpOnly`
- **AND** includes `Secure`
- **AND** includes `SameSite=Lax`
- **AND** includes `Path=/api/v1/auth/refresh`
- **AND** includes `Max-Age=<seconds matching app.auth.refresh-token-ttl>`.

### Requirement: Security filter chain is deny-by-default with an explicit allowlist

The backend SHALL configure a `SecurityFilterChain` that requires authentication for every request except an explicit allowlist consisting of `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `GET /actuator/health`, `GET /v3/api-docs/**`, `GET /swagger-ui/**`, and `GET /favicon.ico`. Any other endpoint SHALL return `401 ProblemDetail` when no authenticated principal is present.

#### Scenario: An unprotected endpoint reaches the controller

- **WHEN** a client calls `POST /api/v1/auth/signup` with no `Authorization` header
- **THEN** the request reaches the signup controller (returns the signup outcome, not 401).

#### Scenario: An unallowlisted endpoint requires authentication

- **WHEN** a client calls any endpoint that is not in the allowlist with no `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

#### Scenario: Allowlist is explicit, not derived

- **WHEN** a reader inspects the security configuration class
- **THEN** the allowlist is enumerated as a literal list (not derived from annotations) so it can be reviewed in one place.

### Requirement: Bearer-token authentication filter populates SecurityContext

The backend SHALL include a custom `BearerTokenAuthenticationFilter` that runs before the authorization filter and SHALL: (a) read the `Authorization` header, (b) require the prefix `Bearer ` (case-sensitive), (c) hash the token with SHA-256, (d) look up the row in `auth_access_tokens`, (e) require `revoked_at IS NULL` and `expires_at > now()`, and on success populate `SecurityContext` with a `UserPrincipal` carrying the user's id, email, and displayName. On any failure to satisfy these conditions, the filter SHALL leave `SecurityContext` empty (it does not itself produce a response).

#### Scenario: Valid token populates the SecurityContext

- **WHEN** a request arrives with a valid `Authorization: Bearer <token>` header
- **THEN** the downstream controller observes `SecurityContext.getAuthentication().getPrincipal()` as a `UserPrincipal` for the matching user.

#### Scenario: Missing Authorization header leaves SecurityContext empty

- **WHEN** a request arrives without an `Authorization` header
- **THEN** the filter does not throw
- **AND** `SecurityContext.getAuthentication()` is null when the controller is reached
- **AND** the deny-by-default authorization step produces a 401 ProblemDetail.

#### Scenario: Non-Bearer Authorization header leaves SecurityContext empty

- **WHEN** a request arrives with `Authorization: Basic …`
- **THEN** the filter does not populate `SecurityContext`
- **AND** the request is treated as unauthenticated.

### Requirement: CSRF protection is enabled for the refresh endpoint and disabled for Bearer-authenticated endpoints

The backend SHALL enable Spring Security's CSRF protection for `POST /api/v1/auth/refresh` (which is cookie-authenticated) and SHALL disable it for all other endpoints (which authenticate via the `Authorization` header and are CSRF-immune by construction).

#### Scenario: Refresh requires CSRF token

- **WHEN** a client calls `POST /api/v1/auth/refresh` from a different origin without a valid CSRF token
- **THEN** Spring's CSRF protection rejects the request before it reaches the controller.

#### Scenario: Bearer-authenticated endpoints do not require CSRF tokens

- **WHEN** a client calls a Bearer-authenticated endpoint with a valid `Authorization` header and no CSRF token
- **THEN** the request is processed normally (no CSRF rejection).

### Requirement: Authentication failures use ProblemDetail

All authentication-related error responses (401 from the security chain, 401 from invalid login, 401 from invalid refresh) SHALL return `application/problem+json` with a `ProblemDetail` body, consistent with the existing `GlobalExceptionHandler` behavior for other errors.

#### Scenario: 401 has a ProblemDetail body

- **WHEN** any authentication failure is produced
- **THEN** the response `Content-Type` is `application/problem+json`
- **AND** the body is a `ProblemDetail` with `status=401` and a non-empty `detail`.

### Requirement: Backend integration tests cover the full token lifecycle

The `backend/` project SHALL include Testcontainers integration tests (matching the existing `SignupIT` pattern) that exercise: login success, login wrong password, login unknown email, refresh happy path including rotation, refresh after revocation, logout revokes both tokens, /me with a valid token, /me with no token, /me with an expired token, /me with a revoked token, and a deny-by-default protected endpoint returning 401 when no token is present.

#### Scenario: Test class exists and is wired to Testcontainers

- **WHEN** a reader inspects `backend/src/test/java/com/prodready/social/useraccounts/`
- **THEN** there is at least one `*IT.java` class that uses Testcontainers Postgres
- **AND** asserts each of the lifecycle cases listed above.

### Requirement: Frontend ships a login form using the generated hook and Zod schema

The `frontend/` project SHALL include a login feature module under `frontend/src/features/login/` that renders a form with email and password fields, validates input client-side using the Orval-generated Zod schema for the login request, and submits via the Orval-generated TanStack Query mutation. On success it SHALL store the access token and the current user in the auth context and redirect to `/home`. On a 401 it SHALL render the `ProblemDetail`'s `detail` as the error message.

#### Scenario: Successful submission stores the token and redirects

- **WHEN** a user fills in valid email and password and clicks Submit
- **AND** the mutation resolves with 200 and an access token
- **THEN** the form invokes the Orval-generated login mutation hook
- **AND** the auth context exposes the new access token and the current user
- **AND** the SPA navigates to `/home`.

#### Scenario: 401 renders the ProblemDetail detail

- **WHEN** the login mutation rejects with a 401 `ApiError` carrying a `ProblemDetail`
- **THEN** the form renders the `ProblemDetail`'s `detail` field as the error message
- **AND** the auth context is unchanged.

#### Scenario: Form fields are validated client-side using the generated Zod schema

- **WHEN** a user types an empty email or empty password and tabs out of the field
- **THEN** the form displays an inline error sourced from the generated Zod schema
- **AND** the submit button does not fire a network request while the form is invalid.

### Requirement: Frontend AuthContext holds the access token in memory only

The `frontend/` project SHALL include a React context at `frontend/src/features/auth/AuthContext.tsx` that holds `{accessToken, user}` in memory only — it SHALL NOT read from or write to `localStorage`, `sessionStorage`, or any cookie that JavaScript can read.

#### Scenario: Access token is not persisted to web storage

- **WHEN** a reader greps the source tree for `localStorage` or `sessionStorage` references that touch the access token
- **THEN** there are no such references in the auth context, the login flow, or the API client.

#### Scenario: Reload clears the in-memory access token

- **WHEN** the user reloads the page
- **THEN** the auth context's `accessToken` is initially absent
- **AND** the next protected API call triggers a refresh attempt (which succeeds if the refresh cookie is still valid).

### Requirement: Axios request interceptor attaches the access token

The Orval-generated client's Axios mutator SHALL include a request interceptor that, when the auth context holds an access token, attaches `Authorization: Bearer <token>` to outgoing requests.

#### Scenario: Authenticated request carries the header

- **WHEN** the auth context holds an access token
- **AND** any generated mutation or query is invoked
- **THEN** the outgoing request includes an `Authorization: Bearer <token>` header.

#### Scenario: Unauthenticated request does not carry the header

- **WHEN** the auth context holds no access token
- **AND** any generated mutation or query is invoked
- **THEN** the outgoing request does NOT include an `Authorization` header.

### Requirement: Axios response interceptor transparently refreshes on 401

The Orval-generated client's Axios mutator SHALL include a response interceptor that, on a 401 from any endpoint other than `/api/v1/auth/login` and `/api/v1/auth/refresh`, SHALL call `POST /api/v1/auth/refresh` exactly once (single-flight: concurrent failed requests share one refresh in-flight), update the auth context with the new access token, and retry the original request once. If `/refresh` itself returns 401, the interceptor SHALL clear the auth context and redirect to `/login`.

#### Scenario: Single 401 triggers a refresh and a retry

- **WHEN** an authenticated call returns 401
- **AND** the refresh call returns 200 with a new access token
- **THEN** the auth context is updated with the new access token
- **AND** the original call is retried with the new token
- **AND** the caller observes the retried call's outcome (not the 401).

#### Scenario: Concurrent 401s share one refresh

- **WHEN** two authenticated calls return 401 at roughly the same time
- **THEN** only one `POST /api/v1/auth/refresh` is fired
- **AND** both original calls are retried with the same new access token.

#### Scenario: Refresh failure clears auth context and redirects

- **WHEN** a 401-triggered refresh call itself returns 401
- **THEN** the auth context's `accessToken` and `user` are cleared
- **AND** the SPA navigates to `/login`.

#### Scenario: 401 from the login endpoint does NOT trigger a refresh

- **WHEN** a `POST /api/v1/auth/login` call returns 401 (bad credentials)
- **THEN** the interceptor does not call `/refresh`
- **AND** the 401 propagates to the login form for display.

### Requirement: Frontend ProtectedRoute redirects unauthenticated users

The `frontend/` project SHALL include a `ProtectedRoute` wrapper at `frontend/src/features/auth/ProtectedRoute.tsx` that renders its children only when the auth context holds a current user, and otherwise redirects to `/login`.

#### Scenario: Unauthenticated visit redirects to /login

- **WHEN** an unauthenticated user navigates to a route wrapped in `ProtectedRoute`
- **THEN** the SPA navigates to `/login`
- **AND** the protected children are not rendered.

#### Scenario: Authenticated visit renders the children

- **WHEN** the auth context holds a current user
- **AND** the user navigates to a route wrapped in `ProtectedRoute`
- **THEN** the children are rendered.

### Requirement: Frontend /home page proves the wire by calling /me

The `frontend/` project SHALL include a `HomePage` component at `frontend/src/features/home/HomePage.tsx` that is mounted at the protected route `/home` and SHALL call `GET /api/v1/auth/me` via the Orval-generated query hook and render `Hello, {displayName}` (or equivalent) once the call resolves. The page SHALL also render a Logout button.

#### Scenario: /home renders the current user's display name

- **WHEN** an authenticated user navigates to `/home`
- **THEN** the SPA calls `GET /api/v1/auth/me`
- **AND** renders the user's `displayName` once the call resolves.

#### Scenario: Logout button revokes server-side and clears local state

- **WHEN** the user clicks the Logout button on `/home`
- **THEN** the SPA calls `POST /api/v1/auth/logout`
- **AND** clears the auth context
- **AND** navigates to `/login`.

### Requirement: Routing redirects based on auth state

The `frontend/` project's router SHALL define routes `/login`, `/signup`, and `/home` (the latter wrapped in `ProtectedRoute`), and SHALL configure `/` to redirect to `/home` when the auth context holds a current user, otherwise to `/login`.

#### Scenario: Root redirects authenticated user to /home

- **WHEN** an authenticated user navigates to `/`
- **THEN** the SPA redirects to `/home`.

#### Scenario: Root redirects unauthenticated user to /login

- **WHEN** an unauthenticated user navigates to `/`
- **THEN** the SPA redirects to `/login`.

### Requirement: Vitest tests cover the login form and the refresh interceptor

The `frontend/` project SHALL include Vitest tests that override the generated MSW handlers to cover: a successful login (200, asserts auth context updated and redirect to `/home`), a failed login (401 ProblemDetail, asserts the detail is rendered), a transparent refresh (a protected call returns 401, the refresh handler returns 200, the original call is retried and resolves), and a refresh-failure flow (the refresh handler returns 401, asserts the auth context is cleared and the SPA navigates to `/login`).

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

### Requirement: Forward-compat with a reverse proxy

The backend SHALL set `server.forward-headers-strategy=framework` in `application.yml` so that Spring trusts `X-Forwarded-*` headers (host, proto, port) from a future reverse proxy. The auth design SHALL NOT depend on JVM-local state (e.g. `HttpSession`); all session state lives in Postgres.

#### Scenario: Forward-headers strategy is configured

- **WHEN** a reader inspects `backend/src/main/resources/application.yml`
- **THEN** `server.forward-headers-strategy` is set to `framework`.

#### Scenario: No HttpSession state is used

- **WHEN** a reader greps the auth code for `HttpSession`, `@SessionAttribute`, or session-scoped beans
- **THEN** there are no such references.
