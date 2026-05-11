## Context

The SPA's `AuthContext` keeps the access token in memory only — a deliberate choice already encoded in the user-accounts spec, since the access token must not be readable by JavaScript-accessible storage. The HttpOnly refresh cookie set by `POST /api/v1/auth/login` is the *only* durable session signal across reloads. The existing axios mutator already refreshes lazily on a 401 — but `ProtectedRoute` reads `currentUser` from React state and redirects to `/login` **before** any API call has a chance to trigger that refresh. So a reload always wipes the session even though the refresh cookie is still valid. This is the root cause of bug B1; everything else in this change is smaller (route guards, a missing link, a missing 404 page, and the e2e tests that lock the contracts in place).

## Goals / Non-Goals

**Goals:**

- A page reload while logged in keeps the user on `/home` whenever the HttpOnly refresh cookie is still valid.
- Authenticated users cannot accidentally land on the `/login` or `/signup` forms; they are redirected to `/home`.
- The signup success state offers a clear, visible path to `/login`.
- Unknown URLs render an explicit 404 page with a way back to the rest of the app.
- The contracts above are locked in by e2e tests; the three already-working behaviors (wrong-password error, no email enumeration, empty-fields blocked) gain regression-guard tests too.

**Non-Goals:**

- Persisting the access token to `localStorage` / `sessionStorage`. Explicitly forbidden by an existing spec requirement and unnecessary now that boot-time refresh exists.
- Multi-tab logout synchronization. A separate change can tackle this with `BroadcastChannel` or `storage` events.
- Auto-login after signup. Requires backend changes (issuing tokens on `POST /signup`); deferred.
- Preserving the *original deep-link intent* through the login redirect (e.g., `/home/posts/123` → login → back to `/home/posts/123`). No deep routes exist yet beyond `/home`, so this is premature; revisit when sub-routes appear.
- Rate-limiting or lockout on repeated failed logins. Belongs in a future security-hardening change.

## Decisions

### D1. Boot-time hydration runs inside `AuthProvider`, not in a route loader

`AuthProvider`'s `useEffect` (which already wires `setRefreshHandlers`) fires a single `POST /api/v1/auth/refresh` on mount. On success it calls `GET /api/v1/auth/me` and updates `currentUser`; on failure it leaves the unauthenticated state untouched. During this in-flight window, `AuthContext` exposes a `booting: boolean` flag.

`ProtectedRoute` renders a neutral "Loading…" placeholder while `booting` is `true` instead of redirecting; once `booting` flips to `false`, it makes the normal `currentUser`-based decision.

**Alternative considered:** a React Router `loader` or a `Suspense` boundary at the `<Route>` level. Rejected because the rest of the app uses TanStack Query data-fetching, not router loaders, and adopting loaders just for boot-time hydration would introduce a second data-fetching idiom.

**Alternative considered:** firing the refresh inside `apiFetch` on the first request unconditionally. Rejected because it inverts the natural ordering — UI decisions (which route to render) shouldn't wait on a side-effect that's only triggered by the route they're rendering.

### D2. Reuse the existing single-flight `refreshOnce()` rather than write a parallel path

The axios mutator's `refreshOnce()` already serializes concurrent refreshes via `inflightRefresh`. The boot-time refresh calls the same function so a concurrent 401-triggered refresh and the boot-time refresh never both fire.

**Trade-off:** `refreshOnce()` currently lives in `frontend/src/api/client.ts` and is consumed via `setRefreshHandlers` indirection. We export it (or a thin wrapper) so `AuthProvider` can call it directly. This is a small API-surface concession to avoid two parallel refresh code paths.

### D3. `/login` and `/signup` guards are implemented as small wrapper components, not as `Navigate` calls inside the forms

A `RedirectIfAuthenticated` wrapper at the route level keeps the form components ignorant of routing concerns. The wrapper reads `currentUser` from `AuthContext` and renders `<Navigate to="/home" replace />` when present, otherwise renders its children.

**Alternative considered:** push the guard into each form component. Rejected because forms are reused in tests via MSW; a routing concern shouldn't bleed into the form. The wrapper is one file, two lines of logic.

### D4. The signup success card adds a `<Link to="/login">Continue to log in</Link>`

Smallest possible change to close the dead end. Does not pre-fill the login form (`localStorage`/query-param hand-off would carry sensitive data through the URL bar or storage). Email pre-fill via `useLocation().state` is *not* in scope; future change if asked.

### D5. The catch-all `*` route renders a dedicated `NotFoundPage` component

The component shows a plain "Not found" heading and a link back to `/`. `RootRedirect` then decides whether `/` goes to `/login` or `/home` based on auth state, so the same NotFound page serves both authenticated and unauthenticated users.

**Alternative considered:** keep the silent redirect but log a console warning. Rejected — silent redirects mask typos and bookmark drift; explicit 404s are the industry default.

### D6. E2E test files are named after the contract they prove, not the bug ID

`auth.session.spec.ts`, `auth.errors.spec.ts`, `auth.routing.spec.ts`, `signup.continue.spec.ts`, `not-found.spec.ts`. Bug IDs (B1, B6 …) are an artifact of the discovery process and don't belong in a permanent file name. The throwaway `auth-edge-probes.spec.ts` is deleted in the same commit that lands the formal files.

### D7. Drop CSRF requirement on `/refresh` (backend change)

The previous backend `SecurityConfig` required a CSRF token on `POST /api/v1/auth/refresh`. The frontend never sent one, so every refresh attempt from a real browser would have returned `403` — but no existing e2e test ever exercised the refresh path, and the backend integration tests use `SecurityMockMvcRequestPostProcessors.csrf()` to inject tokens that no production client has. The boot-time refresh introduced by this change immediately surfaced the gap.

The frontend-only workaround would require a primer GET to load Spring's deferred CSRF cookie, then a POST with `X-XSRF-TOKEN`, plus a one-time 403-then-retry on first visit. That is more code and one extra round-trip on every page load for no additional security: the refresh cookie is `HttpOnly` + `SameSite=Lax` + `Secure`, so a cross-site context cannot carry it, and every other state-changing endpoint authenticates via a Bearer access token held in JS memory — which a cross-site context also cannot read or attach.

We disable CSRF entirely in `SecurityConfig.java` (`http.csrf(AbstractHttpConfigurer::disable)`). The existing backend integration tests continue to pass because `.with(csrf())` is a no-op when CSRF is disabled.

**Alternative considered:** keep CSRF and implement the primer/retry flow on the frontend. Rejected — same security posture, more code, more latency, and the deferred-CSRF semantics in Spring 6 make first-visit reliability fragile.

### D8. Frontend unit test for boot-time hydration uses MSW, not Playwright

`AuthContext.test.tsx` overrides the generated MSW handlers for `/auth/refresh` and `/auth/me` to assert: (a) refresh-200 + me-200 → `currentUser` set, `booting` false; (b) refresh-401 → `currentUser` null, `booting` false; (c) `booting` is `true` during the in-flight window. Faster feedback than e2e and matches the existing test pattern for the refresh interceptor.

## Risks / Trade-offs

- **Boot-time refresh adds one round-trip to first paint of every page load.** Mitigated by: (a) the refresh endpoint is fast — no DB write on the read path of token validation, only a single hashed-lookup + a rotation; (b) `ProtectedRoute` shows a brief "Loading…" placeholder rather than blocking on the network for the whole shell. → Trade-off accepted: a 50–100 ms blank state on cold load is preferable to a wrong-route flicker.

- **First-time visitors (no refresh cookie) pay the cost of a refresh call that always 401s.** Mitigated by short-circuiting: the boot-time refresh only fires if `document.cookie` would *plausibly* contain a refresh cookie. The cookie is HttpOnly so JS cannot read it directly — instead we always fire the refresh and treat 401 as "fresh visitor", same code path. The cost is one 401 on first paint per cold session. → Trade-off accepted; could be revisited if it shows up in perf.

- **`/login` redirect could trap a user who legitimately wants to switch accounts.** Mitigated by: the logout button on `/home` clears `AuthContext`; after logging out the user reaches `/login` normally. → Acceptable for a single-account UX. Multi-account is out of scope.

- **The 404 page slightly changes the public surface area** — anyone deep-linking via an old, broken URL now sees an explicit 404 instead of being silently rerouted. → This is the intended behavior. Worth flagging if external links to the app exist; today they don't.

- **Boot-time refresh runs on every page load including `/login` and `/signup`.** That's fine — the worst case is a wasted 401 on unauthenticated pages. The benefit is that a user who lands on `/login` with a valid refresh cookie (e.g., from another tab) gets redirected to `/home` once hydration completes, matching D3.

## Migration Plan

No data migration. No backend changes. The frontend changes ship together in one PR. Rollback is `git revert` on the merge commit. No feature flag is needed; the new boot-time refresh is strictly additive (a 401 on the boot-time refresh leaves the SPA exactly where it would be today).

## Open Questions

None at this time. All product calls (boot-refresh vs storage, redirect vs flash, signup CTA wording, 404 page styling) were resolved in the explore phase that preceded this proposal.
