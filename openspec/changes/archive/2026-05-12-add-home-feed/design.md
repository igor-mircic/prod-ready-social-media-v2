## Context

Code state verified against the tree at change-draft time:

- `backend/src/main/resources/db/migration/` contains exactly
  `V1__create_users.sql`, `V2__create_auth_tokens.sql`,
  `V3__create_posts.sql`, `V4__create_follows.sql`. The next
  migration number is `V5`.
- `backend/src/main/java/com/prodready/social/posts/Post.java`
  carries the canonical "cross-aggregate reference by UUID" rule
  (no `@ManyToOne User author`).
- `backend/src/main/java/com/prodready/social/posts/PostsController.java`
  is the convention this change's `FeedController` follows
  (`@RestController @RequestMapping("/api/v1")
  @SecurityRequirement(name = "bearerAuth")` + method-level
  `@GetMapping("/feed")`).
- `backend/src/main/java/com/prodready/social/posts/PostService.java`
  owns post create / soft-delete and is the integration point for
  the fanout-on-create and scrub-on-delete invariants.
- `backend/src/main/java/com/prodready/social/follows/FollowService.java`
  owns follow / unfollow and is the integration point for the
  backfill-on-follow and scrub-on-unfollow invariants. The existing
  follow / unfollow methods are already `@Transactional` (verify at
  implementation time and adjust if not) — the fanout helper relies
  on this.
- `backend/src/main/java/com/prodready/social/posts/PostCursorCodec.java`
  is the existing cursor codec (`[version-byte] [millis-8B]
  [uuid-16B]`). The feed reuses it; no new codec is introduced.
- `frontend/src/features/home/HomePage.tsx` currently renders
  `<PostList userId={userId} />` after `<PostComposer />`. The
  rewire is one line.
- `frontend/src/features/posts/PostCard.tsx` holds the embedded
  delete-invalidation logic that this change generalises into a
  parent-supplied `onDeleteSuccess` callback.
- `frontend/src/features/profile/ProfilePage.tsx` holds the follow /
  unfollow mutations whose `onSuccess` this change extends to also
  invalidate the feed query key.
- `e2e/src/helpers/apiClient.ts` already exposes `signup`, `login`,
  `getUser`, `createPost`, `deletePost`, `listPostsByAuthor`,
  `follow`, `unfollow`, `getFollowStats`. The new `getFeed` method
  follows the same pattern (generated URL helper + bearer header +
  `{status, body}` shape).
- The committed `openapi/openapi.json` snapshot has CI drift
  checking; regenerating it after adding `FeedController` is part of
  the change.

## Goals / Non-Goals

**Goals:**

- Introduce a materialised, fanout-on-write home feed via a new
  `feed_entries` table that is eagerly maintained on every relevant
  write (post create, post soft-delete, follow, unfollow).
- The home read (`GET /api/v1/feed`) is a single keyset-paginated
  query against `feed_entries` joined to `posts` — no traversal of
  `follows` at read time.
- Reuse the existing `PostResponse` / `PostListResponse` / cursor
  codec so the wire shape on the feed endpoint is indistinguishable
  from the per-author list endpoint.
- Encode the fanout invariants in one helper (`FeedFanoutService`),
  not scattered across `PostService` and `FollowService`. Make the
  helper fail loudly if invoked outside a transaction
  (`PROPAGATION_MANDATORY`).
- Preserve the public HTTP contracts of `POST /api/v1/posts`,
  `DELETE /api/v1/posts/{id}`, `POST /api/v1/users/{userId}/follow`,
  and `DELETE /api/v1/users/{userId}/follow`. Fanout is a write-
  side side-effect; the response codes and bodies do not change.
- Verify the write contracts directly (read `feed_entries` rows in
  IT, assert membership) AND the end-to-end contract via the read
  endpoint (assert what shows up on `GET /api/v1/feed`). Both
  layers tested so a future refactor of the read path doesn't hide
  a regression in the write path (or vice versa).

**Non-Goals:**

- Async / queued fanout. Synchronous in the post-create transaction.
- Hybrid push / pull for celebrity authors. Single uniform fanout
  path.
- Realtime push (WebSocket / SSE / long-poll).
- Server-side ranking, "for you" reordering, recency decay, mute,
  unread state, per-author dedupe / capping per page.
- A per-recipient row-count cap on `feed_entries` (e.g. trim oldest
  beyond 1000). Documented as a follow-up.
- A rebuild HTTP / admin endpoint. The rebuild SQL is documented in
  this file (Decision 9) and tested as a set-equality invariant in
  IT.
- Explore / global timeline.
- Soft-deleted-post tombstones in the feed.
- Per-recipient indicator fields (`viewerFollows`, etc.) inside
  `PostResponse`.
- Likes / comments / reposts / mentions.

## Decisions

### Decision 1: Fanout-on-write materialised `feed_entries` table is the architecture

The feed SHALL be served from a denormalised, per-recipient
`feed_entries` table maintained eagerly on every relevant write
(post create, post soft-delete, follow, unfollow). The read path
SHALL NOT traverse `follows` at request time.

**Why fanout, when read-time merge would work at toy scale?** This
codebase is explicitly framed as a vehicle for production-grade
patterns. The trapdoor between "read-time merge against
`posts JOIN follows`" and "materialised feed" is the textbook
social-feed scaling story; picking the materialised side exercises
the real consistency, idempotency, and rebuild questions a
production team would design through. A read-time merge plan would
collapse those questions into "the planner figures it out" and
defer all the interesting design until later.

**Why is it acceptable here even though the latency / throughput
budget doesn't demand it?** The implementation complexity is
front-loaded onto write paths that are already well-bounded (post
create, follow / unfollow are user-driven, low-frequency events at
this stack's scale). The read path becomes structurally simpler
(one keyset query against one index). The increase in surface area
is paid by the integration tests, which become richer — but those
tests are themselves the learning value.

**Rejected alternative — read-time `IN`-merge.** A `WHERE
p.author_id IN (SELECT followee_id FROM follows WHERE follower_id =
:me UNION SELECT :me)` against the existing
`posts_author_created_idx` works, and is what an MVP would ship.
Rejected because (a) it doesn't exercise the fanout pattern this
project is learning about, and (b) the celebrity / large-IN-list
plan question is a non-trivial Postgres detail that we'd rather meet
on a future hybrid-pull path than dodge entirely.

### Decision 2: Table shape — composite PK `(recipient_id, post_id)` plus denormalised `author_id` and `created_at`

`feed_entries` schema:

```
recipient_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
post_id       UUID         NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
author_id     UUID         NOT NULL,
created_at    TIMESTAMPTZ  NOT NULL,
PRIMARY KEY (recipient_id, post_id)
```

Plus two secondary indexes (Decision 3).

**Why `(recipient_id, post_id)` as the PK?** The PK is the natural
key of the relation "this recipient should see this post." It
dedupes the (recipient, post) pair so re-fanout / re-backfill /
retry are idempotent via `ON CONFLICT (recipient_id, post_id) DO
NOTHING`. Putting `post_id` second in the PK (not `created_at`) is
deliberate: changes to `posts.created_at` (which can't happen today,
but: a future "edit post" feature might) wouldn't break the PK.

**Why denormalise `author_id`?** The unfollow scrub is `DELETE FROM
feed_entries WHERE recipient_id = :me AND author_id = :target`.
Without the denormalised column, that delete would need a join to
`posts`. The denormalisation costs a UUID per row and frees the
hot scrub from any join.

**Why denormalise `created_at`?** The read query orders by `(created_at
DESC, post_id DESC)`. Without denormalisation, that ordering would
need a join to `posts`. The denormalisation costs a 12-byte
timestamp per row and frees the hot read from any join in the
ordering path. The read query DOES still join `posts` to get the
post body — but the join happens *after* the ordered keyset slice,
on at most `limit` rows.

**Why CASCADE on both FKs?** A user delete cascades into their own
`feed_entries` (as recipient) and into all `feed_entries`
referencing posts by them as author (via the `posts` row cascade);
this is the right policy for the day account deletion ships. A post
delete (hard, not soft) cascades into all `feed_entries` for that
post; this is the right policy for the rebuild semantics. Soft-
delete of a post is handled by the explicit scrub in the helper
(Decision 4), not via the FK.

**Why no surrogate `id UUID` PK?** A `feed_entries` row has no
external identity. No other table references it. No `/api/v1/
feed-entries/{id}` endpoint exists or will exist. The natural key
*is* the identity, exactly like `follows` (Decision 1 of
`add-follows`).

### Decision 3: Two secondary indexes — read path and unfollow-scrub

Beyond the PK, two secondary indexes:

```
CREATE INDEX feed_entries_read_idx
  ON feed_entries (recipient_id, created_at DESC, post_id DESC);

CREATE INDEX feed_entries_author_idx
  ON feed_entries (recipient_id, author_id);
```

**Why `feed_entries_read_idx`?** Backs the hot read query:

```sql
SELECT * FROM feed_entries
 WHERE recipient_id = :me
   AND (created_at, post_id) < (:asOfCreatedAt, :asOfPostId)
 ORDER BY created_at DESC, post_id DESC
 LIMIT :limit + 1;
```

Postgres uses this as a single ordered index scan: positional
filter on `recipient_id`, keyset cut on `(created_at, post_id)`,
and ordered output that matches the index ordering — no sort, no
heap touch until the limit slice is taken.

**Why `feed_entries_author_idx`?** Backs the unfollow scrub:

```sql
DELETE FROM feed_entries
 WHERE recipient_id = :me AND author_id = :target;
```

Without this index, the scrub would seq-scan the recipient's slice
of `feed_entries` (acceptable for small slices, painful for users
with deep feeds). The index turns it into an index lookup. The
delete then walks the matching rows.

**Why NOT a single composite `(recipient_id, author_id, created_at
DESC, post_id DESC)` covering both?** Two reasons:

1. The read query doesn't filter on `author_id`; carrying it in
   the index inflates every page-read's index walk for no benefit.
2. The unfollow scrub doesn't need `created_at`; a smaller index
   on `(recipient_id, author_id)` is cheaper to maintain on every
   insert / delete.

Two purpose-built indexes are cheaper at write time and faster at
read time than one over-broad composite.

**Why NOT a partial `WHERE` predicate on the read index (e.g.
mirroring `posts_author_created_idx`'s `WHERE deleted_at IS
NULL`)?** Because `feed_entries` does not carry a `deleted_at`
column — soft-deleted posts are scrubbed eagerly (Decision 4), so
every live `feed_entries` row is, by invariant, visible. A partial
predicate would be redundant.

### Decision 4: Soft-delete of a post eagerly scrubs `feed_entries`

When `PostService.delete(postId)` sets `posts.deleted_at = now()`,
the same transaction SHALL run `DELETE FROM feed_entries WHERE
post_id = :postId`.

**Why eager scrub instead of read-side filtering by `posts.deleted_at`?**

- **Read hot-path stays index-only on `feed_entries`.** A read-side
  filter on `posts.deleted_at IS NULL` would require joining `posts`
  *before* the keyset slice (to know whether to keep a row), or
  over-fetching and post-filtering, or maintaining the predicate
  in the index. All are worse than scrubbing on write.
- **Invariant is local and obvious.** "If a row exists in
  `feed_entries`, the referenced post is live." A future reader of
  the read query doesn't need to remember a soft-delete predicate.
- **Cost is paid where it belongs.** Post deletion is rarer than
  feed reads. Doing the work on delete amortises across many reads.

**Defence in depth.** The read query SHALL nonetheless include
`WHERE p.deleted_at IS NULL` when it joins `posts`. If a future bug
ever leaves a `feed_entries` row pointing at a soft-deleted post,
the read will silently drop it rather than rendering it. This is a
guardrail, not the load-bearing filter.

### Decision 5: Read path joins `posts` after the keyset slice; entity returned, response assembled in `FeedService`

`FeedEntryRepository.findPage(...)` SHALL return a slice of
`feed_entries` rows (limited to `limit + 1` for nextCursor detection)
joined to `posts` and `users` so the result row carries everything
needed to build a `PostResponse`. `FeedService.findPage(...)` SHALL
assemble the `PostListResponse` from those rows.

**Why the join in the repository, not in the service?** One round
trip vs. one-plus-N. If the service did the keyset query and then
loaded posts in a second query, every page render is two round
trips. If it did N+1, the cost is O(page-size) extra round trips.
Both are worse than one join.

**Why return entities / a row-projection DTO and assemble in
service?** Keeping the controller boring: it returns whatever
service hands it. Keeping the service the place where wire-format
choices live (e.g. cursor encoding, empty-page semantics) means the
controller doesn't grow conditional logic. This mirrors how
`PostsController` -> `PostService` is structured for
`listPostsByAuthor`.

**Cursor decode at request entry.** `FeedController` decodes the
incoming `?cursor=...` via `PostCursorCodec.decode(cursor)`, throws
`InvalidCursorException` on failure (the existing global handler
maps this to `400 ProblemDetail`), and passes the decoded
`(createdAt, postId)` to the service. The service issues the
keyset query and encodes `nextCursor` from the (n+1)-th row if
present.

### Decision 6: Backfill cap is 100 most-recent non-deleted posts; synchronous in the follow transaction

`FollowService.follow(callerId, targetId)` SHALL run, in the same
transaction as the `follows` insert:

```sql
INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
SELECT :callerId, p.id, p.author_id, p.created_at
  FROM posts p
 WHERE p.author_id = :targetId AND p.deleted_at IS NULL
 ORDER BY p.created_at DESC, p.id DESC
 LIMIT 100
ON CONFLICT (recipient_id, post_id) DO NOTHING;
```

**Why 100?** Three considerations:

1. **Empty-feed-after-follow UX.** A first-time follower lands on
   `/home` and immediately sees recent activity by the followee.
   Twitter / Instagram backfill on follow precisely so the action
   has an immediate observable payoff. Zero backfill defeats this.
2. **Worst-case write cost.** The backfill is bounded by `LIMIT
   100`, so even following a 1M-post author costs 100 inserts.
3. **Avoid stretching the follow into a long-running write.** A
   larger cap (e.g. 10,000) would put a heavy synchronous write on
   the follow path. 100 is small enough that the follow stays
   sub-millisecond-ish on a real backend; larger backfills would
   want to move to an async job.

**Why is this not a non-goal?** Skipping backfill entirely is the
"purist forward-only fanout" approach — a clean invariant but a
worse UX. The cap of 100 is the compromise that picks both: the
follower gets immediate content, and the write stays bounded.

**Why synchronous, not deferred to a background worker?** Two
reasons:

1. **No queue infrastructure in this stack.** Spinning up Kafka /
   Rabbit / SQS just for the backfill would be over-architecting.
2. **Synchronous keeps the invariant simple.** After the follow
   call returns 204, the follower's feed is in its final post-
   follow state. No "eventually consistent" window for the SPA to
   handle. Combined with the frontend's feed-query invalidation on
   follow success (Decision 7), the UX is `click Follow → see new
   posts on next /home fetch`.

**Idempotency on re-follow.** `ON CONFLICT (recipient_id, post_id)
DO NOTHING` means a follow → unfollow → follow round trip leaves
the followee's posts in the feed exactly once. (Unfollow scrubs,
re-follow re-inserts — both no-op if the row is already correct.)
The IT case `follow_backfill_idempotentAcrossRefollow` proves this.

### Decision 7: Frontend invalidates the feed query on follow / unfollow success

`ProfilePage`'s follow / unfollow mutation `onSuccess` callbacks
SHALL invalidate the feed query key in addition to the existing
`getGetFollowStatsQueryKey(userId)` invalidation.

**Why?** The backend eagerly backfills / scrubs in the same
transaction as the follow / unfollow. By the time the mutation
resolves, the feed is correct on disk. Invalidating the feed query
gives the SPA an immediate refetch when the user navigates back to
`/home` — no stale page state, no manual reload required.

**Why both invalidations?** They target distinct query keys with
distinct hot consumers. `getGetFollowStatsQueryKey` drives the
profile-page counts and button label; the feed query key drives
`/home`. Invalidating both is one extra TanStack Query call; it's
cheap, structurally clean, and the alternative ("invalidate
everything matching some prefix") couples unrelated keys.

### Decision 8: `PostCard` delete-invalidation is a parent-provided callback

`PostCard`'s `listOwnerId: string` prop SHALL be replaced with
`onDeleteSuccess: () => void`. `PostCard` SHALL invoke the callback
on mutation success and SHALL NOT invalidate any query key itself.
`PostList` and `FeedList` each pass a callback that invalidates the
appropriate key.

**Why callback over discriminator prop?** Three reasons:

1. **`PostCard` doesn't need to know what list it's in.** A
   discriminator (`'author-list' | 'feed'`) leaks the parent's
   identity into the child; a callback is the standard "child
   reports up" shape and keeps the parent in control of its own
   cache.
2. **Extensibility is free.** A future surface that renders
   `PostCard` (a hashtag page, a search result, a notification
   center) provides its own callback. No `PostCard` change needed.
3. **Testing is simpler.** `PostCard.test.tsx` asserts the
   callback is invoked; it does not need a `QueryClient` set up to
   observe an invalidation side-effect.

**Why not have `PostCard` invalidate both keys (the per-author key
AND the feed key) always?** Couples `PostCard` to query keys it
should not know about, and breaks the moment a third consumer
exists.

### Decision 9: Rebuild procedure is documented, not exposed as an endpoint

The set of rows that `feed_entries` SHOULD contain is fully derived
from `(posts, follows)`:

```sql
TRUNCATE feed_entries;
INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)
SELECT f.follower_id, p.id, p.author_id, p.created_at
  FROM follows f
  JOIN posts   p ON p.author_id = f.followee_id
 WHERE p.deleted_at IS NULL
UNION
SELECT p.author_id, p.id, p.author_id, p.created_at
  FROM posts p
 WHERE p.deleted_at IS NULL;
```

The rebuild SQL SHALL NOT be exposed as an HTTP endpoint in this
change. It SHALL be encoded as a single `FeedRebuilder` Java method
(or a static SQL string in `FeedFanoutService`) so it can be
invoked from `FeedControllerIT` as a set-equality invariant check:
after any sequence of follows / unfollows / post creates / post
soft-deletes, the contents of `feed_entries` SHALL equal what a
fresh rebuild would produce.

**Why this set-equality invariant test?** It is the strongest
correctness contract the fanout helper can have. Every individual
test asserts specific rows; this invariant asserts no drift between
the maintenance path and the derivation. If the helper omits a
case, the equality breaks. If a future "edit post" feature lands
without updating the helper, the equality breaks. Cheap insurance.

**Why no HTTP endpoint?** Rebuild is an ops affordance, not a user
affordance. A future ops capability with a proper admin auth layer
owns it.

### Decision 10: `FeedFanoutService` is `@Transactional(propagation = MANDATORY)`

Every method on `FeedFanoutService` (`onPostCreated`,
`onPostDeleted`, `onFollow`, `onUnfollow`) SHALL declare
`@Transactional(propagation = Propagation.MANDATORY)`.

**Why?** Each invariant the helper maintains has to land in the
*same* transaction as the parent business operation:

- `onPostCreated` lands the fanout rows in the same TX as the
  `posts` insert.
- `onPostDeleted` scrubs in the same TX as the soft-delete UPDATE.
- `onFollow` backfills in the same TX as the `follows` insert.
- `onUnfollow` scrubs in the same TX as the `follows` delete.

If the helper were `REQUIRES_NEW` or default (`REQUIRED` joining or
starting), a developer who forgot to wrap their caller in
`@Transactional` would observe split transactions and silent
divergence. `MANDATORY` makes that mistake a startup-time or first-
call failure (`TransactionRequiredException`) instead of a quiet
data-integrity bug.

### Decision 11: Self-fanout — the author is a recipient of their own post

`onPostCreated(post)` SHALL insert a `feed_entries` row whose
`recipient_id = post.authorId`, in addition to the rows for each
follower.

**Why?** Two reasons:

1. **Empty-graph UX.** A user with zero followees and zero
   followers still sees their own posts on `/home`. Without self-
   fanout, `/home` is permanently empty for solo accounts — which
   makes the composer's "create a post" action visibly broken
   ("where did it go?") and breaks the existing UX assumption that
   composing a post leaves it visible on the home page.
2. **Symmetry with the read query.** The read query is "show me
   everything in my `feed_entries`." Special-casing "your own
   posts come from `posts.author_id = :me` instead" would split the
   feed into two sub-queries and recover the read-time-merge
   complexity we picked fanout to avoid.

**Why is the `(self, postId)` row safe?** The author cannot follow
themselves (DB `CHECK`), so the follower-fanout path never produces
a `(self, self.postId)` row by accident; the self-fanout statement
is the only producer. `ON CONFLICT (recipient_id, post_id) DO
NOTHING` keeps the operation idempotent even if a future invariant
violator inserts a duplicate.

### Decision 12: Cursor codec is reused unchanged from `posts`

`FeedController` uses `PostCursorCodec.encode(createdAt, postId)`
and `.decode(cursor)`. No new codec is introduced.

**Why?** The cursor encodes a `(timestamp, id)` tuple. Both the
per-author list and the feed sort by `(created_at DESC, id DESC)`
where `id` is the post id. The two cursors are wire-compatible —
which is also why a future client can decode either by treating
the cursor as opaque (the contract).

**Why isn't this a problem (cursors not flavour-tagged)?** Because
the wire is *opaque* per the per-author list spec. Clients never
inspect cursors; they round-trip them to the next request. A
cursor minted by the feed and replayed against the author-list
endpoint would still parse correctly and address a real
(created_at, id) — it just happens to mean "give me rows of this
author older than this point" instead of "give me feed rows older
than this point." That's not a leak the client can exploit; it's
just a curio of the codec's flavour-agnosticism.

### Decision 13: No per-recipient row cap on `feed_entries` in this change

`feed_entries` is allowed to grow without bound per recipient.

**Why no cap?** At this project's scale the cap is unnecessary, and
adding it would interleave the cap-maintenance logic into every
`onPostCreated` call ("after inserting, trim oldest beyond N for
each recipient"). That's a pile of write amplification on every
post create.

**Trapdoor.** A real-scale deployment would cap to ~1000 per
recipient and accept "older than the cap means the read falls
back to a merge-on-read for that page" — which is its own design
problem that this change deliberately defers.

## Risks / Trade-offs

- **[Risk] Synchronous fanout makes the post-create latency
  linear in the author's follower count.** At toy scale this is
  invisible; at celebrity scale (1M+ followers) this is the
  textbook reason production systems move to async + hybrid push
  / pull. → Mitigation: documented as the well-known follow-up in
  this design. The trapdoor is identified (async worker + hybrid
  for users above a follower threshold). This change is small
  enough to be replaced by that follow-up without rewriting the
  read path — the read path doesn't care how rows got into
  `feed_entries`.
- **[Risk] Write amplification on every post.** A post by a user
  with N followers writes N+1 rows. At N=1000, the post-create
  transaction touches ~1000 b-tree inserts on the PK and the two
  secondary indexes. → Mitigation: pgmetrics-visible at IT time;
  the real relief is the async path above.
- **[Risk] Storage growth is O(posts × avg-followers).** Each post
  carries a row per recipient. At larger scale this dwarfs the
  `posts` table. → Mitigation: per-recipient cap (Decision 13's
  trapdoor) is the standard answer.
- **[Risk] Backfill on follow is bounded at 100 — a user who
  follows someone with 10,000 posts gets only their newest 100
  pre-existing posts.** If the follower scrolls deep, the deep
  history is not in `feed_entries`. → Mitigation: explicit and
  documented (Decision 6). A real-scale design either backfills
  more (paid via async) or supports a "lazy-extend deeper history
  on scroll" path. Neither is built; both are clean future
  changes against the same read query, which doesn't change.
- **[Risk] Feed-entry FK to `posts` is `ON DELETE CASCADE`, so a
  hard `posts` delete (which doesn't happen via the API today —
  soft-delete only) would cascade.** → Mitigation: today there is
  no hard-delete code path. The CASCADE is the right policy for
  the future hard-delete (post moderation, GDPR purge) — when it
  lands, the operator removes the post and the feed entries go
  with it.
- **[Risk] `ON CONFLICT (recipient_id, post_id) DO NOTHING` masks
  a class of bugs.** If a future code path produces malformed
  fanout rows, the conflict swallows them silently. → Mitigation:
  the set-equality invariant test (Decision 9) is the loudest
  cross-check. If the helper diverges from the derivation, the
  rebuild equality breaks and the IT fails. The conflict clause
  exists specifically to keep the legitimate retry / re-follow /
  re-create cases idempotent; the equality test catches
  divergence.
- **[Risk] Frontend `FeedList` and `PostList` are structurally
  near-duplicates.** Two components for what looks like one
  pattern. → Mitigation: acceptable. They differ in two
  meaningful ways (query hook + query key) and may diverge
  further (the feed eventually wants pull-to-refresh, "1 new
  post" indicator, etc., which `PostList` does not). The cost of
  duplication is one file; the cost of premature abstraction
  would be a generic `<PaginatedList queryHook=... />` that obscures
  both call sites.
- **[Trade-off] `PostCard` shape change (`listOwnerId` →
  `onDeleteSuccess` callback) touches existing tests.** → Acceptable:
  the new contract is a structural improvement (decoupling the
  child from parent-side caches) and the test diff is mechanical
  (each call site that used `listOwnerId` now passes a callback).
- **[Trade-off] The feed has no realtime push, so a freshly-
  authored post by a followee doesn't appear on the follower's
  open `/home` page until the next refetch.** → Acceptable for
  this change. The follow / unfollow mutations explicitly trigger
  refetches; the composer-on-`/home` flow already invalidates the
  list (carrying through here). Anything beyond that is a realtime
  capability, deliberately deferred.
- **[Trade-off] Self-fanout (Decision 11) makes the author one of
  their own followers structurally, which slightly inflates
  `feed_entries` for solo accounts.** → Acceptable: solo accounts
  are bounded by their own post count, which is the same row count
  the per-author list would carry. The inflation is exactly
  matched to the data the user needs to see; it isn't waste.
- **[Trade-off] Two indexes on `feed_entries` cost write
  amplification on every fanout row.** Each insert touches PK +
  read-index + author-index = 3 b-tree inserts per row. → Acceptable:
  the alternative (one over-broad composite covering both) is
  worse on read latency. The follow-up scale trapdoor (async fanout
  + per-recipient cap) is what actually amortises this.
- **[Risk] Backfill on follow is synchronous and contends with
  `posts` reads under the same lock.** Postgres uses MVCC, so
  reads don't block; the backfill `SELECT … FROM posts` takes a
  snapshot and the INSERT is into `feed_entries` only, so the
  contention is `feed_entries`-local. → Mitigation: no concrete
  mitigation needed at this scale; documented for the day async
  follow-up lands.
- **[Risk] The set-equality invariant test runs the rebuild
  query against the full DB state, which slows IT.** → Mitigation:
  run the invariant once at the end of each multi-action IT
  scenario, not after every action. The rebuild is O(posts +
  follows × posts-per-author); on the IT fixture sizes (< 50
  rows total) it is millisecond-scale.
