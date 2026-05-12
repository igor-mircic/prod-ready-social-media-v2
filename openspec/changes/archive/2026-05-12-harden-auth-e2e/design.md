## Context

The recent posts-e2e hardening PRs (#10–#14) drained the named gaps in the `posts`
capability. The next-richest coverage gap is `user-accounts`, where four small
items remain. The load-bearing item is the refresh-on-401 proof: spec already
requires "Axios response interceptor transparently refreshes on 401" but the only
proof against this wire is a Vitest test against an MSW handler. The other three
items are cheap — server-side logout revocation, an unauth `/home` bounce, an
explicit axe scan on `/not-found`. Bundling matches the work shape: closing gaps,
not introducing new ideas.

Current e2e harness state (verified against the tree, not guessed):

- `e2e/playwright.config.ts` runs `workers: 1, fullyParallel: false` and uses a
  global setup that boots Postgres (testcontainers) + the backend JAR + Vite
  preview *once* per run.
- `e2e/src/setup/backend.ts` already passes per-environment overrides to the
  backend via env vars on `spawn` — concretely `APP_AUTH_REFRESH_COOKIE_SECURE`.
  The short-TTL knob lands in the same env block.
- `e2e/src/helpers/login.ts` already exposes `loginViaApi(client, input)`
  returning `{ accessToken, userId }`. The logout-revocation test can lift the
  token from there without any new helper.
- Three existing tests already call `page.waitForTimeout` as a buffer for
  absence-of-network assertions (`posts.spec.ts:51`,
  `posts.composer.hardening.spec.ts:68`, `auth.errors.spec.ts:56`). The current
  `e2e` spec's `Tests do not use waitForTimeout` requirement literally forbids
  them. The de-facto practice and the literal spec are out of sync; this change
  codifies the practice rather than ignoring it.

## Goals / Non-Goals

**Goals:**

- Prove the SPA's refresh-on-401 wire against the real backend end-to-end, in a
  way that lapses the access token without taking minutes per test invocation.
- Prove that the access token issued before logout is rejected by the backend
  after logout (server-side revocation).
- Mirror the existing `auth.routing` redirect pattern for the unauth → `/home`
  → `/login` direction.
- Add an explicit axe scan on the `/not-found` route, both authenticated and
  unauthenticated, alongside the existing explicit scans on `/login`, `/signup`,
  `/home`.
- Codify the existing waitForTimeout pattern in the `e2e` spec so the
  refresh-on-401 spec is compliant with the spec it lives under.

**Non-Goals:**

- Any change to the refresh-rotation flow, cookie attributes, or `replaced_by`
  chain. That contract is already pinned by `*IT.java`. No backend code moves.
- A test-only "force-expire-my-token" endpoint. The existing
  `app.auth.access-token-ttl` env knob is sufficient and adds zero new backend
  surface.
- Per-Playwright-project TTL variation (e.g., one project at `PT2S`, another at
  `PT15M`). The harness boots one backend per run; we accept a single global TTL
  for the whole suite.
- Cross-tab logout, new axe rules, frontend behavior changes, or new posts
  coverage.

## Decisions

### Decision 1: Short access-token TTL via existing env knob, single value harness-wide

Set `APP_AUTH_ACCESS_TOKEN_TTL=PT2S` on the env block in
`e2e/src/setup/backend.ts`, immediately adjacent to the existing
`APP_AUTH_REFRESH_COOKIE_SECURE=false` override. Spring binds the env var to
`app.auth.access-token-ttl` via standard relaxed binding.

**Why `PT2S`?** Short enough that the refresh spec can lapse the token with a
single `~2.5s` wait. Long enough that *most* existing tests, which run a few
clicks-and-assertions inside ~1s, finish before the token expires and never
exercise the refresh path. Tests that *do* exceed 2s of UI work will exercise the
interceptor transparently — that is *acceptable* and arguably good (it
broad-tests the refresh wire alongside the explicit proof).

**Alternatives considered:**

- `PT5S` or `PT10S`: safer against incidental flake on slow CI runners but
  inflates the refresh test's deliberate wait by the same amount. The refresh
  test ends up dominating the suite's wall-clock if TTL is much longer. Start at
  `PT2S`; bump to `PT5S` if observed flake. Captured in tasks as a tuning knob,
  not a hard value.
- Per-project TTL (different Playwright projects with different envs): requires
  rebooting the backend per project, which doubles or triples globalSetup cost.
  The harness is single-backend-per-run by design. Rejected.
- Test-only "force-expire" backend endpoint behind a profile: cleanest semantics
  per-test (no shared TTL pressure), but adds a new backend surface that needs
  IT coverage and a profile guard to keep it off prod. Strictly more work for
  no win over the env knob.

### Decision 2: Refresh-on-401 spec drives the SPA through an authenticated action *after* the lapse

The Playwright test:

1. Signs up via `apiClient`.
2. Logs in via the SPA (`loginAndLandOnHome`) so the SPA's `AuthContext` holds
   the access token. The refresh cookie is HTTP-only on the browser side; we
   never read it directly.
3. Lapses the access token via `page.waitForTimeout(TTL_MS + 500)`. The buffer
   covers timer skew between Node and the JVM clock and Spring's `expires_at >
   now()` predicate.
4. Triggers an authenticated SPA action that re-hits a protected endpoint —
   composing a post via the existing composer (`POST /api/v1/posts`).
5. Asserts via `page.on('response', ...)` that the network sequence contains:
   - one `401` response on the protected endpoint,
   - followed by exactly one `200` on `POST /api/v1/auth/refresh`,
   - followed by a successful retry of the originally-failing request.
6. Asserts the SPA stays on `/home` and the new `PostCard` renders.

**Why compose-a-post for the trigger?** It's the cheapest protected SPA action
that produces a visible UI outcome to assert against. Alternatives (poll `/me`,
delete a post) either don't surface in the UI or require a seeded post — more
plumbing for no clearer proof.

**Why assert on the network sequence and the UI?** The UI alone could pass even
if the refresh path were silently bypassed (e.g. if the SPA started caching
something it shouldn't). The network sequence pins the wire; the UI pins user
outcome.

### Decision 3: Logout-revocation spec lifts the token via `loginViaApi`, not by sniffing axios

`loginViaApi(client, input)` already returns the access token. Pattern:

1. `signupViaApi` + `loginViaApi(input)` to capture `aliceToken`.
2. Drive the SPA login + logout (the SPA login mints its own token internally —
   we ignore it; what we want to revoke is `aliceToken`).
3. After SPA logout completes, replay `apiClient.listPostsByAuthor(aliceToken,
   aliceId)` and assert status `401`.

Wait — that's not quite right. The SPA login uses its own session; logout
revokes only the SPA's tokens. If we want to prove revocation of *the SPA's*
access token, we need to capture *that* token. Options:

- **(a)** Capture the SPA's access token via `page.on('response', ...)` filtered
  to `POST /api/v1/auth/login`, parse the JSON body, retain `accessToken`.
- **(b)** Drive everything via `apiClient`: capture the token via `loginViaApi`,
  then call `apiClient.logout(token)` to revoke, then replay. This skips the
  SPA entirely but proves the *backend* logout contract — which is what
  "Logout revokes both the caller's access token and the refresh cookie's
  token" really pins.

**Decision: (a).** The spec explicitly says "Logout revokes both the caller's
access token AND the refresh cookie's token" — driving via `apiClient` only
proves access-token revocation, not the SPA's logout. We want the SPA wire end
to end. Capture the SPA's token via a response listener, drive SPA logout, then
replay.

### Decision 4: Unauth `/home` bounce — extend `auth.routing.spec.ts`, not a new file

`auth.routing.spec.ts` houses the two existing redirect cases (authed → `/login`
→ `/home`, authed → `/signup` → `/home`). The unauth → `/home` → `/login`
mirror belongs next to them. One short `test()` appended.

### Decision 5: Axe on `/not-found` — extend `axe.routes.spec.ts`, not a new file

`axe.routes.spec.ts` already runs explicit scans on three routes in one test.
Add a second test for `/not-found` in the same file: one unauth scan, one
authenticated scan, mirroring the two `not-found.spec.ts` cases. Keeps the
"explicit axe scan inventory" in one file.

### Decision 6: Codify `waitForTimeout` exceptions in the `e2e` spec

MODIFY `Tests do not use waitForTimeout` to permit two patterns:

1. **Absence-assertion buffer** (≤500ms): when asserting that no request /
   network event fired in response to an action, a short buffer after the
   action gives any belated event time to materialize. Pattern already used by
   three tests.
2. **Configured-TTL lapse**: when the harness deliberately configures a short
   wall-clock-based behavior under test (e.g. `app.auth.access-token-ttl =
   PT2S`), the test may wait for the configured duration plus a small margin.

All other fixed-duration sleeps remain forbidden. The MODIFIED scenario clause
tightens, not loosens — instead of "no calls to `page.waitForTimeout(...)`", it
becomes "no calls to `page.waitForTimeout(...)` except inside an
absence-assertion buffer (≤500ms) or a configured-TTL lapse documented by a
comment referencing the configured duration".

**Alternative considered**: introduce a typed helper like `waitForTtlLapse(ms,
reason)` so usages are searchable and self-documenting. Possibly worthwhile;
deferred as a separate cleanup change so this PR stays scoped to *enabling*
the test, not abstracting helpers.

## Risks / Trade-offs

- **`PT2S` TTL pressures suite latency.** Each test's authenticated SPA flow now
  has a 2-second budget before the refresh path kicks in. Most existing tests
  finish well under that. **Mitigation**: TTL is a single env var; bumping to
  `PT5S` is one line if flake materializes. Tracked in tasks as a tuning step.
- **Global TTL means the refresh path is implicitly exercised across the suite.**
  If the refresh wire breaks, *many* unrelated tests fail in addition to the
  refresh spec. **Mitigation**: the dedicated refresh spec is the canonical
  proof; failures elsewhere just amplify the signal.
- **SPA-token capture in the logout-revocation spec relies on the SPA's login
  response shape staying `{ accessToken, expiresIn }`.** That's pinned by the
  user-accounts spec and the OpenAPI snapshot, so this is low-risk.
- **`page.waitForTimeout` rule modification widens what's allowed.** Without
  this change, the refresh spec cannot be written within the existing rule.
  **Mitigation**: the MODIFIED scenario constrains the two new exceptions to a
  comment-required pattern; arbitrary sleeps remain forbidden.
- **WebKit timing.** WebKit historically lags Chrome on identical waits; a
  `PT2S` TTL + `2.5s` wait may bleed close to flake on WebKit under load.
  **Mitigation**: budget the wait at `TTL_MS + 1000ms` (not 500ms) for the
  refresh spec specifically; the wider margin costs nothing and absorbs WebKit
  jitter.
- **Logout-revocation spec depends on backend not eagerly garbage-collecting
  revoked rows.** If a future migration deletes revoked rows on logout (vs.
  setting `revoked_at`), a replayed lookup would still 401, but the assertion
  semantics would shift from "revoked" to "not found". Both surface as 401, so
  the spec stays valid; flagged as future-proofing risk only.
