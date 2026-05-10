## 1. Backend — token storage

- [x] 1.1 Write Flyway migration `backend/src/main/resources/db/migration/V2__create_auth_tokens.sql` creating `auth_access_tokens` (id UUID PK, user_id UUID FK→users(id), token_hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ NULL) with an index on `token_hash`.
- [x] 1.2 Extend the same migration to create `auth_refresh_tokens` with the same columns plus `replaced_by UUID NULL REFERENCES auth_refresh_tokens(id)`, with an index on `token_hash`.
- [x] 1.3 Verify the migration runs cleanly against an empty Testcontainers Postgres (extend `ApplicationContextIT` or add a small migration smoke test).

## 2. Backend — token domain & services

- [x] 2.1 Add `AuthAccessToken` and `AuthRefreshToken` entity/record types and corresponding `AuthAccessTokenRepository` / `AuthRefreshTokenRepository` interfaces under `backend/src/main/java/com/prodready/social/useraccounts/`.
- [x] 2.2 Add `AuthTokenProperties` (`@ConfigurationProperties(prefix = "app.auth")`) reading `accessTokenTtl: Duration` (default `PT15M`) and `refreshTokenTtl: Duration` (default `P30D`); register defaults in `application.yml`.
- [x] 2.3 Implement `AuthTokenService` exposing `mintAccessToken(userId)`, `mintRefreshToken(userId)`, `findActiveAccessToken(plaintext)`, `findActiveRefreshToken(plaintext)`, `revokeAccessToken(plaintext)`, `revokeRefreshToken(plaintext)`, and `rotateRefreshToken(plaintext)` (atomic: revoke old, insert new with `replaced_by`).
- [x] 2.4 Tokens are 256-bit random values (`SecureRandom.nextBytes(32)`, base64url-encoded, no padding); persistence is the SHA-256 hash (hex- or base64-encoded). Confirm no log line ever emits the plaintext.

## 3. Backend — security filter chain

- [x] 3.1 Add `BearerTokenAuthenticationFilter` (extends `OncePerRequestFilter`) that reads `Authorization: Bearer <token>`, hashes it, calls `AuthTokenService.findActiveAccessToken`, and on success populates `SecurityContextHolder` with a `UsernamePasswordAuthenticationToken` whose principal is a `UserPrincipal` (id, email, displayName). On any failure, the filter continues without touching `SecurityContext`.
- [x] 3.2 Add `SecurityConfig` (`@Configuration`) declaring a `SecurityFilterChain` that:
  - is deny-by-default;
  - permits `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `GET /actuator/health`, `GET /v3/api-docs/**`, `GET /swagger-ui/**`, `GET /favicon.ico`;
  - enables CSRF only for `POST /api/v1/auth/refresh` and disables it elsewhere;
  - registers `BearerTokenAuthenticationFilter` before `AuthorizationFilter`;
  - uses an `AuthenticationEntryPoint` that returns `application/problem+json` 401 ProblemDetail responses (delegate to the existing `GlobalExceptionHandler` shape).
- [x] 3.3 Set `server.forward-headers-strategy=framework` in `application.yml`.

## 4. Backend — endpoints

- [x] 4.1 Add `LoginRequest` (jakarta-validated: `email` not blank + valid email, `password` not blank) and `LoginResponse` (`accessToken: String`, `expiresIn: long`) DTOs.
- [x] 4.2 Add `LoginService.login(email, password)` that loads the user, verifies the password with `BCryptPasswordEncoder.matches`, mints both tokens via `AuthTokenService`, and returns `(accessToken plaintext, refreshToken plaintext, expiresIn)`. On unknown email or wrong password, throw a single `BadCredentialsException` (mapped to 401 with the same generic detail).
- [x] 4.3 Add `POST /api/v1/auth/login` controller method on `AuthController`: validates body, calls `LoginService.login`, sets the refresh cookie via `ResponseCookie` (HttpOnly, Secure, SameSite=Lax, Path=/api/v1/auth/refresh, Max-Age=ttl-seconds) on the `HttpServletResponse`, returns 200 with the `LoginResponse` body.
- [x] 4.4 Add `POST /api/v1/auth/refresh` controller method: reads `refresh_token` cookie, calls `AuthTokenService.rotateRefreshToken` (returns new refresh plaintext + new access plaintext), sets the new refresh cookie, returns 200 with `LoginResponse`. Missing/invalid/expired/revoked cookie → throw a typed exception mapped to 401 ProblemDetail; no tokens minted on failure.
- [x] 4.5 Add `POST /api/v1/auth/logout` controller method (protected): pulls the access-token plaintext from the `Authorization` header and the refresh-token plaintext from the cookie, calls `revokeAccessToken` and (if cookie present) `revokeRefreshToken`, sets a clearing cookie (`Max-Age=0`), returns 204.
- [x] 4.6 Add `GET /api/v1/auth/me` controller method (protected): reads the `UserPrincipal` from `SecurityContext`, loads the full user record, returns 200 with the existing `UserResponse` shape.
- [x] 4.7 Extend `GlobalExceptionHandler` to map `BadCredentialsException`, `InvalidRefreshTokenException` (new), and the security-chain `AuthenticationException`/`AccessDeniedException` to `application/problem+json` 401/403 ProblemDetail bodies. Ensure 401 detail strings are identical for "no such user" and "wrong password."

## 5. Backend — integration tests

- [x] 5.1 Add `LoginIT` (Testcontainers, mirrors `SignupIT`): asserts login success returns 200 + access token + sets the refresh cookie with all required attributes; asserts wrong password returns 401 with a generic detail; asserts unknown email returns 401 with the *same* detail string as wrong password; asserts malformed body returns 400.
- [x] 5.2 Add `RefreshIT`: asserts refresh happy path returns a new access token + new refresh cookie + the old refresh row's `revoked_at` is set + `replaced_by` points at the new row; asserts refresh with a missing cookie, an expired cookie, and a revoked cookie all return 401 with no new tokens minted.
- [x] 5.3 Add `LogoutIT`: asserts logout with a valid Bearer + cookie returns 204, both rows now have `revoked_at` set, and the response clears the cookie; asserts a subsequent /me with the old access token returns 401; asserts a subsequent /refresh with the old cookie returns 401; asserts logout without `Authorization` returns 401.
- [x] 5.4 Add `MeIT`: asserts /me with a valid token returns the user; asserts /me with no token, an expired token, and a revoked token all return 401.
- [x] 5.5 Add `SecurityFilterChainIT`: hits an arbitrary protected endpoint (e.g. `/me`) with no header and asserts 401 ProblemDetail; hits each allowlisted endpoint without a header and asserts the request reaches the controller (not 401).

## 6. OpenAPI contract

- [x] 6.1 Run the existing OpenAPI generation step and confirm `openapi/openapi.json` now contains operations for `login`, `refresh`, `logout`, and `me` under the `auth-controller` tag, plus `LoginRequest` and `LoginResponse` schemas.
- [x] 6.2 Verify the security scheme is declared so the generated client treats `me` and `logout` as Bearer-required (annotate the controller appropriately if springdoc does not pick this up automatically from the filter chain).

## 7. Frontend — generated client + interceptors

- [x] 7.1 Re-run Orval and confirm new generated files exist under `frontend/src/api/generated/queries/auth-controller/` and `frontend/src/api/generated/msw/auth-controller/` for the four new operations.
- [x] 7.2 Add `frontend/src/features/auth/AuthContext.tsx` exposing `{ accessToken, user, login(token, user), logout(), currentUser }`, holding state in `useState` (memory only). Wrap the app in the provider in the existing root component.
- [x] 7.3 Wire the existing Orval Axios mutator: register a request interceptor that reads the access token from a module-level reference (set by the AuthContext provider via a small `setAccessTokenGetter(...)` registration) and adds `Authorization: Bearer <token>` when present.
- [x] 7.4 Register a response interceptor that, on a 401 response from any URL other than `/api/v1/auth/login` and `/api/v1/auth/refresh`, calls a single-flight `refreshOnce()` helper (a module-level `Promise<string|null>` that all concurrent 401s await), updates AuthContext on success, retries the original request with the new token, or — on refresh failure — clears AuthContext and triggers `navigate('/login')` via a router-bridging callback registered at app start.

## 8. Frontend — login + protected routes + home

- [x] 8.1 Add `frontend/src/features/login/LoginForm.tsx` mirroring the existing signup form: react-hook-form + Zod resolver from the generated schema, fields `email` and `password`, submit via the generated `useLogin` mutation. On success: call `authContext.login(accessToken, user)` and `navigate('/home')`. On 401: render `error.detail`.
- [x] 8.2 Add `frontend/src/features/auth/ProtectedRoute.tsx`: reads `currentUser` from AuthContext; if absent, renders `<Navigate to="/login" replace />`; otherwise renders `<Outlet />` (or `children`).
- [x] 8.3 Add `frontend/src/features/home/HomePage.tsx`: calls the generated `useMe` query, renders `Hello, {data.displayName}` while loading/erroring sensibly. Includes a Logout button that calls the generated `useLogout` mutation, then `authContext.logout()`, then `navigate('/login')`.
- [x] 8.4 Update the router (existing `App.tsx` or `main.tsx`) to define `/login`, `/signup`, `/home` (wrapped in ProtectedRoute), and `/` (redirects to `/home` if `currentUser`, else `/login`).

## 9. Frontend — Vitest coverage

- [x] 9.1 Add `LoginForm.test.tsx`: success path (MSW handler returns 200 with token; assert AuthContext updated and `navigate('/home')` called) and 401 path (MSW handler returns 401 ProblemDetail; assert detail rendered).
- [x] 9.2 Add `refreshInterceptor.test.tsx`: simulates a protected call returning 401 once then 200; MSW `/refresh` handler returns 200 with new token; assert original call resolves with the 200 outcome and AuthContext is updated.
- [x] 9.3 Add a refresh-failure test: protected call returns 401; MSW `/refresh` returns 401; assert AuthContext is cleared and the `navigate('/login')` callback fires.
- [x] 9.4 Add a single-flight test: fire two concurrent protected calls that both return 401; MSW `/refresh` increments a counter on each invocation; assert it was called exactly once and both original calls resolved with the new token.

## 10. End-to-end smoke (manual + Playwright)

- [x] 10.1 Run `docker compose up`, the backend, and the frontend dev server. Manually walk: signup → land on /home (or login) → login → see Hello name → reload page (should still land on /home via transparent refresh) → click Logout → land on /login → confirm `/me` from devtools now returns 401.
- [x] 10.2 Add a Playwright e2e under `e2e/` covering signup → login → see /home → logout. Reuse existing e2e fixtures; do not overlap with backend integration test territory.

## 11. Wrap-up

- [x] 11.1 Re-run `openspec validate add-login-and-sessions --strict` and resolve any findings.
- [x] 11.2 Update `README.md` (project root) with one short section: how to log in locally (signup endpoint, login endpoint, default TTLs).
