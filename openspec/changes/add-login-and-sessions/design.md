## Context

The repository already implements signup end-to-end (`user-accounts` spec): a `users` table, `POST /api/v1/auth/signup`, bcrypt hashing via `spring-security-crypto`, a `ProblemDetail`-based error contract, an Orval-generated frontend client, and a signup form with Vitest + MSW coverage. There is no notion of an authenticated session yet — `SecurityFilterChain` is not customized, no endpoint requires authentication, and the frontend has no concept of a logged-in user.

This change closes that loop. The constraints that shape the design are:

- The stack is Spring on Postgres with Flyway migrations. Adding new infrastructure (Redis, an external IdP) for v1 is undesirable; the bar to introduce a new dependency is "the alternative is materially worse," not "this is what people usually pick."
- The deployment topology may grow an nginx reverse proxy in front of the backend later. The auth design must not depend on JVM-local state (e.g. in-memory `HttpSession`) and must not rely on cookie-domain tricks that are fragile behind a proxy.
- The auth surface should be replaceable later by an external IdP (Keycloak, Auth0, Cognito) without rewriting controllers. The seam is the part of the request pipeline that turns "credential material on the wire" into "a `SecurityContext` principal."
- The frontend is a same-origin SPA built with Vite + React + TanStack Query, talking to the backend via an Orval-generated Axios client. Token-handling code in the SPA must be small, centralized, and resistant to XSS.

## Goals / Non-Goals

**Goals:**

- A logged-in user has a stable, revocable identity that survives page reload but not indefinite token theft.
- The access token is never readable by JavaScript running in the SPA.
- Logout actually invalidates credentials server-side (not just "forget the token client-side").
- The backend's authentication seam is one class. Swapping the in-app implementation for an OAuth2 resource server is a localized change.
- The wire shape of an authenticated request (`Authorization: Bearer <opaque-string>`) matches what an external IdP would produce, so client code does not have to change when the issuer changes.
- The design works unchanged when nginx is added in front of the backend.

**Non-Goals:**

- Stateless validation. Every authenticated request hits the database to look up the access token row. This is acceptable at the scale the project targets and is what makes revocation trivial.
- A multi-issuer / federated identity story.
- Token issuance for third-party clients (no OAuth2 authorization-server semantics, no client credentials grant, no PKCE).
- Cross-origin auth. The SPA and API are assumed same-origin in development (Vite proxy) and in production (either same host or behind a single nginx).
- Out of v1: password reset, email verification, MFA, rate limiting / lockout, OAuth/social login, per-resource authorization beyond authentication, session-listing UI, "log out everywhere," remember-me toggle, refresh-token reuse-detection cascade.

## Decisions

### Decision 1: Spring Security primitives, not Spring Authorization Server, not an external IdP

Use `SecurityFilterChain`, `PasswordEncoder`, and a custom `AuthenticationFilter`. Do not introduce Spring Authorization Server. Do not wire to Keycloak, Auth0, or any external IdP for v1.

**Rationale:** Spring Authorization Server is an OAuth2 *issuer*, which is overkill for "a SPA talks to its own backend." An external IdP solves a problem (centralized identity across many apps) we do not have yet, costs a non-trivial amount to stand up locally, and slows the feedback loop on every other feature. Spring Security primitives cover what we need with no new dependencies.

**Alternatives considered:**
- *Roll our own filter and password handling:* Rejected. `BCryptPasswordEncoder` and `SecurityFilterChain` are exactly the parts you should not hand-write.
- *Spring Authorization Server:* Rejected for v1; we are not issuing tokens for third-party clients.
- *External IdP from day one:* Rejected for v1. Keep it as the swap target, not the initial implementation.

### Decision 2: Opaque tokens persisted in Postgres, not JWTs

The access token and the refresh token are both 256-bit opaque random strings (base64url-encoded). The server stores SHA-256 hashes in two new tables:

```
auth_access_tokens  (id UUID PK, user_id UUID FK, token_hash TEXT UNIQUE,
                     created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
                     revoked_at TIMESTAMPTZ NULL)

auth_refresh_tokens (id UUID PK, user_id UUID FK, token_hash TEXT UNIQUE,
                     created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
                     revoked_at TIMESTAMPTZ NULL,
                     replaced_by UUID NULL  -- points to the rotation successor)
```

Both tables index `token_hash` for O(1) lookup on the request path.

**Rationale:** JWT signing introduces a key-rotation problem, a clock-skew problem, and a "how do we revoke this" problem we would have to solve anyway by maintaining a server-side revocation list. Opaque tokens make all three problems disappear. The cost — one indexed lookup per authenticated request — is acceptable at our scale and would be the same cost as a JWT revocation check.

**Alternatives considered:**
- *Signed JWT access + opaque refresh:* The "modern OAuth" canonical pattern. Rejected for v1 because the only thing it buys us at our scale is statelessness, which we are not optimizing for.
- *Spring Session (server session in Postgres):* Rejected. Spring Session works fine and is more turnkey, but couples the wire format to a session cookie and is harder to evolve into a Bearer-token contract that an external IdP could later produce.

### Decision 3: Two-token pattern — access in memory, refresh in `HttpOnly` cookie

The login response returns the access token in the JSON body and sets the refresh token as a cookie:

```
Set-Cookie: refresh_token=<opaque>;
            HttpOnly; Secure; SameSite=Lax;
            Path=/api/v1/auth/refresh;
            Max-Age=<refresh-ttl-seconds>
```

The SPA holds the access token in React context (memory only) and sends it as `Authorization: Bearer <token>` on every API call. When an authenticated call returns 401, an Axios response interceptor calls `/api/v1/auth/refresh` (which the browser auto-attaches the cookie to), receives a new access token, and retries the original request. If the refresh call itself returns 401, the SPA clears the auth context and redirects to `/login`.

The cookie's `Path=/api/v1/auth/refresh` is deliberate: the cookie is only attached to the refresh endpoint, so it is not exposed on every API call.

**Rationale:** This separates the two attack surfaces. XSS cannot read the refresh token (it is `HttpOnly`). XSS *can* exfiltrate the access token from memory if it runs in the SPA's origin — but the access token is short-lived (15 minutes) and revocable. CSRF is not a concern for any endpoint authenticated by `Authorization` header (CSRF requires the browser to attach credentials automatically; bearer headers are explicit). CSRF *is* a concern for `/api/v1/auth/refresh` (cookie-authed), so Spring Security's CSRF protection is enabled for that one endpoint; same-site=lax on the cookie is a second line of defence.

**Alternatives considered:**
- *Access token in `localStorage`:* Rejected. XSS-readable. The original "lock in" candidate (cookie + Bearer-or-cookie filter) is also rejected because it makes refresh-token theft equivalent to access-token theft.
- *Single long-lived token in `HttpOnly` cookie (no refresh):* Rejected. Logout-style revocation is fine, but every API call would need CSRF protection, which complicates the contract.
- *Refresh-token reuse-detection family rotation:* Out of scope for v1 (see "Risks / Trade-offs"). On reuse of a revoked refresh token, v1 simply returns 401 without cascading.

### Decision 4: `SecurityFilterChain` is deny-by-default with an explicit allowlist

The filter chain requires authentication for every request except an explicit allowlist:

```
permitAll: POST /api/v1/auth/signup
           POST /api/v1/auth/login
           POST /api/v1/auth/refresh
           GET  /actuator/health
           GET  /v3/api-docs/**
           GET  /swagger-ui/**
           GET  /favicon.ico
deny:      everything else (returns 401 ProblemDetail if no/invalid token)
```

**Rationale:** Deny-by-default makes "I forgot to protect this endpoint" impossible — the symptom is a 401 in tests, not a security incident in production. The allowlist is short and central enough to review.

**Alternatives considered:**
- *Allow-by-default + `@PreAuthorize` on protected methods:* Rejected. Easy to forget. The whole point of a security filter is to fail closed.

### Decision 5: One authentication seam — `BearerTokenAuthenticationFilter`

A single custom filter sits in the chain before the authorization step. Its only job: read `Authorization: Bearer <token>`, hash it, look up `auth_access_tokens`, validate `revoked_at IS NULL` and `expires_at > now()`, and populate `SecurityContext` with a `UserPrincipal`. If the header is absent or invalid, the filter does nothing — the downstream authorization step turns "no principal" into 401.

**Rationale:** Concentrates the entire "what does authentication mean" decision in one ~50-line class. To swap to an external IdP, replace this filter with `oauth2ResourceServer().jwt()` (or equivalent) and the rest of the codebase does not change.

### Decision 6: Forward-compatibility with nginx

- Set `server.forward-headers-strategy=framework` so Spring trusts `X-Forwarded-*` from a reverse proxy.
- Do not use any `HttpSession` state; the design is fully cookie + DB.
- Cookie attributes (`Secure`, `Path=/api/v1/auth/refresh`) are set unconditionally; `Secure` is fine in local dev because the SPA + API are same-origin behind Vite's HTTPS-capable dev server (and we do not depend on cross-origin cookie behavior).
- The auth seam is `Authorization: Bearer <token>`, which lets nginx later short-circuit unauthenticated requests via `auth_request /api/v1/auth/me` if we want edge-level enforcement.

### Decision 7: The `user-accounts` capability owns auth

Authentication-of-an-account is part of the same capability as the account itself. The change adds requirements to `openspec/specs/user-accounts/spec.md` rather than spawning a new capability.

**Rationale:** A "users" capability that does not include "users log in" would be artificial. Authorization, when it arrives, is a different capability — that one will live separately.

## Risks / Trade-offs

- **Refresh-token theft has a 30-day window.** A stolen refresh token can be exchanged for access tokens for the rest of its TTL. Mitigation in v1: rotation on every refresh (a stolen-and-used refresh token immediately revokes the legitimate one, which surfaces as the legitimate user being logged out — noisy, but detectable). Mitigation deferred to a later change: reuse-detection family rotation (revoke the entire chain when a revoked refresh token is presented).
- **Every authenticated request hits the DB.** A token-lookup query per request is a known cost. At the scale this project targets (single-instance backend, Postgres with an index on `token_hash`), this is fine. Mitigation if it ever isn't: caching layer in front of the access-token table, or moving to signed access tokens — both are local changes inside `BearerTokenAuthenticationFilter`.
- **XSS in the SPA can exfiltrate the access token.** This is an inherent limitation of any browser-side auth; the refresh token is protected (`HttpOnly`) but the access token is not. Mitigation: short access-token TTL (15 min) and revocability. Defence in depth: keep the SPA's third-party JS surface small; CSP comes in a later change.
- **CSRF on `/api/v1/auth/refresh`.** That endpoint is cookie-authed and a successful CSRF would let an attacker mint a fresh access token *and read it* (because the refresh response body contains the new access token, which a cross-origin attacker cannot read due to CORS — but a same-origin XSS could). Mitigation: Spring Security's CSRF protection is enabled for this endpoint; `SameSite=Lax` on the cookie is a backstop.
- **Clock drift between app instances.** Token expiry is checked against `now()` in SQL, not in the JVM, which sidesteps inter-JVM clock drift. There is no JWT clock-skew problem because there is no JWT.
- **Migration ordering.** `V2__create_auth_tokens.sql` depends on the `users` table from `V1`. Flyway runs migrations in order, so this is automatic; tests must use the same Flyway context (already true via Testcontainers).
- **Deliberate v1 simplifications, called out so they are not mistaken for oversights:** no reuse-detection cascade on refresh-token replay, no "log out all sessions" UI, no remember-me toggle (refresh TTL is fixed), no rate limiting on login (a brute-force defence belongs in a later change alongside lockout/captcha).
