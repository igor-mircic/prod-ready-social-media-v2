## Context

The platform has a working auth backbone (`user-accounts`) — signup, login, sessions,
revocable opaque tokens, deny-by-default security — but no content primitive. Every
downstream social feature is downstream of posts: follows are interesting because
followed users *post*, the feed is *posts by followed users*, comments and likes
*attach to posts*. So posts is the foundational table and the foundational read pattern.

The constraints that shape this design:

- The repo already has a working full-stack pattern (Flyway → Spring controller → springdoc →
  orval → React + TanStack Query → Vitest with generated MSW → Playwright). This change
  should *use* that pattern, not invent a new one.
- The existing `useraccounts` package is the de-facto reference for backend style: flat,
  feature-sliced, JPA entities that hold cross-aggregate references as raw `UUID` fields
  (e.g. `AuthAccessToken.userId`), not as JPA `@ManyToOne` relationships. New code should
  match.
- The next read pattern that lands after this one is the feed — posts by *many* authors,
  consumed as an infinite scroll. The pagination shape we pick here will be the shape the
  feed inherits. Picking offset/limit now and rewriting it later would be churn.
- The existing `SecurityFilterChain` is deny-by-default with a small explicit allowlist.
  Adding endpoints to that allowlist is a security-spec change, which raises the cost of
  any "public reads" story.

## Goals / Non-Goals

**Goals:**

- Establish posts as a working end-to-end capability: a row in Postgres, a REST contract
  in `openapi/openapi.json`, a React feature module rendered on `/home`, and a Playwright
  spec that exercises the round-trip.
- Establish a pagination pattern (cursor-based, opaque, versioned) that the feed and any
  future timeline can adopt without further design work.
- Establish the cross-aggregate reference style (UUID FK + explicit batch fetch for DTO
  assembly) as the repo convention for future capabilities — follows, likes, comments will
  inherit this shape.
- Make the soft-delete posture explicit so future referencing capabilities (replies, likes)
  inherit a consistent "deleted but referencable" semantic.

**Non-Goals:**

- Post edits (`PATCH /posts/{id}`) — defer to its own change, where the UX of an "edited"
  badge and edit-history retention can be decided.
- Visibility / privacy controls — V1 is "any authenticated user can read any post." Public
  profiles, follower-only posts, and DMs are separate capabilities.
- Replies, comments, likes, follows, feed — separate capabilities, each downstream of this
  one.
- Anything richer than a plain-text body — no markdown rendering, no media attachments,
  no link unfurling, no mentions or hashtags. The body is one `TEXT` column.
- Unauthenticated reads. The "public web" story is a separate capability.
- Backward cursor pagination ("show me older posts and let me scroll up"). V1 cursors are
  forward-only.

## Decisions

### Decision 1: Mirror the `useraccounts` package layout — flat, feature-sliced, no `@ManyToOne`

Place new backend code at `com.prodready.social.posts` with no sub-packages. `Post` is a
JPA entity that references the author by `UUID authorId`, **not** by `@ManyToOne User`.
`PostService` explicitly batch-fetches authors via `UserRepository.findAllById(authorIds)`
when assembling response DTOs.

**Rationale:** Matches the existing repo pattern (`AuthAccessToken.userId`, `User` itself
has no relationships). JPA relationships introduce lazy-initialization footguns when
entities cross the controller boundary and bind aggregate lifecycles together in ways that
are hard to evolve. Explicit `UUID` references keep each entity self-contained; one batch
fetch is the entire N+1 mitigation.

**Alternatives considered:**

- *`@ManyToOne User author` with `FetchType.LAZY`*: Rejected. Lazy fetch outside a
  transaction is a recurring source of bugs (`LazyInitializationException`), and even with
  `EAGER` it implicitly fetches the author on every post load whether the caller wants it
  or not.
- *Sub-packages (`posts.api`, `posts.domain`, `posts.persistence`)*: Rejected. Premature
  segmentation for a ~10-class capability. The existing `useraccounts` package is flat and
  reads fine.

### Decision 2: Soft delete via `deleted_at`, with a partial index

`posts.deleted_at TIMESTAMPTZ NULL`. Every read query filters `WHERE deleted_at IS NULL`.
The composite read index is partial on the same predicate:

```sql
CREATE INDEX posts_author_created_idx
    ON posts (author_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;
```

**Rationale:** Future features (replies, likes, quotes) will reference post IDs;
hard-deleting orphans those references. Soft delete preserves referential integrity for
free and gives moderation a no-cost audit trail. The partial index ensures deleted rows do
not bloat the live read path.

**Alternatives considered:**

- *Hard delete*: Rejected. Cheap to add soft delete now; expensive to retrofit once likes
  and replies reference posts.
- *Tombstone row in a separate `deleted_posts` table*: Rejected. Adds a write per delete
  and another lookup per "is this post deleted" check, without buying space savings until
  rows are pruned.

### Decision 3: `ON DELETE RESTRICT` on `posts.author_id`

The FK is declared `REFERENCES users(id) ON DELETE RESTRICT`. The repo has no
account-deletion flow today; this is a forward-looking choice.

**Rationale:** RESTRICT forces any future "delete user" change to make an explicit
decision about what happens to their posts (hard-delete them, soft-delete them, transfer
ownership to a tombstone author, etc.). CASCADE would silently destroy data and orphan
future replies/likes that reference those posts. SET NULL would require `author_id` to be
nullable everywhere up the stack, complicating the DTO contract for a hypothetical case
that doesn't exist yet.

**Alternatives considered:**

- *CASCADE*: Rejected. Silent destruction; surprising at incident time.
- *SET NULL*: Rejected. Forces nullability cost on every consumer (entity, repository
  query, DTO, frontend rendering) for a deferred feature.

### Decision 4: Cursor pagination from day one; opaque and versioned

Lists are cursor-paginated by the `(created_at DESC, id DESC)` tuple. The cursor is an
opaque `base64url`-encoded string with the binary shape:

```
[version-byte=0x01] [created_at-millis-since-epoch, 8 bytes BE] [id-uuid, 16 bytes]
```

Clients treat the cursor as opaque. The version byte reserves the right to change the
encoding without breaking outstanding cursors — a future server can detect the version,
fall through to the new encoding, and keep accepting old cursors during a transition
window.

The list endpoint takes `?cursor=<opaque>&limit=<int>`. `limit` defaults to **20** and is
capped server-side at **50**. The response shape is:

```
{
  items: PostResponse[],
  nextCursor: string | null    // null when there are no further pages
}
```

A request with no `cursor` returns the most recent `limit` posts. A request whose `cursor`
no longer corresponds to a row (e.g. the row was soft-deleted between requests) returns
the page of rows whose `(created_at, id) < (cursor.created_at, cursor.id)` — the cursor
is an *anchor*, not a row reference, so it survives intervening deletes.

**Rationale:** The feed is the next read pattern, and the feed *must* be cursor-paginated
(offset/limit shows duplicates and gaps under mutation). Picking the same shape for "user's
posts" gives the frontend one pattern to learn. The version byte is cheap insurance.

**Alternatives considered:**

- *Spring Data `Pageable` (offset/limit)*: Rejected. Convenient for static datasets, wrong
  for a mutating timeline. Switching pagination shape later means a contract break.
- *JSON-shaped cursor (`{ts: "...", id: "..."}`)*: Rejected. JSON cursors invite clients to
  peek and depend on the internals, which then locks in the encoding.

### Decision 5: All post endpoints are authenticated; no `SecurityFilterChain` allowlist change

`POST /api/v1/posts`, `GET /api/v1/posts/{id}`, `GET /api/v1/users/{userId}/posts`, and
`DELETE /api/v1/posts/{id}` all require a valid `Authorization: Bearer <token>` header and
fall under the existing deny-by-default chain.

**Rationale:** Unauthenticated reads raise their own design questions (rate limiting,
account enumeration, response shape for anonymous viewers, abuse posture). Those belong
in a "public profiles / public posts" capability of their own. Keeping V1 authenticated-only
means zero churn to the security spec and a clean place to add the public read story
later.

### Decision 6: Author-only delete; "not visible to caller" returns 404, not 403

`DELETE /api/v1/posts/{id}` looks up the post and returns:

- `204 No Content` on a successful soft-delete (caller is the author of a live post).
- `404 ProblemDetail` when the post does not exist, is soft-deleted, **or** is authored by
  somebody other than the caller.

**Rationale:** Returning 403 for "exists but not yours" leaks the existence of the post
to non-authors. Treating "not visible to caller" identically to "not present" mirrors the
existing user-accounts pattern where wrong-password and unknown-email both return 401
with an identical body. Consistent posture, no extra contract surface.

**Alternatives considered:**

- *403 for not-author vs 404 for missing*: Rejected. Leaks existence.
- *Hard delete instead of soft delete*: Already rejected at the schema level (Decision 2);
  the API surface follows.

### Decision 7: Service-layer DTO assembly batches authors

`PostService` is the only place that knows how to turn a `Post` (or list of `Post`s) into
a `PostResponse`. For a list query, the service collects the distinct author IDs,
performs one `userRepository.findAllById(authorIds)` call, builds a
`Map<UUID, User>`, then maps each row to a `PostResponse` carrying the embedded
`{id, displayName}` author summary.

For a single-post read, the same code path runs — just with one author ID.

**Rationale:** One round-trip for authors regardless of page size. No N+1, no JPA-managed
relationships, no fetch joins. The pattern is identical whether the list has one author
(this change) or many authors (the feed, next change).

### Decision 8: Frontend list uses `useInfiniteQuery`; mutations invalidate, not optimistically update

`PostList` consumes the Orval-generated list query through TanStack Query's
`useInfiniteQuery`, advancing `pageParam` by the response's `nextCursor` until it's
`null`. `PostComposer` calls the generated create mutation; on `onSuccess` it invalidates
the list query and lets the next fetch render the new post. `PostCard`'s delete control
calls the generated delete mutation and invalidates the same list query on success.

**Rationale:** Optimistic updates are a maintenance burden disproportionate to the UX win
at this stage — the round-trip is imperceptible on localhost and short on production for a
single-region deployment. Invalidate-then-refetch is correct by construction and matches
how signup/login mutations already work. We can revisit optimistic updates when network
latency actually shows up.

**Alternatives considered:**

- *Optimistic update with rollback on failure*: Rejected for V1. Reintroduce when latency
  is measurable.
- *Manual cache mutation via `queryClient.setQueryData`*: Rejected. Bug surface greater
  than the perceived win.

### Decision 9: HomePage extension is additive; `user-accounts` spec stays unchanged

`HomePage.tsx` is extended to render `<PostComposer />` and `<PostList userId={currentUser.id} />`
below the existing `Hello, {displayName}` and Logout button. The existing user-accounts
requirements ("renders the user's `displayName`", "renders a Logout button") still hold
verbatim — the new content is additive.

**Rationale:** A dedicated `/profile` route would be cleaner long-term, but profile-as-a-page
is a real capability (avatar, bio, follower count, edit form) that deserves its own change.
Bolting posts onto `/home` ships a useful slice now without prejudicing that future
design.

**Alternatives considered:**

- *Carve a new `/me` or `/profile` route in this change*: Rejected as scope creep.
- *Replace HomePage's current content with the posts feature*: Rejected. Would change the
  existing user-accounts requirement, which is precisely the spec-change overhead we are
  avoiding by keeping the new content additive.

## Risks / Trade-offs

- **Cursor encoding lock-in.** Once cursors leave the server (browser back/forward, future
  shareable links, third-party clients) the encoding becomes part of the contract.
  *Mitigation:* opaque-to-clients + version byte. A future encoding change ships behind a
  new version byte and accepts both during a transition window.
- **Posts grow unbounded; no archival or partitioning story.** Acceptable at our scale —
  the partial index keeps reads cheap. *Mitigation when it matters:* monthly partitioning
  by `created_at`, transparent to callers; the index already includes `created_at` so the
  query planner can prune partitions.
- **Soft-delete read-filter discipline.** Every new read query must remember to filter
  `deleted_at IS NULL`. *Mitigation:* repository methods that return posts to callers are
  named `findActive*`; the raw `findById` is package-private and used only by `PostService`
  for ownership and delete checks. The partial index also makes "did you forget the filter"
  obvious in query plans (a non-filtered scan won't use the index).
- **Account enumeration via posts list.** `GET /api/v1/users/{nonexistent}/posts` returning
  404 leaks "does this user exist." Currently fine — there is no other way to enumerate
  accounts and accounts are not secret — but worth flagging for when public profiles land.
  *Mitigation if needed later:* return `{items: [], nextCursor: null}` for any
  syntactically-valid userId, regardless of existence.
- **`/home` cohesion erodes.** The page now does two unrelated things (greeting + posts).
  Acceptable for now; will refactor when a dedicated profile route lands. *Mitigation:* the
  new content lives entirely inside `PostComposer` and `PostList`, so the refactor is a JSX
  move, not a code rewrite.
- **DELETE is irreversible from the user's perspective.** Soft-deleted posts are recoverable
  by an admin but not by the user. *Mitigation deferred:* the UI shows a confirm dialog
  before delete; an "undo" toast is out of scope for V1.

## Open Questions

None blocking. The deferred items above (PATCH for edits, public reads, optimistic UI,
public-profile account-enumeration posture, archive/partitioning) are tracked as explicit
non-goals or future-mitigations and do not need to be resolved before tasks.
