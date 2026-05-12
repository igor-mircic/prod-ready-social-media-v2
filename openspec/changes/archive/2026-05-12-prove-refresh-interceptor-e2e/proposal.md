## Why

PR #15 (`harden-auth-e2e`) closed the happy-path half of the SPA's
refresh-on-401 wire end-to-end, but the `user-accounts` spec (`Axios response
interceptor transparently refreshes on 401`) pins three behaviors and only one
is e2e-proven against the real backend today. The two unwalked wires are
classic interceptor failure modes — concurrent 401s storming the refresh
endpoint, and a refresh call that itself returns 401 stranding the user. The
SPA's `frontend/src/api/client.ts` has the single-flight guard
(`inflightRefresh`) and the failure handler (`refreshFailureHandler` →
AuthContext clear + redirect) wired *in the code*, but they are only proven by
a Vitest test against an MSW handler — exactly the kind of wire the harden-
auth-e2e proposal called out as "silently snaps in production without being
noticed by any existing test." After this pass, e2e coverage matches what the
specs require with no dangling pinned behaviors.

## What Changes

- Add two new Playwright scenarios that close the auth/session coverage gap:
  1. **Concurrent-401 single-flight refresh** — A signed-up user is seeded
     with at least two posts via `apiClient`, then logs in via the SPA and
     lands on `/home` with both `PostCard`s and their `Delete` buttons
     visible. The harness's existing short `app.auth.access-token-ttl` knob
     lapses the access token. The test then issues a single
     `Promise.all([deleteA.click(), deleteB.click()])` against the two
     `Delete` buttons; each click triggers an independent `useDeletePost`
     mutation through the same Axios mutator. Both `DELETE /api/v1/posts/{id}`
     requests return `401`. The test asserts the captured network sequence
     contains exactly ONE `POST /api/v1/auth/refresh` across the two
     concurrent 401s, both DELETEs are retried and succeed, both posts
     disappear from the rendered list, and the SPA stays on `/home`. The
     test pins the SPA-side single-flight guard already implemented as
     `inflightRefresh` in `frontend/src/api/client.ts`.
  2. **Refresh-401 clears auth and redirects to `/login`** — A signed-up +
     logged-in user is on `/home`. The test overwrites the browser's
     `refresh_token` cookie with a bogus opaque value via
     `page.context().addCookies(...)` (preserving `Path`, `HttpOnly`,
     `SameSite`, `Secure=false` from the harness's existing
     `APP_AUTH_REFRESH_COOKIE_SECURE=false` override), then lapses the access
     token via the existing short TTL knob. The test triggers an authenticated
     SPA action (compose a post). The action gets a `401`; the interceptor
     calls `POST /api/v1/auth/refresh` with the bogus cookie; the backend
     returns `401` because no `auth_refresh_tokens` row matches the bogus
     hash; the SPA SHALL clear `AuthContext` and redirect to `/login`. The
     test asserts the network sequence and the final URL.

- Tighten the `user-accounts` capability spec with two new scenarios under the
  existing `E2E tests cover auth/session edge cases` requirement, one per new
  test. Existing scenario text is not modified.

- Reuse the existing harness short access-token TTL (`APP_AUTH_ACCESS_TOKEN_TTL`,
  set in `e2e/src/setup/backend.ts` by PR #15) unchanged. No new harness env
  var is introduced; the `e2e` capability spec is NOT modified.

### Explicit non-goals (deferred to follow-ups)

- Any backend behavior change to the refresh flow, the security filter chain,
  or the refresh-cookie attributes. The contract these tests pin is already
  spec'd and `*IT.java`-tested; the work here is e2e proof of the SPA-side
  wire.
- Frontend changes to `frontend/src/api/client.ts`, `AuthContext`, or
  `ProtectedRoute`. The single-flight guard (`inflightRefresh`) and the
  refresh-failure handler (`refreshFailureHandler`) are already present.
  This change is test-only plus spec text.
- A second short-TTL knob for `app.auth.refresh-token-ttl`. The refresh-401
  scenario uses cookie surgery via `page.context().addCookies` to force a
  `401` from `/refresh` without depending on wall-clock lapse of the refresh
  token. Adding a second TTL knob would require all existing tests to finish
  under the refresh TTL too, which is a much bigger blast radius than the
  access-TTL knob carries today (the access TTL recovers transparently via
  the interceptor; a lapsed refresh would log every test out).
- A test-only backend endpoint to revoke a specific refresh token, or any
  new `@TestConfiguration` profile. The cookie-surgery approach uses only
  capabilities already exposed by Playwright and produces the same observable
  outcome as a server-revoked refresh row.
- Per-tab / cross-tab session handling, new axe rules, additional posts
  coverage, or any other new behavior surface. Posts e2e is settled by PR #14;
  auth happy paths are settled by PR #15.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-accounts`: Adds two new e2e scenarios under the existing
  `E2E tests cover auth/session edge cases` requirement (concurrent-401
  single-flight refresh, refresh-401 clears auth and redirects).
  No existing scenario text is modified.

## Impact

- **E2E suite (primary):**
  - New: `e2e/tests/auth.refresh.concurrent.spec.ts` covering scenario #1.
    Kept as a sibling rather than appended to `auth.refresh.spec.ts` because
    the network-capture and remount-trigger setup is structurally different
    from the single-401 test, and lifting two tests into one file would
    obscure the per-spec readability that PR #15 chose deliberately.
  - New: `e2e/tests/auth.refresh.failure.spec.ts` covering scenario #2.
- **E2E harness wiring:** No changes. The existing
  `APP_AUTH_ACCESS_TOKEN_TTL=PT2S` env override in
  `e2e/src/setup/backend.ts` is sufficient for both new tests.
- **OpenSpec specs:**
  - `openspec/specs/user-accounts/spec.md` gains two scenarios under the
    existing `E2E tests cover auth/session edge cases` requirement.
- **Backend, frontend, API contract, database, dependencies:** no changes.
  Both tests prove behavior already present in
  `frontend/src/api/client.ts` (`inflightRefresh`, `refreshFailureHandler`)
  and backend `*IT.java`-tested refresh rejection paths.
- **CI:** Two new tests, each adding roughly one access-TTL lapse
  (`PT2S + ~1s` margin) plus a remount or a compose interaction. Expected
  total added wall-clock per browser project is well under 10s.
