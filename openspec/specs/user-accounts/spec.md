# user-accounts Specification

## Purpose
TBD - created by archiving change add-api-contract-codegen. Update Purpose after archive.
## Requirements
### Requirement: A `users` table is created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V1__create_users.sql` that creates a `users` table with columns sufficient to represent a registered account: a primary key, a unique email, a hashed password, a display name, and a creation timestamp.

#### Scenario: Migration creates the table

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** a `users` table exists
- **AND** has a primary key column `id` of type `UUID` (or equivalent)
- **AND** has a `email` column of type `TEXT` (or `VARCHAR(...)`) marked `NOT NULL` with a `UNIQUE` constraint
- **AND** has a `password_hash` column of type `TEXT` (or `VARCHAR(...)`) marked `NOT NULL`
- **AND** has a `display_name` column marked `NOT NULL`
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` with a default of `now()`.

#### Scenario: Email uniqueness is enforced at the database level

- **WHEN** an `INSERT` attempts to add a row whose email already exists
- **THEN** the database raises a unique-constraint violation.

### Requirement: Signup endpoint creates a new user account

The backend SHALL expose `POST /api/v1/auth/signup` accepting a JSON body of `email`, `password`, and `displayName`. On success, the endpoint SHALL persist a new `users` row with the password hashed and SHALL return `201 Created` with a JSON body containing the new account's `id`, `email`, `displayName`, and `createdAt`.

#### Scenario: Successful signup persists the user and returns the account

- **WHEN** a client posts a valid signup request to `POST /api/v1/auth/signup`
- **THEN** the response status is 201
- **AND** the response body contains exactly the fields `id`, `email`, `displayName`, `createdAt`
- **AND** the response body does NOT contain `password`, `password_hash`, or any field derived from the password
- **AND** a new row exists in `users` whose email matches the request and whose `password_hash` is not the plaintext password.

#### Scenario: Signup is publicly reachable

- **WHEN** a client posts to `POST /api/v1/auth/signup` without any credentials
- **THEN** the request is accepted and processed (no authentication is required for signup).

### Requirement: Signup validates input fields

The signup endpoint SHALL validate request bodies using `jakarta.validation` annotations on the request DTO and SHALL reject invalid bodies with a 400 `ProblemDetail` whose extensions enumerate the failing fields.

#### Scenario: Missing or malformed email is rejected

- **WHEN** a client posts a signup request whose `email` is missing, empty, or not a valid email format
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `email` among the failing fields.

#### Scenario: Password shorter than 8 characters is rejected

- **WHEN** a client posts a signup request whose `password` is fewer than 8 characters (or missing/empty)
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `password` among the failing fields.

#### Scenario: Display name longer than 80 characters or empty is rejected

- **WHEN** a client posts a signup request whose `displayName` is empty or longer than 80 characters
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `displayName` among the failing fields.

### Requirement: Signup rejects duplicate emails with a typed conflict response

The signup endpoint SHALL reject requests whose email is already registered with a 409 `ProblemDetail`.

#### Scenario: Duplicate email returns 409

- **WHEN** a client posts a signup request whose `email` already exists in `users`
- **THEN** the response status is 409
- **AND** the response body is a `ProblemDetail` with `status` 409 and a `detail` describing the conflict
- **AND** no new row is inserted into `users`.

### Requirement: Passwords are hashed with bcrypt and never persisted or returned in plaintext

The backend SHALL hash signup passwords using `BCryptPasswordEncoder` from `spring-security-crypto` before persisting, SHALL store only the hash in the `password_hash` column, and SHALL never include the password or its hash in any HTTP response or log line.

#### Scenario: Password is hashed before insert

- **WHEN** the signup endpoint persists a new user
- **THEN** the value written to `password_hash` is a bcrypt hash (begins with `$2a$`, `$2b$`, or `$2y$`)
- **AND** the value is not equal to the plaintext password.

#### Scenario: Password and hash are absent from responses

- **WHEN** a reader inspects the signup endpoint's response schema in `openapi/openapi.json`
- **THEN** the schema does not contain a `password` or `passwordHash` (or `password_hash`) property.

#### Scenario: Password is not logged

- **WHEN** the signup flow runs at any log level
- **THEN** no log line includes the plaintext password or its hash.

### Requirement: Frontend ships a signup form using the generated hook and Zod schema

The `frontend/` project SHALL include a signup feature module under `frontend/src/features/signup/` that renders a form, validates input client-side using the Orval-generated Zod schema for the signup request, and submits via the Orval-generated TanStack Query mutation.

#### Scenario: Form fields are validated client-side using the generated Zod schema

- **WHEN** a user types invalid input (e.g., a malformed email, a short password) and tabs out of the field
- **THEN** the form displays an inline error sourced from the generated Zod schema
- **AND** the submit button does not fire a network request while the form is invalid.

#### Scenario: Successful submission calls the generated mutation hook

- **WHEN** a user fills in valid email, password, and display name
- **AND** clicks Submit
- **THEN** the form invokes the Orval-generated signup mutation hook
- **AND** displays a success state when the mutation resolves with a 201.

#### Scenario: Server-side errors surface via the typed ApiError

- **WHEN** the signup mutation rejects with an `ApiError` (e.g., 409 duplicate email)
- **THEN** the form renders the `ProblemDetail`'s `detail` field as the error message
- **AND** does not crash the React tree.

### Requirement: Vitest test exercises the signup form via generated MSW handlers

The `frontend/` project SHALL include a vitest test for the signup form that overrides the generated MSW handler for `POST /api/v1/auth/signup` to simulate both a successful response and a 409 conflict, asserting the form renders each outcome correctly.

#### Scenario: Successful signup path

- **WHEN** the test mounts the signup form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 201 and a user payload
- **THEN** the test asserts the success state is rendered.

#### Scenario: Duplicate-email path

- **WHEN** the test mounts the signup form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 409 and a `ProblemDetail` body
- **THEN** the test asserts the error message from the `ProblemDetail`'s `detail` is rendered.

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

The backend SHALL set the `refresh_token` cookie with the following attributes on every issuing response (login and refresh): `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth/refresh`, and `Max-Age` equal to the configured refresh-token TTL in seconds. The `Secure` attribute SHALL be read from `app.auth.refresh-cookie-secure` (defaulting to `true`), allowing it to be turned off in HTTP-only test environments where browsers (notably WebKit) refuse to send `Secure` cookies over `http://127.0.0.1`. Production deployments SHALL leave the default `true` so the cookie is only sent over HTTPS.

#### Scenario: Cookie attributes are present in production defaults

- **WHEN** a reader inspects any `Set-Cookie: refresh_token=…` header issued by login or refresh against a backend started with default properties
- **THEN** the header includes `HttpOnly`
- **AND** includes `Secure`
- **AND** includes `SameSite=Lax`
- **AND** includes `Path=/api/v1/auth/refresh`
- **AND** includes `Max-Age=<seconds matching app.auth.refresh-token-ttl>`.

#### Scenario: Secure attribute can be disabled for HTTP test harnesses

- **WHEN** the backend is started with `app.auth.refresh-cookie-secure=false`
- **THEN** the `Set-Cookie: refresh_token=…` header omits the `Secure` attribute
- **AND** all other attributes (`HttpOnly`, `SameSite=Lax`, `Path`, `Max-Age`) are unchanged.

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

### Requirement: CSRF protection is disabled across the API

The backend SHALL disable Spring Security's CSRF protection for all endpoints. Cross-site forgery of `POST /api/v1/auth/refresh` is prevented by the refresh cookie's `SameSite=Lax` + `HttpOnly` + `Secure` attributes (a cross-site context cannot carry the cookie); all other state-changing endpoints authenticate via a `Authorization: Bearer <token>` header backed by a JS-memory access token, which a cross-site context cannot read or attach. A CSRF token round-trip therefore adds no protection over the existing design.

#### Scenario: Refresh succeeds without a CSRF token

- **WHEN** a client posts to `POST /api/v1/auth/refresh` with a valid `refresh_token` cookie and no `X-XSRF-TOKEN` header
- **THEN** the request reaches the controller (no CSRF rejection)
- **AND** the response status is 200 on the happy path.

#### Scenario: Bearer-authenticated endpoints accept requests without CSRF tokens

- **WHEN** a client calls a Bearer-authenticated endpoint with a valid `Authorization` header and no `X-XSRF-TOKEN` header
- **THEN** the request is processed normally (no CSRF rejection).

#### Scenario: CSRF is disabled in the security configuration

- **WHEN** a reader inspects `SecurityConfig.java`
- **THEN** the `HttpSecurity` builder calls `csrf(AbstractHttpConfigurer::disable)`.

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

### Requirement: Forward-compat with a reverse proxy

The backend SHALL set `server.forward-headers-strategy=framework` in `application.yml` so that Spring trusts `X-Forwarded-*` headers (host, proto, port) from a future reverse proxy. The auth design SHALL NOT depend on JVM-local state (e.g. `HttpSession`); all session state lives in Postgres.

#### Scenario: Forward-headers strategy is configured

- **WHEN** a reader inspects `backend/src/main/resources/application.yml`
- **THEN** `server.forward-headers-strategy` is set to `framework`.

#### Scenario: No HttpSession state is used

- **WHEN** a reader greps the auth code for `HttpSession`, `@SessionAttribute`, or session-scoped beans
- **THEN** there are no such references.

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

