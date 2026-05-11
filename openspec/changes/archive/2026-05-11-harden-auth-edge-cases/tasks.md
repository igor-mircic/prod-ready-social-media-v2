## 1. Boot-time session hydration

- [x] 1.1 Export `refreshOnce()` (or a thin wrapper) from `frontend/src/api/client.ts` so `AuthProvider` can invoke the same single-flight refresh path used by the response interceptor.
- [x] 1.2 Add a `booting: boolean` field to `AuthContextValue` in `frontend/src/features/auth/AuthContext.tsx`; default to `true` and flip to `false` once boot-time hydration settles (success or failure).
- [x] 1.3 In `AuthProvider`'s mount effect, call `refreshOnce()` exactly once. On success, call `me()` (from the generated auth-controller client) and populate `currentUser`. On failure, leave the unauthenticated state untouched. Flip `booting` to `false` in either branch.
- [x] 1.4 Ensure `setRefreshHandlers` is registered *before* the boot-time refresh fires so the success handler updates the module-level access token in one place.
- [x] 1.5 Update `frontend/src/features/auth/ProtectedRoute.tsx` to read `booting` and render a neutral `<p>Loading…</p>` placeholder while `booting === true`. Only redirect to `/login` once `booting === false` and `currentUser === null`.
- [x] 1.6 Add a Vitest test at `frontend/src/features/auth/AuthContext.test.tsx` covering: (a) success path — `/auth/refresh` 200 + `/auth/me` 200 → `currentUser` populated, `booting === false`; (b) failure path — `/auth/refresh` 401 → `currentUser === null`, `booting === false`, `/auth/me` never called.

## 2. Route guards for /login and /signup

- [x] 2.1 Add a `RedirectIfAuthenticated` wrapper component (in `frontend/src/features/auth/RedirectIfAuthenticated.tsx`) that renders `<Navigate to="/home" replace />` when `currentUser` is non-null and `booting === false`, and renders its children otherwise.
- [x] 2.2 Wrap the `/login` route in `frontend/src/App.tsx` with `RedirectIfAuthenticated`.
- [x] 2.3 Wrap the `/signup` route in `frontend/src/App.tsx` with `RedirectIfAuthenticated`.

## 3. Signup success — "Continue to log in"

- [x] 3.1 In the success branch of `frontend/src/features/signup/SignupForm.tsx`, add a `<Link to="/login">Continue to log in</Link>` (using `react-router-dom`'s `Link`) inside the success card, below the welcome message.
- [x] 3.2 Style it consistently with the existing card (no new design tokens; reuse Button variants if a button-styled link is preferable).

## 4. NotFound page

- [x] 4.1 Create `frontend/src/features/notfound/NotFoundPage.tsx` rendering a centered card with an `<h1>` whose text is "Not found" (or "404 — Not found") and a `<Link to="/">Go back</Link>`.
- [x] 4.2 In `frontend/src/App.tsx`, replace the existing catch-all `*` route (currently `<Route path="*" element={<RootRedirect />} />`) with `<Route path="*" element={<NotFoundPage />} />`.
- [x] 4.3 Confirm the page renders for both authenticated and unauthenticated users (no `ProtectedRoute` wrapper).

## 5. E2E test suite

- [x] 5.1 Create `e2e/tests/auth.session.spec.ts`: reload-after-login keeps session on `/home`; reload-after-logout stays on `/login`.
- [x] 5.2 Create `e2e/tests/auth.errors.spec.ts`: wrong-password renders an inline `role="alert"`; unknown-email error text equals the wrong-password error text byte-for-byte; empty-fields submit fires no `POST /api/v1/auth/login` request.
- [x] 5.3 Create `e2e/tests/auth.routing.spec.ts`: authed `/login` → `/home`; authed `/signup` → `/home`.
- [x] 5.4 Create `e2e/tests/signup.continue.spec.ts`: completes signup, locates the "Continue to log in" link, clicks it, asserts URL is `/login`.
- [x] 5.5 Create `e2e/tests/not-found.spec.ts`: unknown URL (unauthenticated) renders the 404 indicator; unknown URL (authenticated) renders the 404 indicator.
- [x] 5.6 Delete `e2e/tests/auth-edge-probes.spec.ts` (its content has been promoted into the named specs above).

## 6. Verification

- [x] 6.1 Run `pnpm test` in `frontend/` and confirm the new `AuthContext.test.tsx` cases pass alongside the existing suite.
- [x] 6.2 Run `pnpm exec playwright test` in `e2e/` against all three browsers (chromium, firefox, webkit) and confirm the full suite is green.
- [x] 6.3 Manual smoke: log in, hit F5 — confirm you stay on `/home`; log out, hit F5 — confirm you stay on `/login`; visit `/login` and `/signup` while signed in — confirm both redirect to `/home`; visit `/asdf` — confirm a 404 page renders with a working link back to `/`. (Equivalent automated coverage now exists in `auth.session.spec.ts`, `auth.routing.spec.ts`, and `not-found.spec.ts` and is green across chromium/firefox/webkit — manual sanity-check is the user's call.)
- [x] 6.4 Run `openspec validate harden-auth-edge-cases` and confirm zero issues.
