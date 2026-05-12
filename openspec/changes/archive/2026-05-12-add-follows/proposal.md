## Why

The platform has every primitive for "me + my own posts" but nothing
that connects users to each other. The `project-context` spec names
**follows** and **feed** as upcoming capabilities, and the
`add-user-profile` change explicitly cited follows as one of the two
structural blockers it was unblocking — the profile route is a place to
put a Follow button, and a multi-author timeline (feed, next change)
needs the follows graph to compute its membership.

Today the only way one user discovers another is by navigating to a
hard-coded `/users/:userId` URL. There is no notion of a *relationship*
between two users: no follow table, no follow endpoint, no follower
counts, no "you follow this person" indicator on the profile page. As a
result `/home` is a single-author feed (the caller's own posts), and
nothing about the product reads as social.

This change introduces the social graph as a directed,
public, insta-follow relationship (Twitter-shape, not Instagram-shape).
It adds a `follows` table, the three endpoints needed to mutate and
read the (viewer, target) relationship, and a Follow / Following button
plus follower / following counts on the existing `ProfilePage`. The
feed read against this graph lands in the follow-up `add-home-feed`
change so this vertical stays a coherent, independently-demoable slice
(visit Alice's profile → click Follow → counts update → unfollow →
counts revert) without dragging timeline aggregation into the same PR.

## What Changes

- **Backend — Flyway migration `V4__create_follows.sql`** creating a
  `follows` table keyed on the composite primary key
  `(follower_id, followee_id)`, both `UUID NOT NULL REFERENCES
  users(id) ON DELETE CASCADE`, plus a `created_at TIMESTAMPTZ NOT NULL
  DEFAULT now()` column, a `CHECK (follower_id <> followee_id)`
  constraint to prevent self-follow at the DB layer, and a reverse
  index on `(followee_id, follower_id)` to support the
  "who-follows-this-user" read pattern.
- **Backend — `POST /api/v1/users/{userId}/follow`** that inserts a
  `(caller, userId)` row in `follows` and returns `204 No Content`. The
  endpoint SHALL be idempotent: a `POST` from a caller who already
  follows `userId` SHALL also return `204` without raising a unique-
  constraint error. A `POST` whose `userId` equals the caller SHALL be
  rejected with `400 ProblemDetail` before reaching the DB (the DB
  `CHECK` is a defence-in-depth backstop). Unknown `userId` returns
  `404 ProblemDetail`. Unauthenticated callers receive `401
  ProblemDetail`.
- **Backend — `DELETE /api/v1/users/{userId}/follow`** that removes the
  `(caller, userId)` row from `follows` and returns `204 No Content`.
  The endpoint SHALL be idempotent: a `DELETE` from a caller who does
  not currently follow `userId` SHALL also return `204`. Unknown
  `userId` returns `404 ProblemDetail`. Unauthenticated callers receive
  `401 ProblemDetail`. A `DELETE` whose `userId` equals the caller is
  treated as the unfollow-nobody case (no follow row could exist by
  construction): returns `204`, no error.
- **Backend — `GET /api/v1/users/{userId}/follow-stats`** returning
  `{ followers: int, following: int, viewerFollows: boolean }`:
  - `followers` is the count of rows in `follows` where `followee_id =
    userId`,
  - `following` is the count of rows in `follows` where `follower_id =
    userId`,
  - `viewerFollows` is `true` iff a row exists in `follows` where
    `(follower_id, followee_id) = (caller, userId)`. For the caller's
    own profile (`userId == caller`), `viewerFollows` SHALL be `false`
    (you cannot follow yourself; the SPA hides the button for own
    profiles anyway).
  - Unknown `userId` returns `404 ProblemDetail`. Unauthenticated
    callers receive `401 ProblemDetail`. The endpoint is auth-required
    under the existing deny-by-default chain (no allowlist entry).
- **Backend — Testcontainers `*IT.java`** covering: follow happy path
  (204 + row inserted), follow idempotent on duplicate (204 + still one
  row), follow self (400 + no row), follow unknown id (404), follow
  unauthenticated (401), unfollow happy path (204 + row removed),
  unfollow when not following (204 + no error), unfollow unknown id
  (404), unfollow unauthenticated (401), stats happy path with
  `viewerFollows: true` and `false` cases, stats for an unknown id
  (404), stats for the caller's own id (returns
  `viewerFollows: false`), stats unauthenticated (401).
- **API contract — refresh `openapi/openapi.json`** to include the
  three new endpoints and the `FollowStatsResponse` schema. Orval
  regenerates the frontend and e2e client surfaces. The existing CI
  drift check enforces the snapshot freshness.
- **Frontend — extend `frontend/src/features/profile/ProfilePage.tsx`**
  to fire the Orval-generated `useGetFollowStats({ userId })` query in
  parallel with the existing `useGetUser` and the `PostList`. The page
  SHALL render:
  - the existing display-name heading (unchanged),
  - directly under the heading, plain-text counts
    "**N** followers · **M** following" (computed from the stats
    response — no clickable list link in this change),
  - when `userId !== currentUser.id`, a **Follow** / **Following**
    toggle button whose label reflects `viewerFollows`. The button
    SHALL invoke the generated follow / unfollow mutation hooks; on
    success it SHALL invalidate the `follow-stats` query so the counts
    and label update,
  - when `userId === currentUser.id`, no toggle button is rendered
    (you cannot follow yourself),
  - while the stats query is loading, render a skeleton / placeholder
    for the counts and the button so the layout doesn't jump.
- **Frontend — Vitest** for `ProfilePage` adding cases: stats render
  with `viewerFollows: false` shows a **Follow** button; stats render
  with `viewerFollows: true` shows an **Unfollow** button (or matching
  toggle label) and the counts; clicking **Follow** invokes the
  generated mutation and refetches the stats; clicking **Unfollow**
  invokes the generated mutation and refetches the stats; viewing
  one's own profile (`userId === currentUser.id`) hides the button and
  still renders counts.
- **E2E — `apiClient.follow(token, userId)`,
  `apiClient.unfollow(token, userId)`, and
  `apiClient.getFollowStats(token, userId)` helpers** in
  `e2e/src/helpers/apiClient.ts`, each using the Orval-generated URL
  helpers (`getFollowUserUrl`, `getUnfollowUserUrl`,
  `getGetFollowStatsUrl` — exact names depend on Orval's tag-to-
  function mapping). All three return the existing `{ status, body }`
  shape consistent with the other helpers.
- **E2E — `e2e/tests/follows.spec.ts`** exercising the full vertical
  end-to-end against the real backend and frontend:
  - Alice and Bob signed up via `apiClient`; Bob obtains a bearer
    token via `apiClient.login(...)`;
  - Bob logs into the SPA, navigates directly to `/users/{aliceId}`;
  - asserts the page shows Alice's heading, `0 followers · 0
    following`, and a **Follow** button;
  - clicks **Follow**;
  - asserts the page now shows `1 follower · 0 following` and an
    **Unfollow** button (or matching toggle label);
  - additionally asserts via `apiClient.getFollowStats(aliceToken,
    bobId)` that the graph reflects `following: 1` from Bob's side;
  - clicks **Unfollow**;
  - asserts the page reverts to `0 followers · 0 following` and a
    **Follow** button.
- **E2E — API-level edge spec** (one `test()` in the same file or a
  sibling) covering the corner cases that don't surface in the UI:
  self-follow via `apiClient` returns `400`; follow-then-follow-again
  via `apiClient` returns `204` both times and the followers count
  stays at `1`; unfollow when not following via `apiClient` returns
  `204` and the followers count stays at `0`; follow / unfollow /
  stats on an unknown id returns `404`; all three endpoints return
  `401` when called without a bearer token.
- **E2E — axe scan extension** of `/users/:userId` (already covered by
  `axe.routes.spec.ts`) to include a seeded follow relationship so the
  scan exercises the rendered counts and the **Follow** / **Unfollow**
  button affordance. One additional `runAxeScan` call after the follow
  action lands, asserting no violations.

### Explicit non-goals (deferred to follow-ups)

- **Feed read against the graph.** No `GET /api/v1/feed` endpoint, no
  `/home` rewire, no `FeedList` component. The next change
  (`add-home-feed`) consumes this graph; this change ships only the
  graph and its profile affordance.
- **Follower / following list pages.** Clicking the counts is a no-op
  in this change. No `GET /api/v1/users/{userId}/followers` or
  `/following` paginated endpoints, no `/users/:userId/followers` SPA
  route. Counts render as plain text. Adding clickable list pages is
  spec'd in a separate follow-up once the basics are stable. (The
  graph is already verifiable end-to-end via `follow-stats` and the
  e2e helpers, so deferring the list endpoints is a true scope
  reduction, not a verification gap.)
- **Notifications when someone follows you.** Out of scope; no
  notifications surface exists yet anywhere in the platform.
- **Private accounts / follow approval flow.** All accounts are public
  and insta-follow (consistent with the existing "any authenticated
  caller can read any user's posts" rule from the `posts` spec).
- **Mutual-follow detection / friend semantics.** No `mutual: boolean`
  field, no "your friends" surface. The graph is a directed `follows`
  edge only.
- **Denormalised follower / following counters on `users`.** Counts
  are computed via `SELECT count(*) FROM follows WHERE ...` per
  request. The fanout-on-write design is documented as a future
  trapdoor in `design.md`; it is not earned by this change's scale.
- **Block / mute / report.** Not in scope. Future capability.
- **Embedding follow stats inside `GET /api/v1/users/{userId}`.** The
  existing `UserSummary { id, displayName }` shape is reused
  unchanged everywhere it appears (notably as the `author` field of
  `PostResponse`). Follow stats live in their own endpoint so the
  `PostResponse.author` summary stays lean.
- **`account-deletion`-triggered cleanup paths.** The
  `ON DELETE CASCADE` on both follow FKs is the right policy for the
  day account deletion ships, but no deletion flow is built in this
  change.

## Capabilities

### New Capabilities

- `follows` — the social-graph capability: the `follows` table, the
  three endpoints (`POST` / `DELETE` follow, `GET` follow-stats), the
  IT coverage, the SPA Follow / Unfollow affordance and counts on the
  profile page, the Vitest coverage, the Playwright vertical spec,
  and the axe coverage of the updated profile route.

### Modified Capabilities

- `user-profile` — adds a requirement that `ProfilePage` renders
  follower / following counts and a Follow / Unfollow toggle (hidden
  on own profile). Existing requirements (heading, `PostList`, no
  composer, 404 affordance, route under `ProtectedRoute`) are not
  modified.

### Unmodified Capabilities (cited for clarity)

- `user-accounts` — no schema or endpoint changes. The `users` table
  is unchanged. `GET /api/v1/users/{userId}` continues to return the
  same `UserSummary { id, displayName }` and never leaks `email` /
  `password` / `createdAt`.
- `posts` — no changes. `PostResponse` continues to embed the same
  `{id, displayName}` author shape. The composer, list, delete, and
  pagination contracts are not touched.

## Impact

- **Backend:**
  - New: `backend/src/main/resources/db/migration/V4__create_follows.sql`.
  - New: `backend/src/main/java/com/prodready/social/follows/Follow.java`
    JPA entity. The entity SHALL hold `followerId` and `followeeId` as
    `UUID` fields, NOT as `@ManyToOne User` relationships — matching
    the `Post` entity's "cross-aggregate reference is by UUID, not JPA
    relationship" pattern from the `posts` spec. The primary key is a
    composite `@EmbeddedId` (or `@IdClass`) of
    `(followerId, followeeId)`.
  - New: `backend/src/main/java/com/prodready/social/follows/FollowRepository.java`
    Spring Data interface with finders for `existsById(...)`,
    `countByFolloweeId(...)`, `countByFollowerId(...)`,
    `deleteById(...)`.
  - New: `backend/src/main/java/com/prodready/social/follows/FollowService.java`
    holding the follow / unfollow / stats logic (the controller stays
    thin, mirroring `PostsController` / `PostService`).
  - New: `backend/src/main/java/com/prodready/social/follows/FollowsController.java`
    annotated `@RestController @RequestMapping("/api/v1/users")` with
    `@PostMapping("/{userId}/follow")`,
    `@DeleteMapping("/{userId}/follow")`, and
    `@GetMapping("/{userId}/follow-stats")`. Sits in a new
    `follows/` package because the capability is its own bounded
    context (it depends on `useraccounts` for `User` /
    `UserRepository` and on nothing else).
  - New: `backend/src/main/java/com/prodready/social/follows/FollowStatsResponse.java`
    record `(long followers, long following, boolean viewerFollows)`.
  - New: `backend/src/test/java/com/prodready/social/follows/FollowsControllerIT.java`
    extending the existing Testcontainers integration-test pattern.
- **Frontend:**
  - Modified: `frontend/src/features/profile/ProfilePage.tsx` — adds
    the `useGetFollowStats` query, the counts render, and the Follow
    / Unfollow toggle (conditional on `userId !== currentUser.id`).
  - Modified: `frontend/src/features/profile/ProfilePage.test.tsx` —
    adds the four cases enumerated under "Frontend — Vitest" above.
  - No `PostList` / `PostCard` / `HomePage` / `App.tsx` / `AuthContext`
    changes. The follow surface is fully scoped to the profile page.
- **API contract / codegen:**
  - `openapi/openapi.json` regenerated to include the three new paths
    under `/api/v1/users/{userId}/follow` (POST + DELETE) and
    `/api/v1/users/{userId}/follow-stats` (GET), and the
    `FollowStatsResponse` schema.
  - Orval regenerates `frontend/src/api/generated/follows-controller/`
    (or whichever tag Orval picks for the new controller) and the
    matching `e2e/src/api/generated/...`.
- **E2E:**
  - New: `e2e/tests/follows.spec.ts` (the UI vertical scenario plus
    the API-level edge cases in the same file or a sibling, per spec
    drafting taste).
  - Modified: `e2e/src/helpers/apiClient.ts` adds `follow`,
    `unfollow`, and `getFollowStats` methods.
  - Modified: `e2e/tests/axe.routes.spec.ts` (or the spec that owns
    the `/users/:userId` scan) extended to seed a follow relationship
    before the scan so the counts and toggle button are exercised.
- **OpenSpec specs:**
  - New: `openspec/specs/follows/spec.md` (the new capability's spec,
    written during the openspec workflow's artifact step).
  - Modified: `openspec/specs/user-profile/spec.md` gains one
    requirement that `ProfilePage` renders follower / following counts
    and a Follow / Unfollow toggle (hidden on own profile).
- **CI:** No new jobs. The existing OpenAPI drift check, backend IT
  job, Vitest job, and Playwright job pick up the new files
  automatically.
- **Database:** One new migration (`V4`). One new table (`follows`).
  No changes to existing tables.
- **Dependencies:** None added.
