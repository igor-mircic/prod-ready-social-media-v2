## Why

The `add-follows` change introduced the social graph — a `follows`
table, follow / unfollow endpoints, and a Follow / Unfollow affordance
on the profile page — but explicitly deferred the *feed read against
that graph* as the follow-up. As a result, following someone today has
**zero observable effect for the follower**: `/home` is still hard-
coded to `<PostList userId={currentUser.id} />`, which means a user
who has just followed ten people sees nothing new on their home page.
The platform is one step short of being social.

This change closes the loop with a **materialised, fanout-on-write
feed**: a per-recipient `feed_entries` table maintained eagerly by the
write paths (post create, post soft-delete, follow, unfollow). The
home read becomes a single keyset-paginated query against one table.
Authoring a post writes one row per follower; following someone
backfills the followee's recent posts into the follower's feed;
unfollowing scrubs them.

**Why fanout-on-write instead of a read-time `WHERE author_id IN (...)`
merge across the existing `posts` table?** A naive read-time merge is
the textbook MVP and would suffice at toy scale, but this codebase
is explicitly a vehicle for encountering production-grade enterprise
patterns. The fanout pattern is what Twitter, Instagram, and Facebook
actually run (with refinements for celebrity authors). Picking it
here exercises:

- a write-amplified hot path with the real consistency questions
  (transactional fanout, partial-failure semantics, rebuild
  procedure);
- a denormalised read-side structure that frees the read query from
  the social-graph topology;
- the celebrity-author trade-off explicitly, even if this change
  does not yet solve it (it is documented as the well-known
  follow-up "hybrid push/pull" optimisation in `design.md`).

The feed is intentionally minimal beyond the architectural commitment:
strict reverse-chronological order, no ranking, no realtime push, no
async workers (the fanout is synchronous within the post-create
transaction at this scale, by deliberate choice — see `design.md`).
Read shape and cursor wire format match the existing per-author list
so a follow-up client can decode a feed cursor exactly the same way
it decodes the author-list cursor.

## What Changes

- **Backend — Flyway migration `V5__create_feed_entries.sql`** creating
  a `feed_entries` table with columns:
  - `recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`,
  - `post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE`,
  - `author_id UUID NOT NULL` (denormalised from `posts.author_id`,
    needed so unfollow can scrub by `(recipient_id, author_id)`
    without joining `posts`),
  - `created_at TIMESTAMPTZ NOT NULL` (denormalised from
    `posts.created_at`, needed so the read query orders by recipient-
    local time without joining `posts`),
  - `PRIMARY KEY (recipient_id, post_id)` — dedupes the (recipient,
    post) pair so re-fanout, re-backfill, or a retry are idempotent,
  - secondary index `feed_entries_read_idx ON feed_entries
    (recipient_id, created_at DESC, post_id DESC)` — backs the
    keyset page query, the primary read path,
  - secondary index `feed_entries_author_idx ON feed_entries
    (recipient_id, author_id)` — backs the unfollow scrub.
- **Backend — `GET /api/v1/feed`** that returns the authenticated
  caller's home feed. Implementation reads from `feed_entries`
  filtered by `recipient_id = :callerId`, joining `posts` on
  `post_id` to assemble the `PostResponse` body (author summary +
  body + createdAt). Soft-deleted posts are excluded by the eager-
  scrub in the soft-delete write path (Decision 4 in `design.md`),
  but the read query SHALL additionally filter `WHERE p.deleted_at
  IS NULL` as a defence-in-depth backstop. Response shape is the
  existing `PostListResponse { items: PostResponse[], nextCursor:
  string | null }`. Query parameters mirror the per-author list:
  optional `cursor` (opaque base64url string), optional `limit`
  (default `20`, clamped to `[1, 50]`). Unauthenticated callers
  receive `401 ProblemDetail`. Malformed `cursor` returns `400
  ProblemDetail`. No `404` path exists (the endpoint has no path
  parameter to be unknown).
- **Backend — reuse `PostCursorCodec`, `PostResponse`,
  `AuthorSummary`, `PostListResponse`** from the `posts` package
  unchanged. The cursor wire shape is identical: `[version-byte]
  [created_at-millis, 8 bytes] [post-id-uuid, 16 bytes]`. A feed
  cursor and an author-list cursor are wire-compatible (the codec
  doesn't carry a flavour).
- **Backend — post-create fans out synchronously to followers.**
  Modify `PostService.create(authorId, body)` so the same transaction
  that inserts the new `posts` row ALSO inserts a row into
  `feed_entries` for each follower of `authorId` PLUS one for
  `authorId` themselves (self-fanout — so the author sees their own
  post on `/home` and the empty-follow-graph case is non-empty). The
  fanout is a single SQL statement:

  ```
  INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
  SELECT follower_id, :postId, :authorId, :createdAt
    FROM follows WHERE followee_id = :authorId
  UNION ALL
  SELECT :authorId, :postId, :authorId, :createdAt
  ON CONFLICT (recipient_id, post_id) DO NOTHING;
  ```
- **Backend — post-soft-delete scrubs feed entries.** Modify
  `PostService.delete(...)` so the same transaction that sets
  `posts.deleted_at = now()` ALSO runs `DELETE FROM feed_entries
  WHERE post_id = :postId`. This keeps the read query fast (no
  soft-delete predicate hits the hot index) and keeps `feed_entries`
  the canonical source of "what should the recipient see."
- **Backend — follow backfills the followee's recent posts.** Modify
  `FollowService.follow(callerId, targetId)` so the same transaction
  that inserts the `follows` row ALSO runs:

  ```
  INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
  SELECT :callerId, p.id, p.author_id, p.created_at
    FROM posts p
   WHERE p.author_id = :targetId AND p.deleted_at IS NULL
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 100
  ON CONFLICT (recipient_id, post_id) DO NOTHING;
  ```

  The backfill cap of 100 is a deliberate ceiling (see `design.md`
  decision 6). The `ON CONFLICT` clause means re-following someone
  who was previously followed is idempotent — the existing entries
  stay, only new ones are added.
- **Backend — unfollow scrubs the followee's entries from the
  caller's feed.** Modify `FollowService.unfollow(callerId, targetId)`
  so the same transaction that deletes the `follows` row ALSO runs:

  ```
  DELETE FROM feed_entries
   WHERE recipient_id = :callerId AND author_id = :targetId;
  ```

  Uses the `feed_entries_author_idx` index added by the migration.
  Self-unfollow (the no-op case from `add-follows`) deletes zero
  rows and is harmless.
- **Backend — new `feed/` package**: `FeedController`, `FeedService`,
  and `FeedEntry` JPA entity + `FeedEntryRepository`. The repository
  exposes a `findPage(recipientId, asOfCreatedAt, asOfPostId, limit)`
  derived or `@Query` finder backed by `feed_entries_read_idx`. The
  `feed/` package depends on `useraccounts` (for the principal) and
  on `posts` (for `PostResponse` / `AuthorSummary` / `PostCursorCodec`
  / `Post` lookups) but not on `follows` directly — the social graph
  is consumed only at write time, through `feed_entries` rows that
  the write paths already populated.
- **Backend — fanout helper centralised in `feed/FeedFanoutService.java`**
  injected into `PostService` and `FollowService`. The helper holds
  the four SQL statements above (`onPostCreated`, `onPostDeleted`,
  `onFollow`, `onUnfollow`). Co-locating the writes in one helper
  keeps `PostService` and `FollowService` clean (they call one
  method) and makes the fanout invariants reviewable in one file.
  The helper is `@Transactional(propagation = MANDATORY)` so callers
  cannot accidentally invoke fanout outside their own transaction.
- **Backend — Testcontainers `FeedControllerIT`** covering:
  - empty feed for a brand-new user with no posts and no follows is
    `200 { items: [], nextCursor: null }`;
  - new user's own post appears in their own feed (self-fanout);
  - Bob's feed after `follow(Alice)` contains Alice's pre-existing
    posts (backfill cap permitting);
  - Alice posts after Bob follows her → Alice's new post is in Bob's
    feed (forward fanout);
  - Alice soft-deletes a post → that post is gone from Bob's feed
    (scrub on delete);
  - Bob unfollows Alice → Alice's posts are gone from Bob's feed
    (scrub on unfollow);
  - re-follow Alice → backfill repopulates without duplicating rows
    that pre-existed for unrelated reasons (idempotency via `ON
    CONFLICT`);
  - cursor pagination walks a multi-author feed across two pages and
    the assembled items match the seeded set in `(created_at DESC,
    post_id DESC)` order;
  - backfill cap is respected: when the followee has > 100 non-
    deleted posts, exactly 100 most-recent posts land in the
    follower's feed by `(created_at DESC, post_id DESC)`;
  - unauthenticated returns 401;
  - malformed cursor returns 400.
- **Backend — extend existing `PostsControllerIT` and
  `FollowsControllerIT`** to assert the fanout side-effects on
  `feed_entries`:
  - `PostsControllerIT.create_fansOutToFollowersAndSelf`,
  - `PostsControllerIT.delete_scrubsFeedEntries`,
  - `FollowsControllerIT.follow_backfillsRecipientFeed` (capped at
    100),
  - `FollowsControllerIT.unfollow_scrubsRecipientFeedForAuthor`.
  These read `feed_entries` directly (the IT base already has a
  `JdbcTemplate` injectable) — they don't go through the feed read
  endpoint, so they're proving the write contracts independently.
- **API contract — refresh `openapi/openapi.json`** to include the
  new `GET /api/v1/feed` operation. The existing `PostListResponse` /
  `PostResponse` / `ProblemDetail` schemas are referenced unchanged.
  Orval regenerates the frontend and e2e client surfaces. CI drift
  check enforces snapshot freshness.
- **Frontend — new `FeedList` component** at
  `frontend/src/features/feed/FeedList.tsx` consuming the Orval-
  generated `useGetFeed` hook via `useInfiniteQuery`, structurally a
  clone of `PostList.tsx` keyed on the feed query rather than per-
  author. Loading, error, empty, populated, and `Load more`
  affordances mirror `PostList` exactly so the visual contract on
  `/home` does not change beyond the data source.
- **Frontend — `PostCard` invalidation is generalised via a parent-
  provided callback.** Today `PostCard` invalidates
  `postsByAuthorListKeyPrefix(listOwnerId)` after a successful
  delete. Change `PostCard`'s contract so the parent passes an
  `onDeleteSuccess: () => void` callback; `PostCard` invokes it on
  mutation success and runs no invalidation itself. `PostList`
  passes a callback that invalidates `postsByAuthorListKeyPrefix(...)`
  (current behaviour preserved); `FeedList` passes a callback that
  invalidates the feed query key. The `listOwnerId` prop is removed
  from `PostCard` in favour of the callback.
- **Frontend — rewire `HomePage`**: replace `<PostList userId={userId}
  />` with `<FeedList />`. The composer, the welcome card, and the
  logout button stay. The `useMe` query stays in `HomePage` because
  the composer still needs the author id.
- **Frontend — `ProfilePage` follow / unfollow mutations also
  invalidate the feed query.** The mutations already invalidate
  `getGetFollowStatsQueryKey(userId)`; add an invalidation of the
  feed query key on the same success path. The backend's eager
  backfill / scrub makes the next feed fetch immediately correct, so
  this is a true optimistic invalidation (no stale window).
- **Frontend — Vitest** for `FeedList`: empty state, single-page
  render, two-page cursor walk, error state, delete-from-feed
  refetches the feed (via the new callback shape).
- **Frontend — Vitest** for the rewired `HomePage`: assert it mounts
  `<FeedList />` and does NOT fire `GET
  /api/v1/users/{currentUserId}/posts` in the steady state.
- **Frontend — Vitest extension** of the existing `PostCard.test.tsx`
  to cover the new `onDeleteSuccess` callback contract: clicking
  delete fires the mutation and invokes the callback (does NOT
  invalidate any key itself).
- **Frontend — Vitest extension** of the existing `PostList.test.tsx`
  to confirm the parent-supplied callback still invalidates the
  per-author key (no regression on the profile / per-author flow).
- **Frontend — Vitest extension** of the existing `ProfilePage`
  follow / unfollow tests to assert that the feed query key is
  invalidated on follow / unfollow success.
- **E2E — `apiClient.getFeed(token, { cursor?, limit? })`** helper
  in `e2e/src/helpers/apiClient.ts`, using the Orval-generated
  `getGetFeedUrl(...)` (NOT a hardcoded path), returning the
  existing `{ status, body }` shape.
- **E2E — `e2e/tests/feed.spec.ts`** proving the end-to-end vertical
  through the SPA against the real backend:
  1. Alice and Bob signed up via `apiClient`; Bob seeded with one
     post via the SPA composer; Alice seeded with two posts via the
     API.
  2. Bob logs into the SPA, lands on `/home`, sees only his own one
     post.
  3. Bob navigates to `/users/{aliceId}`, clicks Follow.
  4. Bob's `/home` (refreshed by the follow mutation's feed-
     invalidation) shows three posts (his one + Alice's two), in
     `(created_at DESC, post_id DESC)` order.
  5. Alice posts a third post via the API; Bob refreshes `/home`,
     sees four posts; topmost rendered body is Alice's just-created
     body.
  6. Bob navigates to `/users/{aliceId}`, clicks Unfollow.
  7. Bob's `/home` (refreshed by the unfollow mutation's feed-
     invalidation) shows only his own one post again.
- **E2E — API-edges block** in the same file:
  - empty feed for a brand-new user (no follows, no own posts)
    returns `{ items: [], nextCursor: null }`;
  - self-fanout: a new user authors a post via the SPA, then
    `apiClient.getFeed(theirToken)` returns one item whose body
    matches;
  - cursor pagination walks a 21-post multi-author seed (Alice 11
    posts + Bob 10 posts, Bob follows Alice) across two pages with
    default `limit=20`;
  - malformed cursor returns 400 + ProblemDetail;
  - unauthenticated `GET /api/v1/feed` returns 401 + ProblemDetail;
  - re-follow idempotency: Bob follows → unfollows → follows Alice;
    `getFeed(bobToken)` after the second follow contains Alice's
    posts exactly once.
- **E2E — axe scan extension** of `/home` in
  `e2e/tests/axe.routes.spec.ts`: seed a follow + cross-author posts
  before the `/home` scan so it exercises a populated feed. One
  additional `runAxeScan` call after the feed-populating step,
  asserting no violations.

### Explicit non-goals (deferred to follow-ups)

- **Async / queued fanout.** The fanout is synchronous in the post-
  create transaction. At a real-scale celebrity-author follower
  count this becomes the wrong choice (the latency of writing a
  single post would be O(followers)); the production-shape solution
  is an async worker reading off a queue. Out of scope here;
  `design.md` documents the trapdoor.
- **Hybrid push / pull for celebrity authors.** Twitter's well-
  known answer to the celebrity problem is "do not fan out for
  users with N+ followers; merge their posts in at read time
  instead." Not built here. The single uniform fanout path makes
  the consistency invariants easier to reason about for this
  scope.
- **Realtime push / WebSocket / SSE.** No live updates. Feed
  refreshes on navigation, manual reload, or after a mutation that
  invalidates the query.
- **Server-side ranking or "for you" reordering.** Strict reverse-
  chronological. No engagement signals.
- **Per-author dedupe / capping per page.** A prolific followee can
  dominate a page.
- **Server-side feed size cap / TTL.** No per-recipient maximum row
  count. `feed_entries` grows unbounded by design — the rebuild
  procedure (see `design.md`) is the relief valve. A real-scale
  follow-up would add a cap (e.g. keep the most-recent 1000 entries
  per recipient).
- **Cross-cutting "feed rebuild" admin endpoint.** Rebuild from
  `(posts, follows)` is conceptually well-defined (and tested as a
  set-equality invariant in `FeedControllerIT`) but not exposed
  through an HTTP surface. A future ops capability owns it.
- **A separate "explore" / global timeline.** No `/api/v1/explore`.
- **Soft-deleted post tombstones in the feed.** Soft-deleted posts
  are scrubbed from `feed_entries` immediately. No "[deleted by
  author]" placeholders.
- **`viewerFollows` or any per-recipient indicator inside
  `PostResponse`.** The feed reuses the existing lean
  `PostResponse` shape.
- **Feed-side likes, comments, reposts, quote-posts, mentions.**
  Future capabilities.

## Capabilities

### New Capabilities

- `feed` — the home-feed capability: the `feed_entries` table, the
  fanout-on-write maintenance contract (post-create, post-delete,
  follow, unfollow), the `GET /api/v1/feed` read endpoint, IT
  coverage of both write contracts and read contracts, the
  `FeedList` SPA component, the rewired `HomePage`, the new e2e
  helper, the Playwright vertical spec, and the axe coverage of the
  populated `/home`.

### Modified Capabilities

- `posts` — adds a requirement that creating a post fans out into
  `feed_entries` for every follower of the author plus the author
  themselves, and that soft-deleting a post scrubs all
  `feed_entries` referencing that post. These are write-side
  invariants on top of the existing create / soft-delete contracts;
  the public HTTP contract of `POST /api/v1/posts` and `DELETE
  /api/v1/posts/{id}` is unchanged.
- `follows` — adds a requirement that following a user backfills up
  to the followee's 100 most-recent non-deleted posts into the
  caller's `feed_entries`, and that unfollowing scrubs all of that
  followee's posts from the caller's `feed_entries`. The HTTP
  contracts of `POST /api/v1/users/{userId}/follow` and `DELETE
  /api/v1/users/{userId}/follow` are unchanged; the change is the
  side-effect on `feed_entries`.
- `user-profile` — adds a requirement that the follow / unfollow
  mutations on `ProfilePage` invalidate the feed query key, so a
  user returning to `/home` after toggling a follow sees the
  refreshed feed without a manual reload. Existing
  `ProfilePage` requirements (heading, counts, toggle button hidden
  on own profile, etc.) are unchanged.

### Touched-but-not-modified Capabilities (cited for clarity)

- `user-accounts` — no schema, endpoint, or contract changes.
- `api-contract` — `openapi/openapi.json` regenerates to include the
  new path; the CI drift check is the existing one.
- `ci` — no new jobs.
- `e2e` — no scaffold changes.
- `frontend-scaffold` / `frontend-styling` — no changes.
- `monorepo-layout` — no changes.

## Impact

- **Backend:**
  - New: `backend/src/main/resources/db/migration/V5__create_feed_entries.sql`.
  - New: `backend/src/main/java/com/prodready/social/feed/FeedEntry.java`
    JPA entity with `@EmbeddedId FeedEntryId id;` (composite of
    `recipientId, postId`) plus denormalised `authorId` and
    `createdAt` columns. Cross-aggregate references are by UUID
    (consistent with the `Post` / `Follow` convention).
  - New: `backend/src/main/java/com/prodready/social/feed/FeedEntryId.java`
    `@Embeddable record FeedEntryId(UUID recipientId, UUID postId)`.
  - New: `backend/src/main/java/com/prodready/social/feed/FeedEntryRepository.java`
    with a `@Query` `findPage(...)` finder that joins `feed_entries`
    to `posts` and produces `PostResponse` projections (or, more
    cleanly, returns `Post` entities by post id and `FeedController`
    assembles the response — picked in `design.md` decision 5).
  - New: `backend/src/main/java/com/prodready/social/feed/FeedFanoutService.java`
    with `onPostCreated(Post)`, `onPostDeleted(UUID postId)`,
    `onFollow(UUID followerId, UUID followeeId)`,
    `onUnfollow(UUID followerId, UUID followeeId)`. Annotated
    `@Transactional(propagation = MANDATORY)` so misuse outside an
    enclosing transaction is a runtime failure.
  - New: `backend/src/main/java/com/prodready/social/feed/FeedService.java`
    with `findPage(callerId, cursor, limit)` returning a
    `PostListResponse`.
  - New: `backend/src/main/java/com/prodready/social/feed/FeedController.java`
    `@GetMapping("/feed")`.
  - New: `backend/src/test/java/com/prodready/social/feed/FeedControllerIT.java`.
  - Modified: `backend/src/main/java/com/prodready/social/posts/PostService.java`
    — `create(...)` calls `feedFanoutService.onPostCreated(post)`
    inside the same transaction; `delete(...)` calls
    `feedFanoutService.onPostDeleted(postId)` inside the same
    transaction.
  - Modified: `backend/src/main/java/com/prodready/social/follows/FollowService.java`
    — `follow(...)` calls `feedFanoutService.onFollow(...)` inside
    the same transaction; `unfollow(...)` calls
    `feedFanoutService.onUnfollow(...)` inside the same transaction.
  - Modified: `backend/src/test/java/com/prodready/social/posts/PostsControllerIT.java`
    — adds the two new fanout-side-effect cases listed above.
  - Modified: `backend/src/test/java/com/prodready/social/follows/FollowsControllerIT.java`
    — adds the two new fanout-side-effect cases listed above.
- **Frontend:**
  - New: `frontend/src/features/feed/FeedList.tsx`.
  - New: `frontend/src/features/feed/FeedList.test.tsx`.
  - New: `frontend/src/features/feed/feedQueryKeys.ts` (or inline if
    Orval's generated key factory is sufficient — picked in
    `design.md` decision 8).
  - Modified: `frontend/src/features/home/HomePage.tsx` — swap
    `PostList` for `FeedList`.
  - Modified: `frontend/src/features/home/HomePage.test.tsx`.
  - Modified: `frontend/src/features/posts/PostCard.tsx` — replace
    `listOwnerId: string` with `onDeleteSuccess: () => void`; remove
    the embedded invalidation.
  - Modified: `frontend/src/features/posts/PostCard.test.tsx`.
  - Modified: `frontend/src/features/posts/PostList.tsx` — passes
    `onDeleteSuccess` callback that invalidates
    `postsByAuthorListKeyPrefix(userId)`.
  - Modified: `frontend/src/features/posts/PostList.test.tsx`.
  - Modified: `frontend/src/features/profile/ProfilePage.tsx` —
    follow / unfollow `onSuccess` also invalidates the feed query
    key.
  - Modified: `frontend/src/features/profile/ProfilePage.test.tsx`.
- **API contract / codegen:**
  - `openapi/openapi.json` regenerated. New operation
    `GET /api/v1/feed` with `operationId: getFeed`. Schemas
    referenced not redefined.
  - Orval regenerates `frontend/src/api/generated/feed-controller/`
    and `e2e/src/api/generated/feed-controller/`.
- **E2E:**
  - New: `e2e/tests/feed.spec.ts`.
  - Modified: `e2e/src/helpers/apiClient.ts` adds `getFeed`.
  - Modified: `e2e/tests/axe.routes.spec.ts` seeds a populated feed
    before the `/home` scan.
- **OpenSpec specs:**
  - New: `openspec/specs/feed/spec.md` (at archive time, from
    `openspec/changes/add-home-feed/specs/feed/spec.md`).
  - Modified: `openspec/specs/posts/spec.md` gains the two write-
    side fanout invariants (create → fanout, soft-delete → scrub).
  - Modified: `openspec/specs/follows/spec.md` gains the two write-
    side invariants (follow → backfill capped at 100, unfollow →
    scrub).
  - Modified: `openspec/specs/user-profile/spec.md` gains the
    requirement that follow / unfollow mutations also invalidate the
    feed query key.
- **CI:** No new jobs. Existing backend IT, OpenAPI-drift, frontend
  Vitest, and Playwright jobs pick up the new files automatically.
- **Database:** One new migration (`V5`). One new table
  (`feed_entries`). Two new indexes (`feed_entries_read_idx` and
  `feed_entries_author_idx`). No changes to existing tables.
- **Dependencies:** None added.
