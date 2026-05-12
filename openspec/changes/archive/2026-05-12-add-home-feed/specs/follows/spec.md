## ADDED Requirements

### Requirement: Following a user backfills up to 100 of the followee's recent posts into the caller's `feed_entries`

`FollowService.follow(callerId, targetId)` SHALL, inside the same transaction that inserts (or idempotently no-ops on) the `follows` row, copy the targetId's 100 most-recent non-deleted posts into `feed_entries` for the caller. The backfill SHALL be implemented via `FeedFanoutService.onFollow(callerId, targetId)`. The HTTP contract of `POST /api/v1/users/{userId}/follow` (status `204`, idempotency, self-follow → 400, unknown target → 404, unauthenticated → 401) is unchanged.

#### Scenario: First follow backfills the followee's posts up to the cap

- **WHEN** the caller follows targetId for the first time, and targetId has M non-deleted posts where `M <= 100`
- **THEN** after the follow transaction commits, exactly M `feed_entries` rows exist where `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the rows' `post_id` and `created_at` values match the M posts authored by targetId.

#### Scenario: Backfill is capped at 100 when the followee has more posts

- **WHEN** the caller follows targetId for the first time, and targetId has more than 100 non-deleted posts
- **THEN** after the follow transaction commits, exactly 100 `feed_entries` rows exist where `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the 100 rows correspond to targetId's 100 most-recent posts ordered by `(posts.created_at DESC, posts.id DESC)`.

#### Scenario: Soft-deleted posts are excluded from the backfill

- **WHEN** the caller follows targetId, and some of targetId's posts are soft-deleted (`deleted_at IS NOT NULL`)
- **THEN** the backfill copies only non-deleted posts (the `WHERE p.deleted_at IS NULL` predicate is part of the backfill SQL).

#### Scenario: Re-follow is idempotent on `feed_entries`

- **WHEN** the caller follows → unfollows → follows the same targetId, and targetId has not posted in the meantime
- **THEN** after the second follow, the rows in `feed_entries` for `(recipient_id, author_id) = (callerId, targetId)` are identical to their state after the first follow
- **AND** no row is duplicated (the `ON CONFLICT (recipient_id, post_id) DO NOTHING` clause makes the re-insert a no-op).

#### Scenario: Repeated follow (without intervening unfollow) leaves `feed_entries` unchanged

- **WHEN** the caller follows targetId twice without unfollowing in between (the existing idempotent follow contract — both responses are 204)
- **THEN** the second follow's backfill inserts zero new rows
- **AND** the `feed_entries` content for `(recipient_id, author_id) = (callerId, targetId)` is the same after the second follow as after the first.

### Requirement: Unfollowing a user scrubs the followee's posts from the caller's `feed_entries`

`FollowService.unfollow(callerId, targetId)` SHALL, inside the same transaction that removes (or idempotently no-ops on) the `follows` row, delete every `feed_entries` row where `(recipient_id, author_id) = (callerId, targetId)`. The scrub SHALL be implemented via `FeedFanoutService.onUnfollow(callerId, targetId)`. The scrub SHALL be short-circuited when `callerId.equals(targetId)` (self-unfollow) so that the caller's own self-fanout rows are NOT deleted. The HTTP contract of `DELETE /api/v1/users/{userId}/follow` (status `204`, idempotency, unknown target → 404, unauthenticated → 401, self-unfollow → 204) is unchanged.

#### Scenario: Unfollow removes the author's posts from the caller's feed

- **WHEN** the caller has K `feed_entries` rows where `author_id = targetId`, and the caller unfollows targetId
- **THEN** after the unfollow transaction commits, zero `feed_entries` rows exist for `(recipient_id, author_id) = (callerId, targetId)`
- **AND** the caller's `feed_entries` rows for other authors are unchanged.

#### Scenario: Self-unfollow does NOT scrub the caller's own posts

- **WHEN** the caller calls `DELETE /api/v1/users/{callerId}/follow` (self-unfollow), and the caller has self-fanout rows where `(recipient_id, author_id) = (callerId, callerId)` from their own previously-created posts
- **THEN** the response status is 204 (unchanged from the existing self-unfollow contract)
- **AND** the caller's self-fanout rows in `feed_entries` are unchanged
- **AND** the caller's subsequent `GET /api/v1/feed` still returns their own posts.

#### Scenario: Unfollow of a not-currently-followed target is still a no-op on `feed_entries`

- **WHEN** the caller calls `DELETE /api/v1/users/{targetId}/follow` for a `targetId` they are not currently following (the existing idempotent contract returns 204)
- **THEN** the response status is 204
- **AND** `feed_entries` is unchanged (no rows existed; none are deleted).
