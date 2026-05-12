## 1. Backend: Flyway migration `V5__create_feed_entries.sql`

- [x] 1.1 Create `backend/src/main/resources/db/migration/V5__create_feed_entries.sql` declaring a `feed_entries` table with columns `recipient_id UUID NOT NULL`, `post_id UUID NOT NULL`, `author_id UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL`.
- [x] 1.2 Declare the composite primary key `PRIMARY KEY (recipient_id, post_id)` in the same `CREATE TABLE` statement.
- [x] 1.3 Declare the `recipient_id` foreign key as `REFERENCES users(id) ON DELETE CASCADE`. Do NOT use `RESTRICT` or `SET NULL`.
- [x] 1.4 Declare the `post_id` foreign key as `REFERENCES posts(id) ON DELETE CASCADE`.
- [x] 1.5 Create the read-index `CREATE INDEX feed_entries_read_idx ON feed_entries (recipient_id, created_at DESC, post_id DESC);` — backs the keyset page query.
- [x] 1.6 Create the scrub-index `CREATE INDEX feed_entries_author_idx ON feed_entries (recipient_id, author_id);` — backs the unfollow scrub.
- [x] 1.7 Confirm by `psql` (or the IT bootstrap) that `flyway:migrate` against an empty database leaves `feed_entries` in the expected shape and both indexes are present. Sanity-check the FKs by hand: deleting a `users` row removes the user's `feed_entries` rows; deleting (hard) a `posts` row removes any `feed_entries` referencing it.

## 2. Backend: `feed/` package — entity, id, repository

- [x] 2.1 Create package `backend/src/main/java/com/prodready/social/feed/`.
- [x] 2.2 Create `feed/FeedEntryId.java` as a `public record FeedEntryId(UUID recipientId, UUID postId) implements Serializable {}` annotated `@Embeddable`. Provide a no-arg constructor if JPA requires it (verify against the existing `FollowId` pattern from `add-follows`).
- [x] 2.3 Create `feed/FeedEntry.java` annotated `@Entity @Table(name = "feed_entries")` with `@EmbeddedId FeedEntryId id;`, `@Column(name = "author_id", nullable = false) private UUID authorId;`, `@Column(name = "created_at", nullable = false) private OffsetDateTime createdAt;`. Cross-aggregate references are by UUID only (no `@ManyToOne User recipient`, no `@ManyToOne Post post`).
- [x] 2.4 Create `feed/FeedEntryRepository.java` as a `public interface FeedEntryRepository extends JpaRepository<FeedEntry, FeedEntryId>`. Add a `@Query` finder `findPage(...)` that joins `feed_entries` to `posts` and `users` and returns a row-projection DTO carrying everything needed to build a `PostResponse`. The query SHALL apply the keyset predicate `(fe.created_at, fe.post_id) < (:asOfCreatedAt, :asOfPostId)` when the cursor is supplied; SHALL order by `fe.created_at DESC, fe.post_id DESC`; SHALL apply `LIMIT :limit + 1` so the service can detect a next-page boundary; SHALL include `WHERE p.deleted_at IS NULL` as a defence-in-depth backstop (Decision 4).
- [x] 2.5 Decide between (a) a projection interface like `FeedItemView { UUID getPostId(); UUID getAuthorId(); String getAuthorDisplayName(); String getBody(); OffsetDateTime getCreatedAt(); }` returned by the `@Query`, or (b) returning `FeedEntry` and a separate `Post` lookup. Pick (a) — Decision 5 wants the single-round-trip path. Document the choice in the repository class javadoc.

## 3. Backend: `feed/FeedFanoutService.java`

- [x] 3.1 Create `feed/FeedFanoutService.java` annotated `@Service` and `@Transactional(propagation = Propagation.MANDATORY)` at the class level. Inject `JdbcTemplate` (or `NamedParameterJdbcTemplate`) so the four maintenance statements can be expressed as direct SQL rather than entity-by-entity JPA inserts (decision: bulk SQL is the only way to keep these statements one round trip each).
- [x] 3.2 Implement `void onPostCreated(Post post)`. SQL:
  ```
  INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
  SELECT follower_id, :postId, :authorId, :createdAt
    FROM follows WHERE followee_id = :authorId
  UNION ALL
  SELECT :authorId, :postId, :authorId, :createdAt
  ON CONFLICT (recipient_id, post_id) DO NOTHING;
  ```
  Parameter binding via `MapSqlParameterSource`.
- [x] 3.3 Implement `void onPostDeleted(UUID postId)`. SQL: `DELETE FROM feed_entries WHERE post_id = :postId`. No return value.
- [x] 3.4 Implement `void onFollow(UUID followerId, UUID followeeId)`. SQL:
  ```
  INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
  SELECT :followerId, p.id, p.author_id, p.created_at
    FROM posts p
   WHERE p.author_id = :followeeId AND p.deleted_at IS NULL
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 100
  ON CONFLICT (recipient_id, post_id) DO NOTHING;
  ```
- [x] 3.5 Implement `void onUnfollow(UUID followerId, UUID followeeId)`. SQL: `DELETE FROM feed_entries WHERE recipient_id = :followerId AND author_id = :followeeId`.
- [x] 3.6 Confirm `@Transactional(propagation = MANDATORY)` causes a call without an enclosing transaction to fail with `IllegalTransactionStateException`. Add an IT case `feedFanoutService_outsideTransaction_throws` that asserts this.

## 4. Backend: integrate fanout into `PostService` and `FollowService`

- [x] 4.1 Modify `backend/src/main/java/com/prodready/social/posts/PostService.java` `create(...)` so that after the new `Post` is saved and flushed (so `post.getId()` and `post.getCreatedAt()` are populated), the method calls `feedFanoutService.onPostCreated(post)`. The whole method is already `@Transactional`; verify it is and add the annotation if absent.
- [x] 4.2 Modify `PostService.delete(...)` so that after the soft-delete UPDATE is applied, the method calls `feedFanoutService.onPostDeleted(postId)`. Same transaction.
- [x] 4.3 Modify `backend/src/main/java/com/prodready/social/follows/FollowService.java` `follow(...)` so that after the `follows` insert (the idempotent path — both the "row was inserted" and "row already existed" branches), the method calls `feedFanoutService.onFollow(callerId, targetId)`. The `ON CONFLICT` in the backfill SQL handles the re-follow case (entries already present stay).
- [x] 4.4 Modify `FollowService.unfollow(...)` so that after the `follows` delete (the idempotent path — both branches), the method calls `feedFanoutService.onUnfollow(callerId, targetId)`. Self-unfollow remains a 204 and the scrub correctly affects zero rows (the recipient `(callerId, callerId)` filter combined with self-fanout would have produced rows where `author_id = callerId`, which IS what we want to keep — own posts stay even if the user "unfollows themselves" — verify the scrub is correctly scoped to `author_id = :targetId` and does NOT delete self-fanout rows when `callerId == targetId`. The self-unfollow case is `recipient_id = callerId AND author_id = callerId`, which deletes the caller's own self-fanout rows, which is WRONG.). → Implementation: short-circuit the scrub when `followerId.equals(followeeId)` because the self-fanout invariant requires `(self, self)` rows to remain. Add a test that proves self-unfollow does NOT scrub the caller's own posts from their feed.
- [x] 4.5 Inject `FeedFanoutService` into `PostService` and `FollowService` via constructor injection. Update each service's tests' constructors / `@MockBean` setups accordingly.

## 5. Backend: `FeedService` + `FeedController`

- [x] 5.1 Create `feed/FeedService.java` annotated `@Service @Transactional(readOnly = true)`. Inject `FeedEntryRepository` and `PostCursorCodec`. Implement `PostListResponse findPage(UUID callerId, String cursor, Integer limit)`:
  - parse `cursor` via `PostCursorCodec.decode(cursor)` if non-null (throws `InvalidCursorException` on malformed);
  - clamp `limit` to `[1, 50]` with default `20`;
  - call `feedEntryRepository.findPage(callerId, asOfCreatedAt, asOfPostId, limit + 1)`;
  - if more than `limit` rows returned, peel off the (limit+1)-th to compute `nextCursor = PostCursorCodec.encode(lastReturned.createdAt, lastReturned.postId)`;
  - assemble `PostResponse[]` from the projection rows;
  - return `new PostListResponse(items, nextCursor)`.
- [x] 5.2 Create `feed/FeedController.java` annotated `@RestController @RequestMapping("/api/v1") @SecurityRequirement(name = "bearerAuth")`. Inject `FeedService`. Carry a private `requirePrincipal(principal)` helper identical to `PostsController.requirePrincipal`.
- [x] 5.3 `@GetMapping("/feed")`: `@Operation(operationId = "getFeed", summary = "Authenticated caller's home feed (posts by people they follow + their own)")`. `@ApiResponses` covering 200 (`PostListResponse`), 400 (`ProblemDetail`), 401 (`ProblemDetail`). Handler signature: `public ResponseEntity<PostListResponse> getFeed(@AuthenticationPrincipal UserPrincipal principal, @RequestParam(value = "cursor", required = false) String cursor, @RequestParam(value = "limit", required = false) Integer limit)`. Body: `UUID callerId = requirePrincipal(principal).id(); return ResponseEntity.ok(feedService.findPage(callerId, cursor, limit));`.
- [x] 5.4 Confirm `SecurityFilterChain` already authenticates `/api/v1/**` and the new path requires authentication (no allowlist entry).
- [x] 5.5 Confirm `InvalidCursorException` already translates to `400 ProblemDetail` via the existing global handler (`PostsController` already relies on this). No new exception class.

## 6. Backend: `FeedFanoutService` rebuild helper for IT invariant

- [x] 6.1 Add a package-private `void rebuild()` method to `FeedFanoutService` (annotated `@Transactional(propagation = MANDATORY)`, or split into a separate `@Service FeedRebuilder` — pick based on whether `PROPAGATION_MANDATORY` is too aggressive for the IT helper. Recommendation: a sibling `FeedRebuilder` with its own `@Transactional`.). The method runs:
  ```
  TRUNCATE feed_entries;
  INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
  SELECT f.follower_id, p.id, p.author_id, p.created_at
    FROM follows f JOIN posts p ON p.author_id = f.followee_id
   WHERE p.deleted_at IS NULL
  UNION
  SELECT p.author_id, p.id, p.author_id, p.created_at
    FROM posts p WHERE p.deleted_at IS NULL;
  ```
- [x] 6.2 Note in the class javadoc that `rebuild()` is invariant-test infrastructure, NOT a production code path, and the test that proves the equality (task 7.5) is the only caller.

## 7. Backend: Testcontainers integration tests

- [x] 7.1 Create `backend/src/test/java/com/prodready/social/feed/FeedControllerIT.java` extending the existing IT base (`PostgresIT` or whatever class `PostsControllerIT` / `FollowsControllerIT` extend). Inject `JdbcTemplate` so cases can read `feed_entries` directly.
- [x] 7.2 Helper: seed Alice and Bob (signup + login + capture tokens + ids), reuse the existing `useraccounts` test helpers.
- [x] 7.3 Cases — read path:
  - 7.3.a `getFeed_brandNewUser_returnsEmpty` — fresh user, no posts, no follows. `GET /api/v1/feed` → 200 `{items: [], nextCursor: null}`.
  - 7.3.b `getFeed_selfFanout_returnsOwnPostsEvenWithNoFollows` — Alice signs up, posts twice via API, calls `getFeed` with her token → 200 with two items in `(created_at DESC, post_id DESC)` order.
  - 7.3.c `getFeed_followThenAuthor_returnsBackfilledPosts` — Alice signs up + posts 3 times → Bob signs up → Bob follows Alice → Bob `getFeed` returns Alice's 3 posts (Bob has zero own posts).
  - 7.3.d `getFeed_forwardFanoutAfterFollow` — Bob follows Alice → Alice posts a NEW post via API → Bob `getFeed` returns Alice's new post at the top.
  - 7.3.e `getFeed_excludesSoftDeleted` — Bob follows Alice, Alice posts P1, P2; Alice soft-deletes P1; Bob `getFeed` returns only P2.
  - 7.3.f `getFeed_unfollowScrubs` — Bob follows Alice, Alice has 3 posts in Bob's feed; Bob unfollows Alice; Bob `getFeed` returns Bob's own posts only (zero if he has none).
  - 7.3.g `getFeed_selfUnfollowDoesNotScrubOwnPosts` — Alice has 2 posts (self-fanout rows in `feed_entries` where `recipient_id = author_id = aliceId`). Alice calls `DELETE /api/v1/users/{aliceId}/follow`. Alice's `getFeed` STILL returns her 2 posts. This proves task 4.4's short-circuit.
  - 7.3.h `getFeed_cursorPagination_walksMultiAuthor` — seed: Alice 11 posts + Bob 10 posts; Bob follows Alice → Bob has 21 feed entries. Walk with `limit=10`: page 1 = 10 items + `nextCursor`; page 2 = 10 items + `nextCursor`; page 3 = 1 item + `nextCursor: null`. The assembled bodies equal the seeded set; the order is `(created_at DESC, post_id DESC)`.
  - 7.3.i `getFeed_backfillCap_respected` — Alice signs up, posts 105 times sequentially (each timestamped distinctly); Bob signs up; Bob follows Alice. Exactly 100 entries exist in `feed_entries` for Bob, and they are Alice's 100 most-recent posts.
  - 7.3.j `getFeed_refollowIdempotent` — Bob follows Alice (3 backfilled entries) → Bob unfollows (0 entries) → Bob follows again (3 entries, identical to first follow). Assert via direct `feed_entries` read that the rows are the same.
  - 7.3.k `getFeed_malformedCursor_returns400` — `GET /api/v1/feed?cursor=not-base64url-something` → 400 + `ProblemDetail`.
  - 7.3.l `getFeed_unauthenticated_returns401` — `GET /api/v1/feed` with no Authorization → 401 + `ProblemDetail`.
- [x] 7.4 Cases — write-path invariants (read `feed_entries` directly via `JdbcTemplate`, no HTTP):
  - 7.4.a `onPostCreated_fansOutToFollowersAndSelf` — Bob follows Alice; Alice posts P1; assert `feed_entries` contains exactly two rows: `(bobId, aliceP1id, aliceId, …)` and `(aliceId, aliceP1id, aliceId, …)`.
  - 7.4.b `onPostDeleted_scrubsAllRecipients` — Alice posts P1 (fans out to herself and Bob); Alice soft-deletes P1; assert `feed_entries` contains zero rows referencing `P1id`.
  - 7.4.c `onFollow_backfillsBoundedAt100` — Alice has 105 posts; Bob follows; assert exactly 100 rows in `feed_entries` for Bob; row set equals Alice's 100 most-recent post ids.
  - 7.4.d `onUnfollow_scrubsRecipientByAuthor` — Bob follows Alice (rows seeded); Bob follows Carol (rows seeded); Bob unfollows Alice; assert `feed_entries` for Bob now contains Carol's posts and Bob's own self-fanout rows, but no Alice rows.
- [x] 7.5 Invariant case: `feedEntries_equalsRebuild_acrossOperations`.
  - Seed: Alice, Bob, Carol; Alice has 3 posts (one soft-deleted); Bob follows Alice; Bob follows Carol; Carol has 2 posts; Bob unfollows Carol; Alice posts P4.
  - Snapshot the contents of `feed_entries` (recipient_id, post_id, author_id, created_at) into a set.
  - Call `feedRebuilder.rebuild()` (which truncates and reinserts from `(posts, follows)`).
  - Snapshot the contents of `feed_entries` again.
  - Assert the two snapshots are equal as sets.
- [x] 7.6 Outside-transaction guardrail case: `feedFanoutService_outsideTransaction_throws` — call any of the four helper methods without an enclosing `@Transactional`. Assert `IllegalTransactionStateException` (or whatever Spring raises for `PROPAGATION_MANDATORY`).

## 8. Backend: extend existing IT suites for the fanout invariants

- [x] 8.1 Modify `backend/src/test/java/com/prodready/social/posts/PostsControllerIT.java` to add:
  - 8.1.a `create_fansOutToFollowersAndSelf` (mirror 7.4.a, but exercising the HTTP `POST /api/v1/posts` path so the fanout is proven through the controller, not through `FeedFanoutService` directly).
  - 8.1.b `delete_scrubsFeedEntries` (mirror 7.4.b, but exercising `DELETE /api/v1/posts/{id}`).
- [x] 8.2 Modify `backend/src/test/java/com/prodready/social/follows/FollowsControllerIT.java` to add:
  - 8.2.a `follow_backfillsRecipientFeedCapped` (mirror 7.4.c, but exercising `POST /api/v1/users/{userId}/follow`).
  - 8.2.b `unfollow_scrubsRecipientFeedForAuthor` (mirror 7.4.d, but exercising `DELETE /api/v1/users/{userId}/follow`).
  - 8.2.c `selfUnfollow_doesNotScrubOwnPosts` (mirror 7.3.g via HTTP DELETE).

## 9. API contract: regenerate `openapi.json` and Orval client surfaces

- [x] 9.1 Refresh `openapi/openapi.json` via the repo's existing snapshot-generation task (the same one `add-follows` used — `./gradlew generateOpenApiDocs --no-configuration-cache`).
- [x] 9.2 Verify the regenerated snapshot includes:
  - path `/api/v1/feed` with `get` operation declaring 200 / 400 / 401 responses;
  - the response 200 body schema is `PostListResponse` (referenced not redefined).
- [x] 9.3 Run Orval against the refreshed snapshot. Confirm:
  - `frontend/src/api/generated/feed-controller/feed-controller.ts` exists with `useGetFeed`, `getFeed` (the typed fetch), `getGetFeedUrl`, `getGetFeedQueryKey`;
  - `e2e/src/api/generated/feed-controller/feed-controller.ts` exists with the same URL helper.
- [x] 9.4 If the existing CI drift check reports any unexpected diff (e.g. operation re-ordering inside an existing controller), reconcile by re-running the snapshot generator and committing the freshly-deterministic output.

## 10. Frontend: `FeedList` component + tests

- [x] 10.1 Create `frontend/src/features/feed/FeedList.tsx` consuming `useInfiniteQuery({ queryKey: getGetFeedQueryKey(), queryFn: ({ pageParam }) => getFeed(pageParam ? { cursor: pageParam as string } : undefined), initialPageParam: undefined, getNextPageParam: (lastPage) => extractPage(lastPage)?.nextCursor ?? undefined })`. Mirror `PostList`'s structure for the loading / error / empty / populated / `Load more` rendering branches.
- [x] 10.2 Each rendered post uses `<PostCard post={post} onDeleteSuccess={onFeedItemDeleted} />` where `onFeedItemDeleted = () => queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() })`.
- [x] 10.3 Create `frontend/src/features/feed/FeedList.test.tsx` with cases (each `it()` or `test()`):
  - 10.3.a "empty state renders" — MSW returns `{items: [], nextCursor: null}`; assert empty-state copy (the same string `PostList` uses).
  - 10.3.b "single page renders with N PostCards" — MSW returns 3 items, no cursor; assert 3 `role=article` with name `Post`.
  - 10.3.c "two-page pagination walks via Load more" — MSW returns page 1 (20 items, `nextCursor: "c1"`) → click `Load more` → MSW returns page 2 (5 items, `nextCursor: null`); assert 25 articles after the click, `Load more` removed.
  - 10.3.d "error state renders alert" — MSW returns 500 (or rejects); assert `role=alert` with the error copy.
  - 10.3.e "delete-from-feed invalidates the feed query" — set up MSW so `getFeed` is called twice, second response has one fewer item; click the delete button on a card; MSW responds 204 to `DELETE /api/v1/posts/{id}`; assert the feed re-fetches and the deleted post is gone.

## 11. Frontend: rewire `HomePage` + tests

- [x] 11.1 Modify `frontend/src/features/home/HomePage.tsx` to import `FeedList` from `@/features/feed/FeedList` and replace `<PostList userId={userId} />` with `<FeedList />`. The composer's `authorUserId={userId}` and the welcome card stay.
- [x] 11.2 Modify `frontend/src/features/home/HomePage.test.tsx` (or whichever file owns HomePage tests; create one if absent):
  - assert `<FeedList />` mounts (e.g. by mocking `getFeed` and asserting an item appears);
  - assert NO request to `GET /api/v1/users/{currentUserId}/posts` is fired (the prior per-author list query has been removed).

## 12. Frontend: `PostCard` callback refactor + tests

- [x] 12.1 Modify `frontend/src/features/posts/PostCard.tsx`:
  - remove `listOwnerId: string` prop;
  - add `onDeleteSuccess: () => void` prop;
  - replace the embedded `queryClient.invalidateQueries({ queryKey: postsByAuthorListKeyPrefix(listOwnerId) })` with `onDeleteSuccess()`;
  - the delete mutation's `useDeletePost({ mutation: { onSuccess: () => onDeleteSuccess() } })` is the only side-effect.
- [x] 12.2 Modify `frontend/src/features/posts/PostCard.test.tsx`:
  - replace any `listOwnerId` props with `onDeleteSuccess: vi.fn()`;
  - add a case asserting that after the delete mutation resolves 204, `onDeleteSuccess` is invoked exactly once;
  - confirm `PostCard` no longer touches `queryClient` directly — strip any `QueryClientProvider` setup that is now unnecessary (or keep it minimal — only what the mutation hook needs).
- [x] 12.3 Modify `frontend/src/features/posts/PostList.tsx` to pass `onDeleteSuccess={() => queryClient.invalidateQueries({ queryKey: postsByAuthorListKeyPrefix(userId) })}` to each rendered `PostCard`.
- [x] 12.4 Modify `frontend/src/features/posts/PostList.test.tsx`:
  - confirm the prior delete-then-refetch test still passes against the parent-supplied callback (the invalidation now originates in `PostList`, not `PostCard`);
  - confirm `listOwnerId` removal does not break any test setup.

## 13. Frontend: `ProfilePage` feed-invalidation + tests

- [x] 13.1 Modify `frontend/src/features/profile/ProfilePage.tsx` follow / unfollow mutations:
  - on `onSuccess` of both mutations, in addition to invalidating `getGetFollowStatsQueryKey(userId)`, also invalidate `getGetFeedQueryKey()`.
  - import `getGetFeedQueryKey` from `@/api/generated/queries/feed-controller/feed-controller`.
- [x] 13.2 Modify `frontend/src/features/profile/ProfilePage.test.tsx` (or its follows-side sibling):
  - 13.2.a "clicking Follow also invalidates the feed query" — set up MSW such that `getFeed` is called once on mount of a sibling component, then once again after the follow mutation. The simplest assertion is to spy on `queryClient.invalidateQueries` and assert it was called with the feed query key.
  - 13.2.b "clicking Unfollow also invalidates the feed query" — mirror image.

## 14. E2E: `apiClient.getFeed` helper

- [x] 14.1 Modify `e2e/src/helpers/apiClient.ts`:
  - import `getGetFeedUrl` from `e2e/src/api/generated/feed-controller/feed-controller.ts`;
  - import the generated `PostListResponse` type;
  - add `GetFeedResult { status: number; body: PostListResponse | ProblemDetail }`;
  - add method `getFeed(token: string, params?: { cursor?: string; limit?: number }): Promise<GetFeedResult>`. Builds the URL via `getGetFeedUrl(params ?? {})` (verify Orval's URL-helper signature; pass the params object as Orval emits it). Sends `Authorization: Bearer <token>` and `Accept: application/json, application/problem+json`.
- [x] 14.2 Confirm the helper imports from the generated URL-helper module and does NOT hardcode the path string.

## 15. E2E: `e2e/tests/feed.spec.ts`

- [x] 15.1 Create `e2e/tests/feed.spec.ts` with two top-level `test.describe` blocks: "UI vertical" and "API edges".
- [x] 15.2 UI vertical `test()` — "Bob's home feed reflects follow / unfollow of Alice":
  - sign up Alice via `apiClient.signup(randomSignupInput())`; capture `aliceId`, `aliceToken`;
  - Alice posts 2 posts via `apiClient.createPost(aliceToken, ...)` in sequence so timestamps are distinct;
  - sign up Bob via `apiClient.signup(randomSignupInput())`; capture `bobId`, `bobToken`;
  - Bob composes 1 post via the SPA (`loginAndLandOnHome(page, bobInput)` then submit composer);
  - assert Bob's `/home` shows exactly 1 `PostCard` (his own);
  - navigate to `/users/{aliceId}`; click Follow;
  - navigate back to `/home`;
  - assert Bob's `/home` shows 3 `PostCard`s in `(created_at DESC, post_id DESC)` order; the topmost article's body matches Alice's newest seeded body;
  - Alice posts a new third post via `apiClient.createPost(aliceToken, { body: 'fresh post' })`;
  - reload `/home` (Bob's session); assert 4 articles; topmost body is `fresh post`;
  - navigate to `/users/{aliceId}`; click Unfollow;
  - navigate back to `/home`; assert Bob's `/home` shows 1 `PostCard` (his own only).
- [x] 15.3 API-edges block:
  - 15.3.a `test('brand-new user gets empty feed via API')` — fresh signup; `getFeed(token)` → `{status: 200, body: {items: [], nextCursor: null}}`.
  - 15.3.b `test('self-fanout: a fresh user authoring a post via SPA sees it via apiClient.getFeed')` — signup Alice; SPA-compose one post via the composer; `apiClient.getFeed(aliceToken)` returns 1 item whose body matches.
  - 15.3.c `test('cursor pagination walks a 21-post multi-author feed across two pages')` — Alice posts 11; Bob posts 10; Bob follows Alice; `apiClient.getFeed(bobToken, { limit: 20 })` → 20 items + `nextCursor` set; `getFeed(bobToken, { cursor: nextCursor, limit: 20 })` → 1 item + `nextCursor: null`. Assembled body set equals the 21-post seed.
  - 15.3.d `test('malformed cursor returns 400 + ProblemDetail')` — `getFeed(aliceToken, { cursor: 'not-base64url-something' })` → 400 + `ProblemDetail` with `status: 400`.
  - 15.3.e `test('unauthenticated returns 401')` — bypass the apiClient helper (which always sends Bearer) and `fetch` the URL directly with no `Authorization` header; assert 401 + `ProblemDetail`.
  - 15.3.f `test('re-follow idempotency: feed contains followee posts exactly once')` — Bob follows → unfollows → follows Alice (who has 3 posts); `apiClient.getFeed(bobToken)` returns Alice's 3 posts exactly once (body set has length 3, no duplicates).

## 16. E2E: extend axe-routes with a populated `/home`

- [x] 16.1 Modify `e2e/tests/axe.routes.spec.ts` to seed a follow + cross-author posts before the `/home` axe scan. Sign up Alice + Bob; Alice posts 2 posts via `apiClient`; Bob follows Alice via `apiClient.follow(bobToken, aliceId)`; Bob composes 1 post via the SPA; assert (before scan) that `/home` shows 3 `PostCard`s.
- [x] 16.2 Run `runAxeScan` on `/home` (with the populated feed) and assert no violations. Reuse the existing `runAxeScan` fixture.
- [x] 16.3 Keep the spec a single `test()` walking the routes sequentially — do not split into multiple `test()`s.

## 17. Spec sync, validate, format

- [x] 17.1 Confirm `openspec/changes/add-home-feed/specs/feed/spec.md`, `openspec/changes/add-home-feed/specs/posts/spec.md`, `openspec/changes/add-home-feed/specs/follows/spec.md`, `openspec/changes/add-home-feed/specs/user-profile/spec.md` reflect the implementation as shipped. Adjust any drift before opening the PR.
- [x] 17.2 Run `openspec validate add-home-feed --strict` and resolve any errors.
- [x] 17.3 Run the backend formatter (`./gradlew :backend:spotlessApply` or whichever task the project uses), the frontend formatter (`pnpm --dir frontend format` / prettier), and the e2e formatter. Confirm the diff is clean.

## 18. Full-suite smoke

- [x] 18.1 Run `./gradlew :backend:test` and confirm `FeedControllerIT` passes, the extended `PostsControllerIT` and `FollowsControllerIT` cases pass, and no existing IT regressed under the new migration / fanout invariants.
- [x] 18.2 Run `pnpm --dir frontend test` and confirm the new `FeedList.test.tsx`, the rewired `HomePage.test.tsx`, and the modified `PostCard` / `PostList` / `ProfilePage` tests all pass. Confirm no other `frontend/src/features/posts/*.test.tsx` files broke under the `PostCard` prop change.
- [x] 18.3 Run `pnpm --dir e2e test` on Chromium, Firefox, and WebKit. Confirm `feed.spec.ts` passes on all three. Confirm `axe.routes.spec.ts` still passes with the populated `/home` step. If the known `posts.composer.hardening` Firefox flake fires, re-run only.

## 19. PR

- [x] 19.1 Open a PR titled `add-home-feed`. Body links to the proposal and design.
- [x] 19.2 Call out in the description:
  - (a) one new endpoint `GET /api/v1/feed`;
  - (b) one new migration `V5__create_feed_entries.sql` introducing a materialised, fanout-on-write feed table;
  - (c) write-side fanout invariants added to `PostService.create`, `PostService.delete`, `FollowService.follow`, `FollowService.unfollow` — all in their existing transactions;
  - (d) `PostCard`'s `listOwnerId` prop is replaced with `onDeleteSuccess` callback — this is the only contract change to an existing component;
  - (e) `HomePage` now renders `<FeedList />` instead of `<PostList userId={currentUserId} />`;
  - (f) `ProfilePage` follow / unfollow mutations additionally invalidate the feed query key;
  - (g) no new dependencies; no new CI jobs;
  - (h) async fanout, hybrid push/pull for celebrity authors, realtime push, and per-recipient row caps are explicit non-goals (see proposal).
