## Context

Code state verified against the tree at change-draft time:

- `backend/src/main/resources/db/migration/` contains exactly
  `V1__create_users.sql`, `V2__create_auth_tokens.sql`, and
  `V3__create_posts.sql`. The next migration number is `V4`.
- `backend/src/main/java/com/prodready/social/posts/Post.java` is the
  canonical example of the project's "cross-aggregate reference by
  UUID" rule: the entity holds `authorId` as a plain
  `@Column(name = "author_id") private UUID authorId;`, with no
  `@ManyToOne User author`. The `posts` capability spec pins this
  rule explicitly ("Cross-aggregate reference is by UUID, not JPA
  relationship").
- `backend/src/main/java/com/prodready/social/posts/PostsController.java`
  is the convention this change follows. It is
  `@RestController @RequestMapping("/api/v1") @SecurityRequirement(name = "bearerAuth")`,
  with method-level `@PostMapping("/posts")`,
  `@GetMapping("/users/{userId}/posts")`, etc. Each method carries full
  `@Operation` + `@ApiResponses` annotations so the OpenAPI snapshot
  has rich schemas to emit. A private `requirePrincipal(principal)`
  helper throws `InsufficientAuthenticationException` when
  `@AuthenticationPrincipal` is null.
- `backend/src/main/java/com/prodready/social/posts/PostService.java`
  carries the per-capability domain logic; the controller stays thin.
  This is the layering this change mirrors for `FollowService` /
  `FollowsController`.
- `backend/src/main/java/com/prodready/social/useraccounts/`
  exposes `User`, `UserRepository`, `UserPrincipal`, and
  `UsersController` (`GET /api/v1/users/{userId}` returning
  `UserSummary { id, displayName }`). The new `follows` package
  depends on `useraccounts` for user existence checks and on nothing
  else.
- `frontend/src/features/profile/ProfilePage.tsx` exists, renders a
  centered card with the user's `displayName` heading from
  `useGetUser(safeUserId)`, and embeds `<PostList userId={safeUserId} />`.
  It handles the 404 case (renders "User not found") and the generic
  error case (renders "Profile unavailable"). It does not currently
  read the auth context — extending it to render the conditional
  Follow button is the only structural change this slice needs.
- `e2e/src/helpers/apiClient.ts` exposes `signup`, `login`,
  `listPostsByAuthor`, `createPost`, `deletePost`, `getUser`, each
  using the Orval-generated URL helper (e.g. `getGetUserUrl(userId)`),
  each returning `{ status, body }` where `body` is the typed success
  response or `ProblemDetail`. The pattern for the three new follow
  helpers is mechanical.
- The committed `openapi/openapi.json` snapshot has CI drift checking
  in place — regenerating it after adding the new controller is part
  of the change, not optional.

## Goals / Non-Goals

**Goals:**

- Introduce the social graph as a directed, public, insta-follow
  relationship: a `follows` table, three endpoints
  (POST follow, DELETE follow, GET follow-stats), and the SPA
  affordance on `/users/:userId`.
- Reuse the existing user-profile surface — extend `ProfilePage`, do
  not add a new route, do not touch `PostList` / `PostCard` / `HomePage`.
- Pack `viewerFollows` into the same response as the counts so the
  SPA renders the Follow / Unfollow toggle in one round-trip, with no
  inconsistent state where the button label disagrees with the counts.
- Make both mutations idempotent (POST follow returns 204 whether the
  row was inserted or already present; DELETE follow returns 204
  whether the row was removed or absent) so clients don't have to
  reconcile "did my action succeed or was it a no-op?"
- Keep the change e2e-verifiable end-to-end via the API and the UI
  *without* shipping follower / following list pages.

**Non-Goals:**

- The feed query against this graph. That's `add-home-feed`.
- Paginated follower / following list endpoints. Deferred. The graph
  is fully verifiable through `follow-stats` alone for this scope.
- Notifications. No notifications surface exists yet.
- Private / approval-required follows. All accounts insta-follow.
- Mutual / friend semantics. Pure directed edge.
- Block, mute, report. Future capability.
- Denormalised counter columns on `users`. Computed on read.
- Account-deletion-triggered cleanup. The `ON DELETE CASCADE` on the
  `follows` FKs is the forward-compatible policy; deletion itself is
  not built.

## Decisions

### Decision 1: Composite primary key `(follower_id, followee_id)` — first composite PK in the codebase

The `follows` table SHALL use `PRIMARY KEY (follower_id, followee_id)`
as a composite primary key. There is no surrogate `id UUID` column.

**Why composite, when the existing `posts` table uses a surrogate `id`?**
The two tables have different shapes:

- A `Post` row has a domain identity (the post itself) that is distinct
  from the author who wrote it. Referring to "this post" externally
  (in the URL `/api/v1/posts/{id}`, in cursor codecs, in soft-delete
  semantics) needs a stable opaque id. The surrogate UUID earns its
  column.
- A `follows` row IS the relationship between two users. There is no
  third party to refer to it by — no `/api/v1/follows/{id}` URL, no
  `follows.deleted_at`, no embedded foreign key from any other table.
  The `(follower_id, followee_id)` tuple is the natural key, the
  external identity, AND the row's identity in a single cell. A
  surrogate UUID would be dead weight: never used, never referenced.

**Why is the boilerplate cost acceptable?** JPA composite keys take
either `@IdClass(FollowId.class)` or `@EmbeddedId FollowId id` plus a
small `FollowId` record. That's ~15 lines and zero ongoing maintenance.
Spring Data's `existsById(...)`, `deleteById(...)` work seamlessly on
composite keys.

**Why is this the right precedent to set?** A relationship table is
the *one* JPA shape where composite PKs unambiguously win. Picking a
surrogate just to match `Post` would invent a column the codebase
never reads. The next time a relationship-style table appears (likes,
post-bookmarks, mentions), the precedent is set and consistent.

### Decision 2: `CHECK (follower_id <> followee_id)` constraint at the DB layer

The migration SHALL include a `CHECK (follower_id <> followee_id)`
constraint on `follows`. The service layer SHALL ALSO reject
self-follow at the controller / service layer with a `400
ProblemDetail` before the insert is attempted.

**Why both layers?** The application-layer check produces the typed
`400` response with a meaningful `detail` ("You cannot follow
yourself"). The DB-layer check is defence-in-depth: if a future code
path (a future bulk-import, a future admin-side script) bypasses
`FollowService`, the constraint prevents data corruption.

**Why not rely on the DB check alone?** The DB-raised exception
surfaces as a generic `DataIntegrityViolationException`, which would
need translation to `400` in the global exception handler. Doing the
check at the service layer with a clean throw is simpler and produces
a better error body.

### Decision 3: Both mutations are idempotent and return `204`

- `POST /api/v1/users/{userId}/follow`: 204 whether the follow row
  was newly inserted OR already existed. The service SHALL use an
  insert path that swallows the duplicate-key case (either via
  `existsById(...)`-then-`save(...)` or via a SQL-level
  `INSERT ... ON CONFLICT DO NOTHING`).
- `DELETE /api/v1/users/{userId}/follow`: 204 whether the follow row
  was removed OR did not exist. The service SHALL use a delete that
  treats "0 rows affected" as success.

**Why idempotent rather than 409 / 404 on the "already-in-that-state"
case?** Three reasons:

1. **Client-side optimism.** The SPA flips the button label
   optimistically when the user clicks. With idempotent mutations, a
   double-click or a stale-state re-click is a no-op rather than an
   error to recover from.
2. **Network retries are safe by construction.** A client (or proxy)
   that retries a follow / unfollow after a flaky network never produces
   a wrong outcome.
3. **The information value of a 409 is near zero.** "You already
   follow this user" doesn't tell the client anything actionable; the
   next `follow-stats` fetch resolves the truth.

**Why 204 specifically (not 200 with a body)?** Mirrors the existing
`DELETE /api/v1/posts/{id}` which also returns 204. The next
`follow-stats` query gives the SPA the new state — there's no useful
payload to return from the mutation itself.

### Decision 4: Asymmetry between self-follow (`400`) and self-unfollow (`204`)

- `POST /users/{caller}/follow` (self-follow) SHALL return `400
  ProblemDetail`.
- `DELETE /users/{caller}/follow` (self-unfollow) SHALL return `204`.

**Why the asymmetry?** Self-follow is a malformed *intent* — the
caller is asking for state that the system cannot represent (the DB
check forbids it). 400 is the correct response.

Self-unfollow is a *no-op*: by construction, no row exists where
`(follower_id, followee_id) = (caller, caller)`, so the delete affects
zero rows — which is exactly the idempotent-delete case from Decision 3.
Returning 400 here would special-case the symmetry argument over the
idempotency contract. Idempotency wins because that's the contract
clients are programming against.

### Decision 5: `ON DELETE CASCADE` on both follow FKs

The `follows` table's `follower_id` and `followee_id` foreign keys to
`users(id)` SHALL declare `ON DELETE CASCADE`.

**Why CASCADE and not RESTRICT (as `posts` uses)?**
The two cases are structurally different:

- A `posts` row carries user-authored *content*. Cascading a user
  delete into post deletion silently shreds that user's content; the
  `posts` spec deliberately picks `RESTRICT` so account-deletion has
  to grapple with the content explicitly.
- A `follows` row is a *pure relationship*. It carries no content. It
  has no value once either endpoint user is gone. `CASCADE` is the
  natural reaping behavior.

**Why now, given account deletion isn't built?** Setting the FK policy
at table-creation time is free; changing it later requires a migration
to drop and recreate the constraints. The right policy goes in on day
one. Code that consumes `follows` rows can safely assume both users
referenced by any live row still exist.

### Decision 6: Counts are computed at read time; denormalisation is a future trapdoor

`GET /api/v1/users/{userId}/follow-stats` SHALL compute `followers`
and `following` as `SELECT count(*) FROM follows WHERE ...` at request
time. No denormalised `users.follower_count` / `users.following_count`
columns are added.

**Why computed?**

1. **Correctness.** A computed count cannot drift from the underlying
   relationship table; a denormalised counter requires every
   follow / unfollow write path to update both the row and the
   counter, atomically and correctly, forever.
2. **Scale is not earned.** At the platform's current scale (single
   Postgres, profile page is the only consumer, no high-fanout users),
   two `COUNT(*)` queries against indexed columns are cheap.
3. **No write-side cost.** Every denormalised counter is a write-
   amplification cost on the hot follow / unfollow path.

**The trapdoor.** Fanout-on-write (or denormalised counters) becomes
relevant the day a user accumulates ~100k+ followers and the profile
page render starts felt-slowly counting. The shape of that
optimisation is well-understood (a `users.follower_count` column
maintained by a database trigger or an application-layer hook on every
insert / delete to `follows`). It is deliberately not paid for in this
change.

### Decision 7: `viewerFollows` is packed into the same response as the counts

`GET /api/v1/users/{userId}/follow-stats` returns
`{ followers: long, following: long, viewerFollows: boolean }` in a
single body.

**Why pack `viewerFollows` rather than separate it?**
The SPA's Follow / Unfollow button needs both counts AND `viewerFollows`
to render correctly. Splitting them into two endpoints would mean two
network round-trips on every profile mount, and a transient render
window where the button label disagrees with the counts (e.g. counts
say `5 followers` but `viewerFollows` hasn't resolved yet, so the
button is in skeleton state next to filled-in counts).

**Why not put `viewerFollows` on `GET /api/v1/users/{userId}`
instead?** Because that endpoint returns the lean `UserSummary
{id, displayName}` shape that is *also* embedded inside every
`PostResponse` as the post's `author`. Adding a viewer-dependent
field to `UserSummary` would either (a) leak `viewerFollows` into
every embedded `PostResponse.author` (which is wrong — that's a
per-post-render cost), or (b) require two flavours of `UserSummary`.
Both are worse than a separate stats endpoint.

**Why `boolean` not `enum`?** Today the only relationships are
"follow" and "not follow" — `boolean` is sufficient. If future
capabilities introduce richer states (pending / blocked / muted), the
field upgrades cleanly to an enum or to a nested object; the existing
`true` / `false` migrates straightforwardly.

### Decision 8: `viewerFollows` is `false` when `userId == caller`

When the caller fetches their own follow-stats (`userId` equals the
authenticated principal's id), `viewerFollows` SHALL be `false`. The
endpoint does NOT special-case this with a separate field or status
code.

**Why?** You cannot follow yourself (Decision 2). The boolean is
literally "does the caller follow this user," which for
`(caller, caller)` is by construction `false`. The SPA hides the
Follow button on the own-profile case anyway (Decision 11), so this
field's value doesn't drive any rendered affordance — it's just the
honest answer to the question the field asks.

### Decision 9: Cross-aggregate reference by UUID — no JPA relationships on `Follow`

The `Follow` entity SHALL hold `followerId` and `followeeId` as plain
`UUID` fields. It SHALL NOT declare `@ManyToOne User follower`,
`@ManyToOne User followee`, or any analogous JPA association.

**Why?** This is the same rule the `posts` spec already pins for the
`Post` entity: "Cross-aggregate reference is by UUID, not JPA
relationship." The justification is identical — lazy-loading bugs,
N+1 surprises, transitive entity loads, and cross-aggregate
mutation paths are all avoided by keeping each aggregate's JPA graph
local.

`FollowService` SHALL fetch user existence checks (for the `404 on
unknown userId` cases) via `userRepository.existsById(...)`, not via
a `User` association on `Follow`.

### Decision 10: `ProfilePage` fires three independent queries with independent loading states

`ProfilePage` SHALL fire three queries in parallel:

- `useGetUser({ userId })` — the existing user fetch (drives the
  display-name heading and the 404 affordance).
- `useGetFollowStats({ userId })` — the new stats query (drives the
  counts and the Follow / Unfollow toggle).
- `useListPostsByAuthor({ userId })` — owned by the embedded
  `<PostList userId={userId} />`, unchanged.

Each query owns its own loading and error state. The page does NOT
chain them; rendering does NOT wait for all three.

**Why not chain?** None of the three queries depend on each other's
data — they all key on the same `userId` from the route. Chaining
would add serial round-trips for no benefit. The header, the counts,
and the post list each appear independently as their query resolves;
the SPA renders progressively rather than blocking on the slowest one.

**Empty / skeleton states.** The counts and the Follow button
SHALL render with skeleton placeholders while `useGetFollowStats` is
in flight, so the page layout doesn't jump when the stats arrive.

**Cache-key alignment.** The follow / unfollow mutations SHALL
invalidate the `useGetFollowStats({ userId })` query key on success so
the counts and the button label update without a full page refetch.

### Decision 11: Follow button hidden when `userId === currentUser.id`

When the route `userId` equals the authenticated user's id, the
`Follow` / `Unfollow` toggle SHALL NOT be rendered. The counts SHALL
still render.

**Why?** You cannot follow yourself. The DB and service layers reject
it; the UI does not need to offer the affordance.

**Why use the auth context for this check (instead of, say,
`viewerFollows`)?** Two reasons:

1. The own-profile case is structural, not state-dependent: it is
   never true that "the user might be able to follow themselves under
   some condition." A static check at render time is correct.
2. Reading from the auth context matches the existing convention —
   `PostCard` uses the same auth-context comparison (`author.id ===
   currentUser.id`) to decide whether to render Delete.

### Decision 12: Three new e2e `apiClient` helpers, mirroring the existing pattern exactly

`apiClient.follow(token, userId)`,
`apiClient.unfollow(token, userId)`, and
`apiClient.getFollowStats(token, userId)` SHALL each:

- import the Orval-generated URL helper (e.g.
  `getFollowUserUrl(userId)`) from
  `e2e/src/api/generated/follows-controller/follows-controller.ts`
  — NOT hardcode any path string;
- send `Authorization: Bearer <token>`;
- return `{ status, body }` where `body` is the typed success
  response or `ProblemDetail`, identical in shape to the existing
  `signup` / `login` / `getUser` / etc. helpers.

**Why not derive the URL string in the helper?** The existing pattern
("E2E ApiClient supports authenticated post creation" requirement in
the `posts` spec) explicitly bans hardcoded paths and pins the URL
helper as the source of truth. The follow helpers SHALL follow the
same rule for the same reason: snapshot changes that rename a path
break the URL helper and break the e2e build, which is the desired
fail-fast behavior.

### Decision 13: Defer paginated follower / following list endpoints

`GET /api/v1/users/{userId}/followers` and
`GET /api/v1/users/{userId}/following` are explicit non-goals for
this change.

**Why?** Cursor-paginated list endpoints are not trivial to spec
(they need a cursor codec, IT coverage for pagination edges,
OpenAPI snapshot churn, and Vitest / Playwright coverage of the
clickable counts → list page UX). Deferring them keeps this change a
clean three-endpoint slice.

**Why is deferring safe (i.e. not a coverage gap)?** The graph is
fully verifiable end-to-end through `follow-stats` and the apiClient
helpers:

- "Did Bob actually follow Alice?" → `follow-stats(Alice)` from any
  caller shows `followers: 1`, and from Bob shows `viewerFollows:
  true`.
- "Did Alice's `following` count update?" → `follow-stats(Bob)` shows
  `following: 1`.

The list endpoints are only required for the *user-facing* "who
follows me / who do I follow" list page, which is itself deferred.

## Risks / Trade-offs

- **[Risk] First composite PK in the codebase adds JPA boilerplate
  patterns the team hasn't applied before.** → Mitigation: ~15 lines
  for the `FollowId` `@Embeddable` record. The boilerplate is purely
  declarative and well-documented. Decision 1 explains the reasoning;
  future relationship-style tables can reference this change as
  precedent.
- **[Risk] Idempotent mutations (Decision 3) hide certain client
  bugs.** A client that double-follows by accident never learns it
  re-tried — the server returns the same `204` twice. → Mitigation:
  this is the same trade-off every idempotent REST mutation makes.
  The observable state (the row exists, the counts are correct) is
  always reachable via `follow-stats`, so a client that wants to
  detect a duplicate can fetch stats before and after. The alternative
  (409 on duplicate) requires every well-behaved client to write code
  paths reconciling "did I just create this or was it already there,"
  which is busy-work that competes against idempotency's clarity.
- **[Risk] Computed counts (Decision 6) become a perf cliff for users
  with very large follower sets.** → Mitigation: documented as the
  known trapdoor. The endpoint contract is unchanged when /
  denormalisation lands — only the implementation flips. Until a
  realistic load profile demands it, the simpler design wins.
- **[Risk] Packing `viewerFollows` into the stats response (Decision 7)
  means the response varies per-caller, so caches cannot key on
  `userId` alone.** → Mitigation: TanStack Query's cache key already
  keys per-user-per-query-arg by default; the SPA invalidates by
  `userId` on mutation. There is no shared HTTP cache for these
  responses (auth-required endpoints with per-caller bodies are not
  cacheable at the proxy layer anyway). The risk is theoretical for
  this change's deployment shape.
- **[Risk] `ON DELETE CASCADE` on `follows` (Decision 5) is the right
  policy for a deletion flow that doesn't yet exist; a future
  deletion design might prefer to keep the relationship rows as
  tombstones.** → Mitigation: if a future change decides tombstones
  beat cascading, that's one migration to drop+recreate the
  constraints. Cheaper than the reverse migration (taking RESTRICT to
  CASCADE later means manually deleting orphans). Today there is no
  deletion code path, so the constraint is functionally inert.
- **[Trade-off] Skeleton placeholders during `useGetFollowStats`
  in-flight (Decision 10) add CSS / layout work that the simple
  approach ("don't render until stats are ready") avoids.** Acceptable:
  the existing `ProfilePage` already renders the header at `'…'` while
  `useGetUser` is in flight, so the layout-doesn't-jump rule is the
  project's existing convention; counts / button skeletons extend it.
- **[Trade-off] Three queries on `ProfilePage` mean three network
  round-trips on profile mount.** Acceptable: all three start in
  parallel, all three hit an authed Postgres-backed endpoint with
  indexed reads, and none depends on the others' bodies. The
  bottleneck remains the slowest single query (typically the post
  list), not the count of queries.
- **[Trade-off] Asymmetric handling of self-follow (400) vs.
  self-unfollow (204) (Decision 4) requires a one-line code-review
  callout to anyone surprised by the difference.** Acceptable: the
  idempotent-delete contract is the higher-value invariant; the
  asymmetry is the natural consequence of taking both rules
  literally.
- **[Risk] Deferring follower / following list endpoints (Decision 13)
  means a future change owns both the endpoints AND the SPA list
  pages.** → Mitigation: that's exactly the right unit of work for a
  vertical-slice change. Spec'ing list endpoints now without their
  consumer page is the worse split: the endpoints would have shape
  questions (cursor codec? sort order? include `viewerFollows` for
  each row?) that only the consumer can answer.
