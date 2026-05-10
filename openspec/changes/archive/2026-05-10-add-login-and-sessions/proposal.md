## Why

Signup is implemented end-to-end, but a user that signs up cannot do anything afterwards — there is no way to log in, no notion of an authenticated session, and no protected surface to attach future capabilities (posts, feed, follows) to. Without authentication, every subsequent capability is blocked or has to be specced against a hypothetical session model. This change establishes that session model now so future capabilities can assume it.

## What Changes

- Add `POST /api/v1/auth/login` returning a short-lived access token in the response body and a long-lived refresh token in an `HttpOnly` cookie.
- Add `POST /api/v1/auth/refresh` that consumes the refresh cookie, rotates the refresh token, and returns a new access token.
- Add `POST /api/v1/auth/logout` that revokes the caller's access token and the refresh cookie's token, and clears the cookie.
- Add `GET /api/v1/auth/me` returning the authenticated user.
- Persist tokens in two new tables (`auth_access_tokens`, `auth_refresh_tokens`) created by Flyway migration `V2`. Tokens are stored as SHA-256 hashes; only the bearer holds the plaintext.
- Configure a `SecurityFilterChain` that is **deny-by-default**, with an explicit allowlist for unauthenticated endpoints (`signup`, `login`, `refresh`, health, OpenAPI/Swagger).
- Add a custom `BearerTokenAuthenticationFilter` that reads `Authorization: Bearer <token>`, validates the access token row, and populates `SecurityContext`.
- Add a frontend login form (mirroring the existing signup form), an in-memory `AuthContext`, request/response Axios interceptors (attach `Authorization`, transparently refresh on 401), a `ProtectedRoute` wrapper, and a minimal authenticated `/home` page that calls `/me` to prove the wire end-to-end.
- Regenerate the OpenAPI document and the Orval-generated frontend client (queries, Zod schemas, MSW handlers) for the four new endpoints.
- Vitest coverage for the login form (success + 401) and the refresh interceptor (transparent retry + give-up-and-redirect).

Not in this change (deferred to later changes, listed here so it is clear they are intentionally out): password reset, email verification, rate limiting and account lockout, MFA, OAuth/social login, per-resource authorization beyond "is the request authenticated?", account deletion, refresh-token reuse detection (family rotation), session-listing UI, remember-me toggle.

## Capabilities

### New Capabilities

None. Authentication belongs to the existing `user-accounts` capability alongside signup.

### Modified Capabilities

- `user-accounts`: Adds requirements for login, refresh, logout, current-user (`/me`), the deny-by-default security filter chain with allowlist, the bearer-token authentication filter, the access/refresh token storage model, and the frontend auth context, interceptors, protected-route wrapper, and login form.

## Impact

- **Backend**: New Flyway migration `V2__create_auth_tokens.sql`. New classes in `backend/src/main/java/com/prodready/social/useraccounts/` for the four endpoints, the token services, the security filter chain configuration, and the bearer-token filter. New `application.yml` keys `app.auth.access-token-ttl` (default `PT15M`) and `app.auth.refresh-token-ttl` (default `P30D`). New Testcontainers integration tests.
- **OpenAPI contract**: `openapi/openapi.json` gains four operations under the `auth-controller` tag and new schemas (`LoginRequest`, `LoginResponse`).
- **Frontend**: New modules under `frontend/src/features/login/`, `frontend/src/features/auth/`, and `frontend/src/features/home/`. New Axios interceptors wired into the existing Orval mutator. Routing gains `/login` and `/home` routes; `/` redirects based on auth state. Orval regenerates `frontend/src/api/generated/**` for the new endpoints.
- **Dependencies**: No new dependencies on the backend (Spring Security and `spring-security-crypto` are already on the classpath via `BCryptPasswordEncoder`). No new dependencies on the frontend.
- **Forward-compatibility**: The chosen design must keep working when nginx is later put in front of the backend, and must allow swapping the in-app authentication for an external IdP (e.g. Keycloak) by replacing only the `BearerTokenAuthenticationFilter`. See `design.md` for the rationale and constraints.
