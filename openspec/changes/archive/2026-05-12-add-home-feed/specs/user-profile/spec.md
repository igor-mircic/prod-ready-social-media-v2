## ADDED Requirements

### Requirement: Follow / unfollow mutations on `ProfilePage` invalidate the feed query key

When the Follow / Unfollow toggle on `ProfilePage` succeeds, the mutation's `onSuccess` callback SHALL invalidate the feed query key (`getGetFeedQueryKey()` or equivalent generated key factory) in addition to invalidating `getGetFollowStatsQueryKey(userId)`. Because the backend eagerly backfills (on follow) and eagerly scrubs (on unfollow) inside the same transaction as the `follows` write, the next `GET /api/v1/feed` after the mutation resolves is correct on disk — the SPA's invalidation triggers a refetch that lands on the new feed state without a stale window.

#### Scenario: Clicking Follow invalidates the feed query

- **WHEN** the user clicks the Follow button on `ProfilePage` and the mutation resolves 204
- **THEN** the SPA invalidates `getGetFeedQueryKey()` (the feed query key)
- **AND** the SPA also invalidates `getGetFollowStatsQueryKey(userId)` (preserving the existing follow-stats refresh behavior).

#### Scenario: Clicking Unfollow invalidates the feed query

- **WHEN** the user clicks the followed-state button on `ProfilePage` and the mutation resolves 204
- **THEN** the SPA invalidates `getGetFeedQueryKey()` (the feed query key)
- **AND** the SPA also invalidates `getGetFollowStatsQueryKey(userId)` (preserving the existing follow-stats refresh behavior).

#### Scenario: Follow does not invalidate the feed key when the mutation errors

- **WHEN** the user clicks the Follow button and the mutation rejects (network error, server 5xx, etc.)
- **THEN** the SPA does NOT invalidate the feed query key
- **AND** no spurious refetch of `/api/v1/feed` is triggered by the failed mutation.

### Requirement: `ProfilePage` Vitest coverage includes feed-key invalidation

The `frontend/` project SHALL include Vitest tests proving that the follow / unfollow mutations on `ProfilePage` invalidate the feed query key (in addition to the follow-stats key). The tests SHALL assert this via either (a) a spy on `queryClient.invalidateQueries` confirming the call with the feed query key, or (b) an integration-style assertion that a subsequent `GET /api/v1/feed` is fired after the mutation resolves.

#### Scenario: Vitest asserts the feed key is invalidated on follow success

- **WHEN** the test mounts `ProfilePage` with a non-own profile, clicks Follow, and MSW responds 204 to `POST /api/v1/users/{userId}/follow`
- **THEN** the test asserts that `queryClient.invalidateQueries` was called with the feed query key (the same key `useGetFeed` uses).

#### Scenario: Vitest asserts the feed key is invalidated on unfollow success

- **WHEN** the test mounts `ProfilePage` with a non-own profile in followed state, clicks the followed-state button, and MSW responds 204 to `DELETE /api/v1/users/{userId}/follow`
- **THEN** the test asserts that `queryClient.invalidateQueries` was called with the feed query key.
