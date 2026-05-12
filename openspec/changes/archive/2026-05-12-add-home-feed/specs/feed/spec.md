## ADDED Requirements

### Requirement: A `feed_entries` table is created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V5__create_feed_entries.sql` that creates a `feed_entries` table representing the materialised, fanout-on-write home feed: one row per `(recipient, post)` pair that the recipient should see on their home feed.

#### Scenario: Migration creates the table

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** a `feed_entries` table exists
- **AND** has a `recipient_id` column of type `UUID NOT NULL` with a foreign key to `users(id)` declared `ON DELETE CASCADE`
- **AND** has a `post_id` column of type `UUID NOT NULL` with a foreign key to `posts(id)` declared `ON DELETE CASCADE`
- **AND** has an `author_id` column of type `UUID NOT NULL` (denormalised from `posts.author_id`; no foreign key declared, by design, to allow eager scrub without join)
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` (denormalised from `posts.created_at`)
- **AND** has a composite primary key `(recipient_id, post_id)`.

#### Scenario: Foreign keys are CASCADE

- **WHEN** a reader inspects the migration
- **THEN** the `recipient_id` foreign-key constraint declares `ON DELETE CASCADE`
- **AND** the `post_id` foreign-key constraint declares `ON DELETE CASCADE`
- **AND** neither constraint declares `ON DELETE RESTRICT` or `ON DELETE SET NULL`.

#### Scenario: Read-path index supports the keyset page query

- **WHEN** a reader inspects the migration
- **THEN** an index `feed_entries_read_idx` exists on `feed_entries (recipient_id, created_at DESC, post_id DESC)`
- **AND** the index is non-unique
- **AND** the index does NOT carry a partial `WHERE` predicate (because `feed_entries` rows are scrubbed eagerly on post soft-delete; every live row is, by invariant, visible).

#### Scenario: Author-scrub index supports the unfollow scrub

- **WHEN** a reader inspects the migration
- **THEN** an index `feed_entries_author_idx` exists on `feed_entries (recipient_id, author_id)`
- **AND** the index is non-unique.

#### Scenario: Cascading delete of a user removes their feed entries as recipient

- **WHEN** a `users` row is deleted (hard delete; not exercised by any current API but the constraint is forward-compatible)
- **THEN** the database removes every `feed_entries` row whose `recipient_id` matched the deleted user
- **AND** the database additionally removes any `posts` rows authored by that user, which in turn cascades to remove every `feed_entries` row whose `post_id` referenced those posts.

### Requirement: `GET /api/v1/feed` returns the caller's home feed from `feed_entries`

The backend SHALL expose `GET /api/v1/feed` returning the authenticated caller's home feed: the contents of `feed_entries` filtered by `recipient_id = :callerId`, joined to `posts` to assemble each item's body and author summary, ordered by `(feed_entries.created_at DESC, feed_entries.post_id DESC)`. The endpoint SHALL accept optional query parameters `cursor` (opaque string) and `limit` (integer). The response body SHALL be the existing `PostListResponse { items: PostResponse[], nextCursor: string | null }`. The endpoint SHALL be authenticated; unauthenticated callers SHALL receive `401 ProblemDetail`. A malformed `cursor` SHALL return `400 ProblemDetail`. There is no path parameter, so `404` does not apply.

#### Scenario: First page for a brand-new user is empty

- **WHEN** an authenticated user who has no posts and follows nobody calls `GET /api/v1/feed`
- **THEN** the response status is 200
- **AND** the response body is `{ items: [], nextCursor: null }`.

#### Scenario: First page returns the caller's own posts even with no follows

- **WHEN** an authenticated user who has posted N times and follows nobody calls `GET /api/v1/feed`
- **THEN** the response status is 200
- **AND** the response body's `items` contains the user's own non-deleted posts, ordered by `(created_at DESC, post_id DESC)`
- **AND** when `N <= 20`, `nextCursor` is `null`.

#### Scenario: First page returns posts authored by followees

- **WHEN** an authenticated caller follows another user (A) and A has authored M non-deleted posts (with `M <= 100` so the backfill cap is not exercised), and the caller has no own posts
- **THEN** `GET /api/v1/feed` returns M items
- **AND** every item's `author.id` equals A's id
- **AND** the items are ordered by `(created_at DESC, post_id DESC)`.

#### Scenario: Forward fanout — a followee's new post lands in the caller's feed

- **WHEN** an authenticated caller already follows A, and A authors a new post via `POST /api/v1/posts`
- **THEN** the caller's next `GET /api/v1/feed` includes the new post as the topmost item (assuming no newer posts from other followees or the caller themselves).

#### Scenario: Subsequent page advances by cursor

- **WHEN** an authenticated client calls `GET /api/v1/feed?cursor=<nextCursor-from-previous-page>`
- **THEN** the response status is 200
- **AND** the response body's `items` are the next page of feed entries strictly older than the cursor (by the `(created_at DESC, post_id DESC)` ordering of `feed_entries`)
- **AND** `nextCursor` is `null` only when no further entries remain.

#### Scenario: limit parameter is honored within the cap

- **WHEN** an authenticated client calls the feed endpoint with `?limit=N` for any `1 <= N <= 50`
- **THEN** the server returns at most N items in `items`.

#### Scenario: Default and cap for limit

- **WHEN** an authenticated client omits `limit`
- **THEN** the server treats `limit` as `20`.
- **WHEN** an authenticated client supplies `limit` greater than `50`
- **THEN** the server clamps the effective limit to `50`.

#### Scenario: Soft-deleted posts are not in the feed

- **WHEN** a post in the caller's feed is soft-deleted by its author
- **THEN** the next `GET /api/v1/feed` for the caller does not include the soft-deleted post
- **AND** the corresponding `feed_entries` rows for that post have been removed (the eager-scrub invariant on the soft-delete write path).

#### Scenario: Cursor codec is reused from the per-author list endpoint

- **WHEN** a reader inspects the `nextCursor` issued by `GET /api/v1/feed`
- **THEN** the cursor is the same opaque `base64url` shape as `GET /api/v1/users/{userId}/posts` issues
- **AND** the decoded bytes are `[version-byte] [created_at-millis-since-epoch, 8 bytes big-endian] [post-id-uuid, 16 bytes]`
- **AND** clients SHALL treat the cursor as opaque.

#### Scenario: Malformed cursor is rejected

- **WHEN** an authenticated client calls `GET /api/v1/feed` with a `cursor` that is not valid base64url, has the wrong length, or has an unrecognized version byte
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `cursor` among the failing fields.

#### Scenario: Unauthenticated caller receives 401

- **WHEN** a client calls `GET /api/v1/feed` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.

### Requirement: Read query joins `posts` and `users` but filters and orders on `feed_entries` columns only

The read query SHALL apply the keyset predicate, the `recipient_id` filter, the `LIMIT`, and the `ORDER BY` against `feed_entries` columns only. The join to `posts` (for `body` and `created_at` symmetry checks) and to `users` (for the author summary's `displayName`) SHALL happen after the ordered keyset slice, on at most `limit + 1` rows. The read query SHALL additionally filter `WHERE p.deleted_at IS NULL` as a defence-in-depth guardrail (the soft-delete write path already scrubs `feed_entries` of references to soft-deleted posts).

#### Scenario: Index-only ordering on the hot path

- **WHEN** a reader inspects the query plan for `GET /api/v1/feed`
- **THEN** the keyset filter `(feed_entries.created_at, feed_entries.post_id) < (:asOfCreatedAt, :asOfPostId)` and the order `feed_entries.created_at DESC, feed_entries.post_id DESC` are served by the `feed_entries_read_idx` index
- **AND** no sort step appears in the plan before the `LIMIT`.

#### Scenario: Defence-in-depth filter on soft-deleted posts

- **WHEN** a reader inspects the read query
- **THEN** the join to `posts` includes `WHERE p.deleted_at IS NULL`
- **AND** if (by bug) a `feed_entries` row points at a soft-deleted post, the read query silently drops it rather than rendering it.

### Requirement: `FeedFanoutService` is the single helper that mutates `feed_entries`

The `backend/` project SHALL include a `feed/FeedFanoutService.java` exposing exactly four methods that mutate `feed_entries`: `onPostCreated(Post)`, `onPostDeleted(UUID postId)`, `onFollow(UUID followerId, UUID followeeId)`, `onUnfollow(UUID followerId, UUID followeeId)`. No other class in the backend SHALL write to `feed_entries` directly (excluding the test-only `FeedRebuilder` used by the invariant integration test).

#### Scenario: Helper is propagation-mandatory transactional

- **WHEN** a reader inspects `FeedFanoutService`
- **THEN** every public method is `@Transactional(propagation = Propagation.MANDATORY)` (annotated at the method level or inherited from the class level)
- **AND** calling any helper method outside an enclosing transaction raises `IllegalTransactionStateException`.

#### Scenario: No other production code writes to `feed_entries`

- **WHEN** a reader greps the codebase for `INSERT INTO feed_entries`, `UPDATE feed_entries`, `DELETE FROM feed_entries`, or any JPA-level `feedEntryRepository.save(...)` / `.deleteById(...)` / `.delete(...)`
- **THEN** the only production hits are inside `feed/FeedFanoutService.java` (the four maintenance methods).

### Requirement: Post create fans out to followers and the author

`PostService.create(authorId, body)` SHALL, inside the same transaction that persists the new `posts` row, insert one `feed_entries` row for each user who follows `authorId` PLUS one `feed_entries` row whose `recipient_id = authorId` (self-fanout). The fanout SHALL be idempotent on retry / re-execution via `ON CONFLICT (recipient_id, post_id) DO NOTHING`.

#### Scenario: Fanout to followers

- **WHEN** authenticated user A authors a new post via `POST /api/v1/posts` and N other users follow A
- **THEN** after the create transaction commits, exactly N rows exist in `feed_entries` whose `(post_id, author_id) = (newPostId, A)` and whose `recipient_id` is each of the N followers
- **AND** the rows' `created_at` equals the new post's `created_at`.

#### Scenario: Self-fanout

- **WHEN** authenticated user A authors a new post via `POST /api/v1/posts`
- **THEN** after the create transaction commits, exactly one row exists in `feed_entries` whose `(recipient_id, post_id, author_id) = (A, newPostId, A)`.

#### Scenario: Fanout is idempotent on retry

- **WHEN** `FeedFanoutService.onPostCreated(post)` is invoked twice with the same `post` (simulating a retry in a future async / queued setup)
- **THEN** the second invocation inserts zero rows
- **AND** `feed_entries` contains exactly the rows produced by the first invocation.

### Requirement: Post soft-delete scrubs feed entries

`PostService.delete(postId)` SHALL, inside the same transaction that sets `posts.deleted_at = now()`, delete every `feed_entries` row whose `post_id = :postId`.

#### Scenario: Soft-delete scrubs all recipients

- **WHEN** the author of a post calls `DELETE /api/v1/posts/{postId}` and the post had fanned out to N recipients (including the author themselves via self-fanout)
- **THEN** after the delete transaction commits, zero `feed_entries` rows reference `postId`
- **AND** the `posts` row's `deleted_at` is set to a non-null timestamp.

### Requirement: Follow backfills the caller's feed with the followee's recent posts, capped at 100

`FollowService.follow(callerId, targetId)` SHALL, inside the same transaction that inserts the `follows` row (whether the row is newly inserted or already existed), copy the followee's 100 most-recent non-deleted posts into `feed_entries` for the caller, idempotently. The backfill is capped at 100.

#### Scenario: Backfill happens on follow

- **WHEN** authenticated caller follows targetId via `POST /api/v1/users/{targetId}/follow`, and `targetId` has authored M non-deleted posts where `M <= 100`
- **THEN** after the follow transaction commits, exactly M rows exist in `feed_entries` whose `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the rows' `post_id` and `created_at` values match `targetId`'s M posts.

#### Scenario: Backfill is capped at 100

- **WHEN** authenticated caller follows targetId, and `targetId` has authored more than 100 non-deleted posts
- **THEN** after the follow transaction commits, exactly 100 rows exist in `feed_entries` whose `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the 100 rows are the 100 most-recent posts by `(posts.created_at DESC, posts.id DESC)`.

#### Scenario: Re-follow is idempotent

- **WHEN** the caller follows → unfollows → follows the same targetId, and `targetId` has not posted in the meantime
- **THEN** after the second follow, `feed_entries` for `(recipient_id = callerId, author_id = targetId)` is identical to its state after the first follow
- **AND** no row is duplicated.

### Requirement: Unfollow scrubs the followee's posts from the caller's feed

`FollowService.unfollow(callerId, targetId)` SHALL, inside the same transaction that removes the `follows` row (whether the row was removed or absent), delete every `feed_entries` row where `(recipient_id, author_id) = (callerId, targetId)`. The scrub SHALL be short-circuited when `callerId.equals(targetId)` so that self-unfollow does NOT scrub the caller's own self-fanout rows.

#### Scenario: Unfollow scrubs the author's posts from the recipient's feed

- **WHEN** caller has K `feed_entries` rows where `author_id = targetId`, and the caller unfollows `targetId`
- **THEN** after the unfollow transaction commits, zero `feed_entries` rows exist where `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the caller's `feed_entries` rows where `author_id != targetId` are unchanged.

#### Scenario: Self-unfollow does NOT scrub the caller's own posts

- **WHEN** the caller calls `DELETE /api/v1/users/{callerId}/follow` (self-unfollow, which by the existing `follows` contract returns 204 and is a no-op on `follows`), and the caller has `feed_entries` self-fanout rows where `(recipient_id, author_id) = (callerId, callerId)`
- **THEN** those self-fanout rows are not deleted
- **AND** the caller's subsequent `GET /api/v1/feed` still returns the caller's own posts.

### Requirement: `feed_entries` contents are derivable from `(posts, follows)` and tested as a set-equality invariant

The contents of `feed_entries` SHALL, after any finite sequence of fanout-helper invocations, equal the set produced by the canonical rebuild:

```sql
TRUNCATE feed_entries;
INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
SELECT f.follower_id, p.id, p.author_id, p.created_at
  FROM follows f JOIN posts p ON p.author_id = f.followee_id
 WHERE p.deleted_at IS NULL
UNION
SELECT p.author_id, p.id, p.author_id, p.created_at
  FROM posts p WHERE p.deleted_at IS NULL;
```

with one exception: the backfill cap of 100 (Decision 6) is a fanout-helper invariant, not a derivation invariant — so the equality holds only when no followee has more than 100 non-deleted posts. The Testcontainers IT proving the equality SHALL respect this bound in its seeded fixture.

#### Scenario: Set equality after a sequence of follow / unfollow / create / delete operations

- **WHEN** the IT seeds a multi-user / multi-post / multi-follow / soft-delete sequence in which no author has more than 100 non-deleted posts
- **AND** snapshots the state of `feed_entries`
- **AND** invokes the canonical rebuild (`FeedRebuilder.rebuild()`)
- **AND** snapshots the state of `feed_entries` again
- **THEN** the two snapshots are equal as sets of `(recipient_id, post_id, author_id, created_at)` tuples.

### Requirement: Integration test coverage of the feed write paths AND the read endpoint

The `backend/` project SHALL include Testcontainers integration tests (matching the existing `*IT.java` pattern under `backend/src/test/java/com/prodready/social/`) that exercise:

- read happy paths (empty, self-only, followee-only, multi-author);
- read pagination (multi-author seed across multiple pages with a chosen `limit`);
- read excludes soft-deleted posts;
- backfill cap of 100 on follow;
- forward fanout on post-create;
- scrub on post-soft-delete;
- scrub on unfollow;
- self-unfollow does NOT scrub own posts;
- re-follow idempotency;
- malformed cursor returns 400;
- unauthenticated returns 401;
- `FeedFanoutService` outside-transaction guardrail (raises `IllegalTransactionStateException`);
- the set-equality invariant between `feed_entries` and the canonical rebuild.

Additionally, the existing `PostsControllerIT` and `FollowsControllerIT` SHALL be extended to cover the fanout side-effects via the HTTP layer (proving that the controllers route into the fanout helper).

#### Scenario: All read and write contracts have direct IT coverage

- **WHEN** a reader inspects `backend/src/test/java/com/prodready/social/feed/FeedControllerIT.java`
- **THEN** every requirement bullet listed above has at least one `@Test` method

#### Scenario: Fanout side-effects are also covered through the HTTP layer

- **WHEN** a reader inspects `PostsControllerIT.java` and `FollowsControllerIT.java`
- **THEN** each file contains tests asserting that the relevant HTTP call (POST /posts, DELETE /posts/{id}, POST /users/{id}/follow, DELETE /users/{id}/follow) produces the expected `feed_entries` state (read via JdbcTemplate, not via the feed read endpoint).

### Requirement: E2E ApiClient exposes authenticated getFeed

The e2e `ApiClient` SHALL expose `getFeed(token, { cursor?, limit? })`. The method SHALL perform `GET /api/v1/feed` against the real backend with `Authorization: Bearer <token>`, SHALL use the Orval-generated URL helper from `e2e/src/api/generated/feed-controller/feed-controller.ts` (not a hardcoded path), and SHALL return a `{ status, body }` shape consistent with the other helpers.

#### Scenario: ApiClient exposes authenticated getFeed

- **WHEN** a test calls `apiClient.getFeed(token)` with a valid bearer `token`
- **THEN** the helper performs `GET /api/v1/feed` against the real backend with `Authorization: Bearer <token>`
- **AND** returns `{ status, body }` where `body` is the typed `PostListResponse` on 200, or `ProblemDetail` on a non-2xx response.

#### Scenario: ApiClient passes cursor and limit when supplied

- **WHEN** a test calls `apiClient.getFeed(token, { cursor: 'abc', limit: 5 })`
- **THEN** the constructed URL includes `cursor=abc` and `limit=5` as query parameters
- **AND** the URL helper used is `getGetFeedUrl(...)` from the generated module (not a hardcoded path).

### Requirement: Playwright e2e spec proves the feed reflects follow / unfollow end-to-end

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/feed.spec.ts` that exercises the feed end-to-end against the real backend and frontend. The spec SHALL prove the full vertical: a brand-new user's `/home` reflects only their own posts; following another user populates the feed with that user's posts (backfill); new posts by a followee appear after refresh (forward fanout); unfollowing removes those posts from `/home`.

#### Scenario: Full UI-vertical walk: follow → see → post → see → unfollow → not-see

- **GIVEN** Alice (signed up via the api) has 2 posts seeded via `apiClient`, and Bob (signed up via the api) has 1 post composed via the SPA composer
- **WHEN** Bob is logged into the SPA and lands on `/home`
- **THEN** Bob's `/home` shows exactly 1 `PostCard` (his own)
- **WHEN** Bob navigates to `/users/{aliceId}` and clicks Follow
- **AND** navigates back to `/home`
- **THEN** Bob's `/home` shows 3 `PostCard`s in `(created_at DESC, post_id DESC)` order
- **WHEN** Alice (via the api) posts a new third post
- **AND** Bob reloads `/home`
- **THEN** Bob's `/home` shows 4 `PostCard`s and the topmost article's body equals Alice's newest seeded body
- **WHEN** Bob navigates to `/users/{aliceId}` and clicks Unfollow
- **AND** navigates back to `/home`
- **THEN** Bob's `/home` shows 1 `PostCard` (his own only).

### Requirement: Playwright e2e spec covers the feed API edges

The `e2e/` project SHALL include Playwright coverage (in the same `feed.spec.ts` file or a sibling) that proves the corner cases that don't surface in the UI vertical: a brand-new user's feed is empty via the API; self-fanout (a fresh user's own composed post appears via `getFeed`); cursor pagination walks a multi-author seed across two pages; malformed cursor returns 400; unauthenticated `GET /api/v1/feed` returns 401; re-follow is idempotent at the feed level (the followee's posts appear exactly once after follow → unfollow → follow).

#### Scenario: Brand-new user empty feed via API

- **WHEN** a freshly signed-up user calls `apiClient.getFeed(token)` with no posts and no follows
- **THEN** the response is `{ status: 200, body: { items: [], nextCursor: null } }`.

#### Scenario: Self-fanout visible via API

- **WHEN** a freshly signed-up user composes one post via the SPA composer
- **AND** calls `apiClient.getFeed(theirToken)`
- **THEN** the response body's `items` has length 1
- **AND** the single item's body equals the composed body.

#### Scenario: Cursor pagination across two pages

- **GIVEN** Alice has 11 posts seeded via the api and Bob has 10 posts seeded via the api, and Bob follows Alice
- **WHEN** Bob calls `apiClient.getFeed(bobToken, { limit: 20 })`
- **THEN** the response body's `items` has length 20 and `nextCursor` is non-null
- **WHEN** Bob calls `apiClient.getFeed(bobToken, { cursor: <nextCursor>, limit: 20 })`
- **THEN** the response body's `items` has length 1 and `nextCursor` is `null`
- **AND** the assembled body set across both pages equals the seeded 21-post set.

#### Scenario: Malformed cursor returns 400

- **WHEN** an authenticated client calls `apiClient.getFeed(token, { cursor: 'not-base64url-something' })`
- **THEN** the response is `{ status: 400, body: <ProblemDetail with status 400> }`.

#### Scenario: Unauthenticated GET /api/v1/feed returns 401

- **WHEN** a client fetches `/api/v1/feed` directly with no `Authorization` header (bypassing the apiClient helper, which always sends Bearer)
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status: 401`.

#### Scenario: Re-follow is idempotent at the feed level

- **GIVEN** Alice has 3 posts
- **WHEN** Bob follows → unfollows → follows Alice
- **AND** Bob calls `apiClient.getFeed(bobToken)`
- **THEN** Alice's 3 post bodies appear in the response exactly once each (no duplicates).

### Requirement: Axe scan covers a populated `/home`

The existing axe-routes spec SHALL exercise `/home` against a populated feed (a seeded follow plus cross-author posts) rather than a pristine page.

#### Scenario: Axe scan on populated `/home`

- **WHEN** the axe-routes spec seeds a follow + cross-author posts and then runs `runAxeScan` on `/home`
- **THEN** the scan completes with no accessibility violations.

### Requirement: `HomePage` renders the home feed via `FeedList`

The `frontend/` project SHALL render the home feed on `/home` via a `FeedList` component that consumes the Orval-generated `useGetFeed` hook via `useInfiniteQuery`. `HomePage` SHALL no longer render `<PostList userId={currentUserId} />`. The composer and the welcome / logout affordance on `/home` are unchanged.

#### Scenario: HomePage renders FeedList

- **WHEN** a reader inspects `frontend/src/features/home/HomePage.tsx`
- **THEN** the file imports `FeedList` from `@/features/feed/FeedList`
- **AND** the JSX renders `<FeedList />` in place of the previous `<PostList userId={userId} />`.

#### Scenario: HomePage does not request the per-author list

- **WHEN** an authenticated user mounts `/home`
- **THEN** the SPA fires `GET /api/v1/feed` (via `useGetFeed`)
- **AND** the SPA does NOT fire `GET /api/v1/users/{currentUserId}/posts`.

### Requirement: `FeedList` mirrors `PostList`'s render branches and supports cursor pagination

`FeedList` SHALL render the same five UX states as `PostList`: loading, error, empty, populated, and `Load more`. It SHALL render each item as `<PostCard post={post} onDeleteSuccess={onFeedItemDeleted} />` and SHALL provide `onFeedItemDeleted` that invalidates the feed query key on the parent.

#### Scenario: Empty state

- **WHEN** `useGetFeed` resolves with `{ items: [], nextCursor: null }`
- **THEN** `FeedList` renders the empty-state copy.

#### Scenario: Populated state with Load more

- **WHEN** `useGetFeed` resolves with N items and `nextCursor` non-null
- **THEN** `FeedList` renders N `PostCard`s ordered as received
- **AND** a `Load more` button is rendered below.

#### Scenario: Load more advances by cursor

- **WHEN** the user clicks `Load more`
- **THEN** the SPA fires `GET /api/v1/feed?cursor=<nextCursor>`
- **AND** the appended items are rendered after the existing items.

#### Scenario: Delete from feed invalidates the feed query

- **WHEN** the user clicks the Delete affordance on a `PostCard` rendered by `FeedList`, and the mutation resolves 204
- **THEN** the parent `FeedList`'s `onFeedItemDeleted` callback invalidates the feed query key
- **AND** the SPA refetches the feed.

### Requirement: `PostCard` accepts a parent-supplied `onDeleteSuccess` callback (replaces `listOwnerId`)

`PostCard` SHALL accept an `onDeleteSuccess: () => void` prop and SHALL invoke it on a successful delete mutation. `PostCard` SHALL NOT invalidate any query key itself; the parent is responsible for choosing which key to invalidate. The previous `listOwnerId: string` prop SHALL be removed.

#### Scenario: PostCard invokes onDeleteSuccess on mutation success

- **WHEN** the user clicks Delete on a `PostCard`, and the mutation resolves 204
- **THEN** the `onDeleteSuccess` callback is invoked exactly once.

#### Scenario: PostCard does not invalidate any query key itself

- **WHEN** a reader inspects `PostCard.tsx`
- **THEN** the file does not import `useQueryClient` or any query-key factory
- **AND** the delete mutation's `onSuccess` only invokes the parent-supplied `onDeleteSuccess` callback.

#### Scenario: `PostList` passes a callback that invalidates the per-author key

- **WHEN** a reader inspects `PostList.tsx`
- **THEN** each rendered `PostCard` receives `onDeleteSuccess` equal to a function that invalidates `postsByAuthorListKeyPrefix(userId)`.

#### Scenario: `FeedList` passes a callback that invalidates the feed key

- **WHEN** a reader inspects `FeedList.tsx`
- **THEN** each rendered `PostCard` receives `onDeleteSuccess` equal to a function that invalidates the feed query key (`getGetFeedQueryKey()` or equivalent).
