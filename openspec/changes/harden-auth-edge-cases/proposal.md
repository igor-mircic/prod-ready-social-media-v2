# Harden auth/session edge cases

## Why

Manual use of the app surfaced UX rough edges concentrated around the auth/session lifecycle. Exploratory Playwright probes confirmed five real bugs against the live stack while ruling out three suspected ones, so the scope of this change is evidence-driven rather than speculative. The cheapest time to close these gaps is now — before more features pile on top of an auth surface that quietly drops users.

The probes also revealed that the existing user-accounts spec is internally consistent but under-specifies the *UX contract* of an authenticated SPA: nothing in the spec requires that a reload keeps the user on `/home`, nothing forbids `/login` from rendering its form to an already-signed-in user, and unknown URLs silently bounce instead of producing a clear 404. This change tightens those contracts and adds the e2e tests that prove them.

## What Changes

- **Boot-time session hydration.** On app mount the SPA attempts a one-shot `POST /api/v1/auth/refresh`. On success it hydrates `AuthContext` from `GET /api/v1/auth/me` before deciding whether to render protected routes; on failure it renders unauthenticated. A "booting" gate prevents `ProtectedRoute` from bouncing to `/login` mid-hydration.
- **Redirect-when-authenticated guards on `/login` and `/signup`.** Both routes redirect to `/home` when `AuthContext` already holds a current user, mirroring the existing `/` redirect logic.
- **"Continue to log in" affordance on the signup success card.** Replaces the current dead-end by offering an explicit, visible navigation to `/login`.
- **Explicit `NotFound` page replaces the catch-all redirect.** Unknown URLs render a 404 page (with a link back to `/` or `/home` depending on auth state), instead of silently redirecting via the `*` route.
- **E2E coverage for the bugs above and for the three behaviors that already work** (wrong-password renders the ProblemDetail.detail, unknown-email message is identical to wrong-password message, empty login fields are blocked client-side). The throwaway probe file `e2e/tests/auth-edge-probes.spec.ts` is deleted and its content promoted into named specs.

### Explicit non-goals (deferred)

- Multi-tab logout synchronization (BroadcastChannel / `storage` events).
- Auto-login after signup (would require a backend change to issue tokens on signup; not in scope).
- Pre-filling the login form from the signup success screen.
- Rate-limiting or lockout on repeated failed logins.
- Posts-vertical edge cases (composer max-length boundary, double-submit, pagination).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-accounts`: tightens the routing/session UX contract to require boot-time hydration of `AuthContext` from the refresh cookie, redirects from `/login` and `/signup` when authenticated, a "Continue to log in" affordance on the signup success state, an explicit `NotFound` page for unknown URLs, and an explicit e2e coverage requirement for these auth/session edge cases. The existing requirement that the access token is held in memory only (no `localStorage`/`sessionStorage`) is preserved; the new boot-time hydration relies on the HttpOnly refresh cookie, not web storage.

## Impact

- **Frontend code (primary):**
  - `frontend/src/features/auth/AuthContext.tsx` — adds boot-time refresh + `/me` hydration with a `booting` state.
  - `frontend/src/features/auth/ProtectedRoute.tsx` — respects the `booting` state instead of bouncing.
  - `frontend/src/features/login/LoginForm.tsx` and `frontend/src/features/signup/SignupForm.tsx` — short-circuit to `/home` when `currentUser` is already present (via a small wrapper or in-component guard).
  - `frontend/src/features/signup/SignupForm.tsx` — adds a "Continue to log in" link/button to the success card.
  - `frontend/src/App.tsx` — replaces the catch-all `*` route with a `NotFound` route + component.
  - `frontend/src/features/notfound/NotFoundPage.tsx` (new).
- **E2E suite:**
  - New: `e2e/tests/auth.session.spec.ts`, `e2e/tests/auth.errors.spec.ts`, `e2e/tests/auth.routing.spec.ts`, `e2e/tests/signup.continue.spec.ts`, `e2e/tests/not-found.spec.ts`.
  - Deleted: `e2e/tests/auth-edge-probes.spec.ts` (its content is promoted into the new files).
  - Existing tests (`signup.happy`, `signup.validation`, `signup.duplicate`, `login`, `posts`, `smoke`) are unchanged.
- **Frontend unit tests:**
  - `frontend/src/features/auth/AuthContext.test.tsx` (new or extended) — covers boot-time hydration success and failure paths via MSW.
- **Backend:** no source changes. Backend integration tests are already comprehensive for the underlying endpoints.
- **API contract:** no changes to `openapi/openapi.json`.
- **Dependencies:** no new packages.
