## Context

PR #15 (`harden-auth-e2e`) introduced the harness's short
`app.auth.access-token-ttl` override (`APP_AUTH_ACCESS_TOKEN_TTL=PT2S` in
`e2e/src/setup/backend.ts`) and the first e2e proof of the SPA's Axios
refresh-on-401 wire. The `user-accounts` capability spec at lines 485–490
pins three behaviors for that wire (single 401 → refresh → retry; concurrent
401s → exactly one refresh; refresh-401 → clear auth + redirect to `/login`).
Only the first is e2e-proven against the real backend today; the other two
are only proven by `frontend/src/features/auth/refreshInterceptor.test.tsx`
against MSW.

Code state, verified against the tree:

- `frontend/src/api/client.ts` already implements the single-flight guard via
  module-scoped `inflightRefresh` and the failure path via
  `refreshFailureHandler`. The failure handler is registered by
  `AuthContext`'s `AuthProvider` (App.tsx wires `onSessionExpired={() =>
  navigate('/login')}`), and it clears the access token getter + handlers
  before redirecting.
- `frontend/src/features/posts/PostCard.tsx` exposes a per-card `Delete`
  button (`aria-label="Delete post"`) wired to `useDeletePost`. Each card
  holds its own mutation state — `disabled={deleteMutation.isPending}` —
  so two cards' delete buttons can be clicked in parallel and fire two
  independent `DELETE /api/v1/posts/{id}` requests through the shared Axios
  mutator (`apiFetch`).
- `frontend/src/features/home/HomePage.tsx` gates `<PostList>` behind
  `meQuery.isLoading`. Naïve "remount `HomePage`" approaches do NOT produce
  concurrent `GET /me` + `GET /users/{id}/posts` calls — those queries fire
  serially because `PostList` mounts only after `useMe()` resolves. This
  rules out remount-based triggers for the single-flight test.
- The SPA's `QueryProvider` (`frontend/src/api/query-provider.tsx`) sets
  `retry: false` and `refetchOnWindowFocus: false`, which keeps TanStack
  Query from masking 401s under automatic retries.
- The backend's refresh-cookie attributes are
  `HttpOnly; SameSite=Lax; Path=/api/v1/auth/refresh; Secure=<env-driven>`,
  with `Secure=false` under the harness via the existing
  `APP_AUTH_REFRESH_COOKIE_SECURE=false` override.
- The backend's `POST /api/v1/auth/refresh` returns `401` for a missing,
  expired, revoked, OR present-but-unknown cookie value (the "row present"
  predicate fails for an unknown value, returning `401 ProblemDetail`). This
  is the lever the refresh-401 test pulls.

## Goals / Non-Goals

**Goals:**

- Prove the SPA's single-flight refresh guard against the real backend
  end-to-end, using only existing SPA surface (two `PostCard.Delete`
  buttons) so the trigger is deterministic and matches the way the SPA is
  actually used.
- Prove the SPA's refresh-failure → `AuthContext` clear → redirect-to-`/login`
  wire against the real backend, without depending on a wall-clock lapse of
  the refresh token and without adding a backend test seam.
- Keep the proposal test-only: no frontend code changes, no backend code
  changes, no new harness env vars.

**Non-Goals:**

- A frontend "test seam" exposing `apiFetch`, `refreshOnce`, or the
  TanStack `QueryClient` on `window` for e2e access. The proposal lives
  entirely on SPA-natural triggers — parallel UI clicks for the
  single-flight test, browser cookie overwrites for the failure test.
- A second short-TTL harness knob for `app.auth.refresh-token-ttl`. A short
  refresh TTL would log every existing test out mid-suite once any single
  test exceeded the refresh TTL; the cookie-surgery approach lets only the
  refresh-401 test see a "broken" refresh cookie without bleeding into
  other tests.
- A backend test-only "force-expire-my-token" or "revoke-my-refresh"
  endpoint. The cookie-surgery approach produces the same observable
  outcome as a server-revoked refresh row without any new backend surface.
- An e2e proof that the SPA does NOT call `/refresh` when `POST /login`
  itself returns `401`. That fourth scenario from `user-accounts` is
  already implicitly enforced by `auth.errors.spec.ts` (a spurious refresh
  call would redirect the user, breaking the existing inline-error
  assertions). Adding an explicit network-absence assertion is cheap but
  not load-bearing; if reviewers want it, it can ride this change as a
  trivial extension or land separately.

## Decisions

### Decision 1: Trigger concurrent 401s via two synchronous `PostCard.Delete` clicks plus a throttled refresh response

The single-flight test seeds 2 posts via `apiClient` before login, then on
`/home` dispatches both delete buttons' click events in a single page-side
JS tick:

```ts
await page.evaluate(() => {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[aria-label="Delete post"]'),
  )
  for (const b of buttons) b.click()
})
```

and throttles the refresh response so both 401-triggered `refreshOnce()`
calls land while the in-flight refresh is still pending:

```ts
await page.route('**/api/v1/auth/refresh', async (route) => {
  await new Promise((r) => setTimeout(r, 800))
  await route.continue()
})
```

Each click invokes a distinct `useDeletePost` mutation owned by its own
`PostCard`. Both mutations call into the shared `apiFetch` mutator. Both
fire `DELETE /api/v1/posts/{id}` in the same tick. With the access token
lapsed, both receive `401`. The first `401` calls `refreshOnce()` which sets
`inflightRefresh` and starts the HTTP refresh; the second `401` calls
`refreshOnce()` while `inflightRefresh` is still set (kept pending for
~800ms by the route handler) and awaits the same promise. Exactly one
`POST /api/v1/auth/refresh` reaches the wire. Both DELETEs then retry
against the rotated access token and succeed.

**Why not `Promise.all([clickA, clickB])`?** Empirically (verified against
Firefox during this change), Playwright's `Promise.all` over two
`Locator.click()` calls serializes per-click actionability checks. On
faster browsers the first click's full 401→refresh→retry cycle can
complete (~50ms total) before the second click even actuates, so each
DELETE ends up firing its own refresh — defeating the single-flight
property under test. Dispatching both `.click()` invocations synchronously
in the page context puts them in the same microtask round, and the
throttled refresh response widens the in-flight window enough to absorb
the remaining per-browser variance.

**Why is the throttling `page.route`-based delay not a "test-flow sleep"?**
The e2e spec's `Tests do not use waitForTimeout` requirement forbids
`page.waitForTimeout` and `setTimeout`-based synchronization helpers. The
delay here lives inside a Playwright route handler — it shapes the
network's response to a specific request, it does not synchronize the test
body. The test still asserts on observable network and DOM state; the
route delay only widens an otherwise-narrow race window so the assertion
becomes deterministic across browsers.

**Why two Delete buttons specifically?** This is the only SPA surface today
that lets two authenticated requests fire from a single user interaction
without anti-double-submit guards in the way. `PostComposer` disables its
submit during `isPending` (proven by
`posts.composer.hardening.spec.ts:rapid-double-click`). `useMe()` and
`useListPostsByAuthor()` fire serially because `HomePage` gates `<PostList>`
on `meQuery` resolving. `Log out` navigates to `/login` on settled, so it
can't be paired. `PostCard.Delete` is per-card with independent mutation
state, so two cards' buttons are truly parallel.

**Alternatives considered:**

- *HomePage remount via `/login` redirect*: serial because `<PostList>`
  doesn't mount until `useMe()` resolves. Rejected.
- *Expose `apiFetch` on `window` behind a `MODE !== 'production'` guard*:
  cleanest semantically, but the harness builds and serves the production
  Vite bundle (per the `e2e` spec's "production-built artifacts" rule).
  Conditionally attaching `apiFetch` in production is a real frontend
  behavior change. Rejected.
- *Build the frontend with `--mode e2e`*: violates the spirit of "production
  artifacts." Rejected.
- *`Promise.all([compose.click(), loadMore.click()])` from `/home` with
  pagination already loaded*: PostComposer's submit is disabled while the
  mutation is in flight, so the second compose click after a 401 would
  silently no-op. Load more would fire one call. Less symmetric than two
  Delete clicks. Rejected.
- *Two browser tabs in the same context, each on `/home`*: each tab has its
  own `AuthContext` + module state, so a refresh in tab A doesn't propagate
  to tab B. The two tabs each see their own single 401, not concurrent
  401s in one interceptor instance. Rejected.

### Decision 2: Force `/refresh` to return 401 via `page.context().addCookies` cookie surgery

The refresh-401 test signs up + logs in via the SPA so the
`AuthContext` holds a live access token and the browser has a live refresh
cookie. It then overwrites the `refresh_token` cookie with a bogus opaque
value (e.g. `bogus-${randomUUID()}`) via
`page.context().addCookies([{ name: 'refresh_token', value: '...', domain,
path: '/api/v1/auth/refresh', httpOnly: true, sameSite: 'Lax', secure:
false, expires: -1 }])`. The SPA's in-memory `AuthContext` is untouched —
the access token is still held by `accessTokenGetter`. The TTL lapses; the
test triggers a compose. `apiFetch` adds the lapsed bearer; backend
returns `401` on `POST /api/v1/posts`; interceptor calls
`POST /api/v1/auth/refresh`; backend looks up the cookie's value in
`auth_refresh_tokens`, finds no row, returns `401 ProblemDetail`;
`refreshOnce` reads `!response.ok`, calls `refreshFailureHandler`, returns
`null`; `AuthProvider`'s wired `onSessionExpired` clears auth state and
navigates to `/login`.

**Why cookie surgery instead of server-side revocation?** Server-side
revocation (e.g. via `POST /logout` from outside the SPA) requires the
SPA's current access token to authenticate the logout, then would also
clear the cookie via `Set-Cookie: refresh_token=; Max-Age=0` — leaving the
browser with no cookie to send and no way to put the *revoked* cookie back
without also stealing the SPA's session state. Cookie surgery is
strictly local to the browser and produces an indistinguishable observable
outcome (the backend returns `401` either way — "row not found" and "row
revoked" both fail the "row present AND `revoked_at IS NULL` AND
`expires_at > now()`" predicate from the `Refresh endpoint rotates …`
requirement, both with `ProblemDetail`).

**Alternatives considered:**

- *Wall-clock lapse of `app.auth.refresh-token-ttl` via a second harness
  env var*: would log every test out once it exceeded the refresh TTL.
  Blast radius too large for the harness's single-backend-per-run model.
  Rejected.
- *Server-side revocation via `POST /logout` + cookie restoration*: needs
  a second login to get a fresh access token after the surgical logout
  clears the cookie, then needs `page.context().addCookies` to put the
  revoked value back. Cookie surgery without the logout dance gets to the
  same observable state in one step. Rejected.
- *Add a test-only `@Profile("e2e")` endpoint to revoke a specific refresh
  row*: new backend surface; needs IT coverage; needs a profile guard so
  it doesn't ship to prod. Strictly more work for no win over cookie
  surgery. Rejected.

### Decision 3: Network capture via `page.on('response', ...)`, structured per test

Both new tests reuse the same network-capture pattern that
`auth.refresh.spec.ts` and `auth.logout-revocation.spec.ts` established —
attach `page.on('response', ...)` early, push into a typed `captured: {method, url, status}[]` array,
then assert on filtered subsequences. No new helper is introduced; each
spec captures only the routes it cares about.

For the single-flight test, the captured set is `DELETE /api/v1/posts/*`
and `POST /api/v1/auth/refresh`. The assertion is `refreshSeq.length === 1`,
`deletes401.length === 2`, `deletesOk.length === 2`, ordered such that the
single refresh sits between the two 401s and the two retries.

For the refresh-401 test, the captured set is `POST /api/v1/posts`,
`POST /api/v1/auth/refresh`, and any navigation to `/login`. The assertion
is `postsSeq[0].status === 401`, `refreshSeq.length === 1`,
`refreshSeq[0].status === 401`, plus `expect(page).toHaveURL(/\/login$/)`.

### Decision 4: Seed the two posts via `apiClient`, not via the SPA composer

The single-flight test seeds via `apiClient.createPost(...)` for the same
reason every other "needs N posts" e2e spec does today
(`posts.pagination.spec.ts`, `posts.pagination.deep.spec.ts`,
`posts.cross-user.pagination.spec.ts`): the subject under test is not the
composer, and going through the UI would add ~1s per seed plus dependency
on composer state.

The user's `accessToken` for the API seed comes from `loginViaApi`, the
helper that `signupViaApi` is paired with in the existing helper layer.
After seeding, the test drives the SPA login flow normally so the
in-browser `AuthContext` holds its own access token; the two state
machines (API-side bearer for seeding, SPA-side bearer for the test) do
not need to be the same value.

### Decision 5: Per-test TTL lapse buffer matches existing pattern

Both tests use `await page.waitForTimeout(TTL_MS + 1000)` immediately after
the SPA reaches a known-good state, matching the existing
`auth.refresh.spec.ts` pattern. The 1000ms margin absorbs WebKit timer
skew and is the same value that test uses. The required adjacent comment
naming `app.auth.access-token-ttl = PT2S` is repeated per spec (the `e2e`
capability requires the comment per call, not per file).

## Risks / Trade-offs

- **[Risk] Parallel `Promise.all` clicks may not fire close enough together
  to land both 401s in the interceptor before the first refresh resolves.**
  → Mitigation: the access-token check runs against the bearer at request
  time; both clicks invoke their mutations synchronously, both `apiFetch`
  calls start within microseconds, and both HTTP DELETE requests hit the
  network before either response returns. The backend's 401 path is
  comparatively slow (DB lookup + ProblemDetail serialization). The race
  window is wide enough that both `apiFetch` calls reach their
  `response.status === 401` branch and both call `refreshOnce()` before
  the first refresh HTTP call completes. If observed flake appears across
  browsers, fall back to a probe-and-retry shape: assert at most one
  refresh on a successful run, soft-skip with a clear diagnostic if both
  401s did not fire concurrently (captured as a tasks.md follow-up, not
  pre-emptively).

- **[Risk] WebKit handling of `HttpOnly` + `Path=/api/v1/auth/refresh` +
  `Secure=false` cookies set via `page.context().addCookies` may diverge
  from Chromium/Firefox.** → Mitigation: the harness already runs with
  `APP_AUTH_REFRESH_COOKIE_SECURE=false` (set by PR #15) so plain-HTTP
  cookies work uniformly across all three browsers. The
  `page.context().addCookies` API is documented to accept the same shape
  for all browsers; the test will explicitly pass every attribute observed
  on the live `refresh_token` cookie (read via
  `page.context().cookies({ urls: [`${backendURL}/api/v1/auth/refresh`] })`
  before overwriting) to avoid implicit-default divergence.

- **[Risk] The single-flight test's 2-post seed may be visible in other
  spec snapshots if the underlying DB row TTL or fixture cleanup changes.**
  → Mitigation: tests already use UUID-based unique email per the
  `e2e` capability requirement. Posts are tied to users; another spec's
  user cannot see this test's posts. The harness boots a fresh Postgres
  container per run, so cross-run leakage is impossible.

- **[Trade-off] Cookie surgery is a Playwright-layer concern rather than a
  through-the-app behavior.** The test verifies the SPA's observable
  reaction to a backend `401` on `/refresh`; it does NOT verify *how* the
  backend arrives at that `401` (server-side revocation vs. unknown cookie).
  That's acceptable because the backend's "row present AND not revoked AND
  not expired" predicate is already pinned by the `Refresh endpoint
  rotates …` requirement and `*IT.java`-tested. The e2e proof here is
  scoped to the SPA-side reaction wire.

- **[Risk] If a future change adds a refresh-aware retry layer to TanStack
  Query (e.g. retrying mutations on 401 outside the Axios mutator), the
  single-flight assertion could see >1 refresh.** → Mitigation: the
  `QueryProvider` config (`retry: false`) is pinned by code in
  `frontend/src/api/query-provider.tsx`; any future change to that
  config would correctly be caught by the spec-level test. Single-flight
  via `inflightRefresh` is the contract under test.
