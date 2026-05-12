## Why

PRs #10–#14 closed every named e2e gap on the `posts` capability — cross-user
read/list, cursor pagination through two and three pages, cross-user pagination,
composer XSS / double-submit / max-length, "Load more" loading state, and explicit
axe scans on `/login`, `/signup`, and `/home`. The next-richest coverage gap is no
longer in `posts`; it has migrated up to `user-accounts`. Four small, spec-aligned
holes remain in the auth/session e2e suite, and together they form the next
believable hardening pass before product scope grows on top of the auth vertical.

Each gap is small on its own — what holds them as one PR is the same logic that
bundled `harden-posts-e2e`: none of these are new ideas, every item is already
implied by an existing requirement, and shipping seven near-duplicate auth PRs would
carry the same scope-and-non-goals boilerplate four times over.

The load-bearing item is the refresh-on-401 proof. The user-accounts spec already
requires "Axios response interceptor transparently refreshes on 401", but the only
proof of that wire is a Vitest test against an MSW handler — the SPA has never
actually walked the interceptor against the real backend's `/api/v1/auth/refresh`
endpoint, and that's exactly the kind of wire that silently snaps in production
without being noticed by any existing test.

## What Changes

- Add four new Playwright scenarios that close the auth/session coverage gap:
  1. **Refresh-on-401 end-to-end** — Boot the e2e backend with a short
     `app.auth.access-token-ttl` (e.g. `PT2S`) so the access token actually lapses
     during a test. A user signs up + logs in via the SPA, waits for the token to
     expire, then triggers an interaction that hits an authenticated endpoint
     through the SPA (e.g. composing a post, or letting `/me` re-query). The
     Axios response interceptor SHALL transparently call `/api/v1/auth/refresh`,
     rotate the refresh token, mint a new access token, and the SPA SHALL stay on
     `/home` with the originating request succeeding. The test asserts on the
     observed network sequence (one `401` followed by one `POST /refresh` followed
     by one successful retry) and on the final UI state (still on `/home`, the
     interaction's outcome rendered).
  2. **Logout server-side revocation** — Capture the access token via
     `loginViaApi` before driving the SPA logout, then after the SPA logout
     completes, replay the captured token through `apiClient` against an
     authenticated endpoint (e.g. `GET /api/v1/users/{me}/posts`). The response
     SHALL be `401`. Closes the security-flavored half of the logout contract —
     the SPA-side "stays on /login after reload" half is already proven by the
     existing `auth.session.spec.ts`.
  3. **Unauth direct nav to `/home` redirects to `/login`** — Mirror the existing
     `auth.routing.spec.ts` direction (authenticated → `/login` / `/signup` redirects
     to `/home`). A fresh, unauthenticated `page` visits `/home` directly via
     `page.goto`; the URL ends on `/login` and the Log-in heading is visible.
  4. **Explicit axe scan on `/not-found`** — `axe.routes.spec.ts` today pins
     explicit `runAxeScan` calls on `/login`, `/signup`, and `/home`. The
     `/not-found` route gets only the implicit per-test scan. Add an explicit
     scan on `/not-found`, both for an unauthenticated and an authenticated user,
     matching the two `not-found.spec.ts` cases that already exist.

- Tighten the `user-accounts` capability spec with one new e2e scenario per item,
  placed under the existing `E2E tests cover auth/session edge cases` requirement.
  Existing scenario text is not modified.

- Extend the `e2e` capability spec with one new requirement covering the e2e
  harness's short-TTL knob. The harness SHALL pass a low ISO-8601 duration for
  `app.auth.access-token-ttl` to the backend it boots, so refresh-flow scenarios
  can lapse the token within a test budget. Production and dev defaults stay at
  `PT15M`.

- Modify the existing `e2e` capability requirement `Tests do not use
  waitForTimeout` to permit `page.waitForTimeout` in two narrowly-scoped
  situations only: (a) as a short buffer (≤500ms) before asserting the absence
  of an event that would otherwise be hard to disprove (the pattern already
  used by `posts.spec.ts`, `posts.composer.hardening.spec.ts`, and
  `auth.errors.spec.ts` for "no POST fired" / "no duplicate row" checks); and
  (b) to lapse a test-configured short TTL (e.g. the harness's
  `app.auth.access-token-ttl`) where no synchronous Playwright event can be
  awaited because the trigger is wall-clock time on the server. All other
  fixed-duration sleeps remain forbidden. This change codifies the de-facto
  practice introduced by PRs #13–#14 rather than silently widening it.

- Extend the e2e helper layer with the small additions the new specs need (sized
  to match the existing `loginViaApi` / `signupViaApi` helper shape):
  - A helper (or inline equivalent) to capture the access token returned by
    `loginViaApi` and replay it through `apiClient` after the SPA's logout, so
    the revocation assertion does not need to fish the token out of axios state.
    The `loginViaApi` helper already returns `{ accessToken }` (see usage in
    `e2e/tests/posts.composer.hardening.spec.ts`), so no new helper signature is
    strictly required — the test wires this directly.

### Explicit non-goals (deferred to follow-ups)

- Any backend behavior change to the refresh flow itself. The short TTL is a
  *harness boot parameter* using the existing `app.auth.access-token-ttl` knob;
  the refresh-rotate logic, cookie attributes, and `replaced_by` chain are
  already spec'd and `*IT.java`-tested.
- A test-only "force-expire-my-token" backend endpoint. The TTL approach is
  cheaper, uses an existing knob, and adds no new surface area to the backend.
- Reducing the default `app.auth.access-token-ttl` anywhere outside the e2e
  harness. `PT15M` stays as the production and dev default; the override is
  scoped to the harness's backend boot only.
- Per-tab or cross-tab session handling (e.g. logout in tab A also logs out
  tab B). The SPA does not implement cross-tab notification today, and adding
  one is product scope.
- New axe rules, custom severity gates, or non-implicit scans on routes beyond
  `/not-found`. The new axe assertions use the existing `runAxeScan` fixture
  as-is.
- Frontend changes to the refresh interceptor, `ProtectedRoute`, or `NotFound`
  page. This change is test-only plus spec text.
- Any further posts coverage. Posts e2e is considered settled by PR #14.
- Asserting on the rotated refresh-token cookie's `Set-Cookie` attributes via
  the SPA. Cookie attributes are pinned by backend `*IT.java` tests on
  `/api/v1/auth/login` and `/api/v1/auth/refresh`; the e2e proof here is the
  observable SPA-stays-on-/home outcome, not the cookie header bytes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-accounts`: Adds four new e2e scenarios under the existing
  `E2E tests cover auth/session edge cases` requirement (refresh-on-401,
  logout server-side revocation, unauth `/home` bounce, axe on `/not-found`).
  No existing scenario text is modified.
- `e2e`: Adds one new requirement allowing the harness to pass a short
  `app.auth.access-token-ttl` to the backend it boots. Modifies the existing
  `Tests do not use waitForTimeout` requirement to permit the two narrow
  patterns described under "What Changes" (absence-assertion buffer and
  configured-TTL lapse).

## Impact

- **E2E suite (primary):**
  - New: `e2e/tests/auth.refresh.spec.ts` covering scenario #1.
  - New: `e2e/tests/auth.logout-revocation.spec.ts` covering scenario #2
    (kept as a sibling rather than appended to `auth.session.spec.ts` because
    the revocation check is on the API surface, not the SPA's URL state).
  - Extended: `e2e/tests/auth.routing.spec.ts` gains scenario #3 (the
    file already houses authed→redirect cases; the unauth→redirect mirror
    belongs alongside them).
  - Extended: `e2e/tests/axe.routes.spec.ts` gains scenario #4 (both an
    unauth and an authed `/not-found` scan).
- **E2E harness wiring:**
  - The harness boot path (`e2e/src/setup/` or equivalent — verify against the
    actual layout) passes `APP_AUTH_ACCESS_TOKEN_TTL=PT2S` (or similar
    short ISO-8601 duration) as an env var to the backend it boots, mapped to
    Spring's `app.auth.access-token-ttl` via standard env-to-property binding.
    The exact TTL value is a tuning knob; the spec requires only that it is
    short enough to lapse within a Playwright test budget.
- **OpenSpec specs:**
  - `openspec/specs/user-accounts/spec.md` gains four scenarios under the
    existing `E2E tests cover auth/session edge cases` requirement.
  - `openspec/specs/e2e/spec.md` gains one new requirement on the
    short-TTL harness knob.
- **Backend, frontend, API contract, database, dependencies:** no changes.
  Spring already supports env-driven override of `app.auth.access-token-ttl`
  per the existing spec; no new env wiring or property is introduced.
- **CI:** The refresh-on-401 spec adds a small fixed wait (token TTL + safety
  margin, e.g. `PT2S` + ~500ms) per test invocation. Expected to stay well
  under existing per-spec timeouts. The axe `/not-found` additions are
  negligible cost.
