## ADDED Requirements

### Requirement: Creating a post fans out to followers and the author via `feed_entries`

`PostService.create(authorId, body)` SHALL, inside the same transaction that inserts the new `posts` row, insert exactly one `feed_entries` row per follower of the author PLUS one self-fanout row for the author. The fanout SHALL be implemented via `FeedFanoutService.onPostCreated(post)`. The HTTP contract of `POST /api/v1/posts` (status `201`, `PostResponse` body, validation rules, authentication requirement) is unchanged.

#### Scenario: Successful create fans out to all followers

- **WHEN** an authenticated client posts a valid `{ body }` to `POST /api/v1/posts`, and the authenticated author has N followers
- **THEN** after the create transaction commits, `feed_entries` contains exactly N rows whose `(post_id, author_id) = (newPostId, authorId)` and whose `recipient_id` is each follower's id
- **AND** the response status and body are unchanged from the previous create contract (201 + `PostResponse`).

#### Scenario: Successful create includes a self-fanout row

- **WHEN** an authenticated client posts a valid `{ body }` to `POST /api/v1/posts`
- **THEN** after the create transaction commits, `feed_entries` contains exactly one row whose `(recipient_id, post_id, author_id) = (authorId, newPostId, authorId)`.

#### Scenario: Fanout is part of the create transaction (atomicity)

- **WHEN** the fanout helper raises an exception (simulated in IT by injecting a failure into `FeedFanoutService.onPostCreated`)
- **THEN** the `posts` row is also rolled back
- **AND** the response status is 5xx (not 201)
- **AND** neither the `posts` row nor any `feed_entries` rows exist after the rollback.

### Requirement: Soft-deleting a post scrubs all `feed_entries` referencing the post

`PostService.delete(postId)` SHALL, inside the same transaction that sets `posts.deleted_at = now()`, delete every `feed_entries` row whose `post_id = :postId`. The scrub SHALL be implemented via `FeedFanoutService.onPostDeleted(postId)`. The HTTP contract of `DELETE /api/v1/posts/{id}` (status `204`, authorization rules, idempotency on already-deleted) is unchanged.

#### Scenario: Soft-delete removes all feed entries for the post

- **WHEN** the author of a post that has fanned out to K recipients (including the author themselves via self-fanout) calls `DELETE /api/v1/posts/{postId}`
- **THEN** the response status is 204
- **AND** after the delete transaction commits, zero `feed_entries` rows reference `postId`
- **AND** the `posts` row's `deleted_at` is set to a non-null timestamp.

#### Scenario: Delete-of-already-deleted is still a no-op on `feed_entries`

- **WHEN** the author calls `DELETE /api/v1/posts/{postId}` for a post that is already soft-deleted (the existing idempotent contract)
- **THEN** the response status is 204
- **AND** `feed_entries` remains free of any rows referencing `postId` (no rows existed; none are inserted).
