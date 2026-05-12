## ADDED Requirements

### Requirement: ProfilePage renders follower / following counts and a Follow / Unfollow toggle

The `frontend/src/features/profile/ProfilePage.tsx` component SHALL fire the Orval-generated `useGetFollowStats({ userId })` query in parallel with the existing `useGetUser` and the `PostList`. The page SHALL render, directly under the existing display-name heading: (1) plain-text follower and following counts (e.g. "**N** followers · **M** following") computed from the stats response; (2) when `userId !== currentUser.id`, a Follow / Unfollow toggle `<button>` whose accessible name reflects `viewerFollows` (e.g. `Follow` when `viewerFollows === false`, `Unfollow` or `Following` when `viewerFollows === true`); (3) when `userId === currentUser.id`, no toggle button (you cannot follow yourself), while counts SHALL still render. The toggle SHALL invoke the Orval-generated follow / unfollow mutation hooks and, on success, SHALL invalidate the `useGetFollowStats({ userId })` query so the counts and the button label refresh. While the stats query is loading, the counts and the button SHALL render a skeleton placeholder so the page layout does not jump. Existing `ProfilePage` requirements (route under `ProtectedRoute`, display-name heading, embedded `PostList`, no composer, 404 affordance) SHALL be unchanged.

#### Scenario: Counts render under the heading

- **WHEN** the page is mounted with a `userId` whose `getFollowStats` response is `200 { followers: 3, following: 7, viewerFollows: false }`
- **THEN** the page renders the existing display-name heading
- **AND** the page renders text reflecting `3 followers` and `7 following` (e.g. "3 followers · 7 following") directly under the heading.

#### Scenario: Follow button is rendered when viewing another user with viewerFollows: false

- **WHEN** the page is mounted with `userId !== currentUser.id`
- **AND** the `getFollowStats` response is `200 { followers: 0, following: 0, viewerFollows: false }`
- **THEN** the page renders a `role=button` with accessible name `Follow`.

#### Scenario: Unfollow button is rendered when viewing another user with viewerFollows: true

- **WHEN** the page is mounted with `userId !== currentUser.id`
- **AND** the `getFollowStats` response is `200 { followers: 1, following: 0, viewerFollows: true }`
- **THEN** the page renders a `role=button` whose accessible name reflects the followed state (e.g. `Unfollow` or `Following`).

#### Scenario: No toggle button is rendered on own profile

- **WHEN** the page is mounted with `userId === currentUser.id`
- **AND** the `getFollowStats` response is `200 { followers: 5, following: 4, viewerFollows: false }`
- **THEN** the page renders the counts (`5 followers · 4 following`)
- **AND** the page does NOT render a `role=button` with accessible name `Follow`, `Unfollow`, or `Following`.

#### Scenario: Clicking Follow invokes the mutation and refetches the stats

- **WHEN** the user clicks the rendered `Follow` button on a profile where `viewerFollows` is currently `false`
- **THEN** the SPA invokes the Orval-generated follow mutation hook for `userId`
- **AND** on the mutation's success the SPA invalidates the `useGetFollowStats({ userId })` query
- **AND** the refetched stats are rendered (counts and button label update without a page navigation).

#### Scenario: Clicking Unfollow invokes the mutation and refetches the stats

- **WHEN** the user clicks the rendered Unfollow / Following button on a profile where `viewerFollows` is currently `true`
- **THEN** the SPA invokes the Orval-generated unfollow mutation hook for `userId`
- **AND** on the mutation's success the SPA invalidates the `useGetFollowStats({ userId })` query
- **AND** the refetched stats are rendered (counts and button label update without a page navigation).

#### Scenario: Counts and button render skeletons while the stats query is in flight

- **WHEN** the page is mounted and `useGetFollowStats` has not yet resolved
- **THEN** the counts region renders a skeleton / placeholder (not literal `0 followers · 0 following`)
- **AND** if `userId !== currentUser.id`, the toggle region renders a skeleton / placeholder (not a clickable `Follow` button)
- **AND** the page layout does not visibly shift when the stats query resolves.

### Requirement: Vitest tests cover the ProfilePage follow surface

The `frontend/` project SHALL include Vitest tests (in `frontend/src/features/profile/ProfilePage.test.tsx` or a sibling file under `frontend/src/features/profile/`) that override the generated MSW handlers to cover: (a) counts and a `Follow` button render when `getFollowStats` returns `viewerFollows: false` for a non-own profile; (b) counts and an Unfollow / Following button render when `getFollowStats` returns `viewerFollows: true` for a non-own profile; (c) counts render but no toggle button is present when `userId === currentUser.id`; (d) clicking `Follow` invokes the follow mutation and triggers a stats refetch whose response is reflected on the page; (e) clicking the followed-state button invokes the unfollow mutation and triggers a stats refetch whose response is reflected on the page.

#### Scenario: Non-own profile with viewerFollows false renders Follow button

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose `getFollowStats` returns `200 { followers: 0, following: 0, viewerFollows: false }`
- **AND** the auth context's current user id is NOT equal to that `userId`
- **THEN** the test asserts a `button` with accessible name `Follow` is rendered
- **AND** asserts text reflecting `0 followers` is rendered.

#### Scenario: Non-own profile with viewerFollows true renders the followed-state button

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose `getFollowStats` returns `200 { followers: 1, following: 0, viewerFollows: true }`
- **AND** the auth context's current user id is NOT equal to that `userId`
- **THEN** the test asserts a `button` whose accessible name reflects the followed state (e.g. `Unfollow` or `Following`) is rendered.

#### Scenario: Own profile renders counts but no toggle button

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose `getFollowStats` returns `200 { followers: 5, following: 4, viewerFollows: false }`
- **AND** the auth context's current user id IS equal to that `userId`
- **THEN** the test asserts the counts are rendered
- **AND** asserts no `button` with accessible name `Follow`, `Unfollow`, or `Following` is rendered.

#### Scenario: Clicking Follow invokes the mutation and refetches the stats

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose initial `getFollowStats` returns `viewerFollows: false`
- **AND** the user clicks the `Follow` button
- **AND** the MSW handler for `POST /api/v1/users/{userId}/follow` responds `204`
- **AND** the next `getFollowStats` handler returns `viewerFollows: true` and an incremented `followers` count
- **THEN** the test asserts the rendered button now reflects the followed state
- **AND** asserts the rendered followers count has incremented.

#### Scenario: Clicking the followed-state button invokes the unfollow mutation and refetches the stats

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose initial `getFollowStats` returns `viewerFollows: true`
- **AND** the user clicks the followed-state button
- **AND** the MSW handler for `DELETE /api/v1/users/{userId}/follow` responds `204`
- **AND** the next `getFollowStats` handler returns `viewerFollows: false` and a decremented `followers` count
- **THEN** the test asserts the rendered button now reflects the unfollowed state (accessible name `Follow`)
- **AND** asserts the rendered followers count has decremented.
