# user-profile Specification

## Purpose
TBD - created by archiving change add-user-profile. Update Purpose after archive.
## Requirements
### Requirement: SPA exposes a `/users/:userId` protected route

The `frontend/` project SHALL expose a route at `/users/:userId` that renders a new `ProfilePage` feature module. The route SHALL sit under the existing `<ProtectedRoute />` element in `frontend/src/App.tsx` so unauthenticated callers are redirected to `/login` by the existing protected-route behavior. No new redirect code is added.

#### Scenario: Route exists under ProtectedRoute

- **WHEN** a reader inspects `frontend/src/App.tsx`
- **THEN** the routing tree contains a `<Route path="/users/:userId" element={<ProfilePage />} />`
- **AND** that route sits inside the existing `<Route element={<ProtectedRoute />}>` block alongside `/home`.

#### Scenario: Unauthenticated visit redirects to `/login`

- **WHEN** an unauthenticated browser navigates directly to `/users/{any-userId}`
- **THEN** the SPA redirects to `/login` via the existing `ProtectedRoute` behavior
- **AND** no `GET /api/v1/users/{userId}` request is fired.

### Requirement: ProfilePage renders a heading, a PostList, and no composer

The `ProfilePage` component at `frontend/src/features/profile/ProfilePage.tsx` SHALL read `userId` from the route parameters, fire the Orval-generated `useGetUser({ userId })` query, and render: (1) the fetched user's `displayName` as a heading, and (2) `<PostList userId={userId} />` (the existing `PostList` component, reused without modification). The page SHALL NOT render a `PostComposer` — composing on behalf of another user is not a thing, and even on the viewer's own profile, composing remains the `/home` affordance.

#### Scenario: Page renders heading + list for a user with posts

- **WHEN** the page is mounted with a `userId` whose `getUser` response is `200 { id, displayName: "Alice" }` and whose `listPostsByAuthor` response is `200 { items: [<one post>], nextCursor: null }`
- **THEN** the page renders a heading with text `Alice`
- **AND** the page renders a `role=article` with accessible name `Post` containing the seeded post's body
- **AND** the page does NOT render a `role=textbox` for a composer.

#### Scenario: Page renders heading + empty state for a user with zero posts

- **WHEN** the page is mounted with a `userId` whose `getUser` response is `200 { id, displayName: "Alice" }` and whose `listPostsByAuthor` response is `200 { items: [], nextCursor: null }`
- **THEN** the page renders a heading with text `Alice`
- **AND** the page renders no `role=article` elements with accessible name `Post`
- **AND** the page renders an empty-state affordance (e.g. text indicating there are no posts).

### Requirement: ProfilePage handles unknown user id without redirecting

When the `useGetUser` query returns `404`, the `ProfilePage` SHALL render an "User not found" affordance at the page level and SHALL NOT redirect the browser away from `/users/:userId`. The URL stays as-typed so the visitor can correct the id in the address bar without losing the route.

#### Scenario: 404 from getUser renders a not-found affordance

- **WHEN** the page is mounted with a `userId` whose `getUser` response is `404 ProblemDetail`
- **THEN** the page renders text indicating the user was not found
- **AND** the SPA URL remains `/users/{the-typed-id}` (no redirect to `/not-found` or elsewhere)
- **AND** the page does NOT render a heading, a `PostList`, or a `PostComposer`.

### Requirement: Vitest tests cover the ProfilePage feature module

The `frontend/` project SHALL include Vitest tests under `frontend/src/features/profile/` that override the generated MSW handlers to cover: (a) successful render with posts; (b) successful render with zero posts; (c) 404 user-not-found state; (d) the absence of any `role=textbox` regardless of viewer identity.

#### Scenario: Posts-present test asserts heading and list

- **WHEN** the test mounts `<ProfilePage />` under a router whose URL is `/users/{aliceId}`
- **AND** the MSW handler responds to `getUser` with `200 { id: aliceId, displayName: 'Alice' }`
- **AND** the MSW handler responds to `listPostsByAuthor` with one item
- **THEN** the test asserts a heading with text `Alice`
- **AND** asserts a `role=article` with name `Post` is rendered
- **AND** asserts no `role=textbox` is rendered.

#### Scenario: Empty-list test asserts heading and empty state

- **WHEN** the test mounts `<ProfilePage />` for a user whose `listPostsByAuthor` returns `200 { items: [], nextCursor: null }`
- **THEN** the test asserts the heading is present
- **AND** asserts no `role=article` `Post` is rendered
- **AND** asserts an empty-state affordance is present.

#### Scenario: 404 test asserts the not-found affordance

- **WHEN** the test mounts `<ProfilePage />` for a `userId` whose `getUser` returns `404 ProblemDetail`
- **THEN** the test asserts the "User not found" affordance is rendered
- **AND** asserts no heading and no `PostList` are rendered.

### Requirement: Playwright e2e spec exercises the profile route end-to-end

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/profile.spec.ts` that exercises the profile route end-to-end against the real backend and frontend in two scenarios, one `test()` block per scenario.

#### Scenario: Author navigates to their own profile via the PostCard author link

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds one post authored by Alice via `apiClient.createPost(aliceToken, { body: 'Profile seed post' })`
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** observes a `role=article` with accessible name `Post` containing `Profile seed post`
- **AND** clicks the `role=link` with accessible name equal to Alice's `displayName` on her own card
- **AND** observes the URL match `/users/{aliceId}`
- **AND** observes a heading with text equal to Alice's `displayName`
- **AND** observes a `role=article` with accessible name `Post` containing `Profile seed post`
- **AND** observes no `role=textbox` on the page.

#### Scenario: Non-author visits another user's profile directly by URL

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI), captures her id
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds one post authored by Alice via `apiClient.createPost(aliceToken, { body: 'Profile cross-user seed post' })`
- **AND** signs up Bob via the `apiClient` (no UI) with a distinct email
- **AND** logs Bob in via the SPA's login form and lands on `/home`
- **AND** navigates Bob directly to `/users/{aliceId}` via `page.goto`
- **AND** observes the URL ends `/users/{aliceId}`
- **AND** observes a heading with text equal to Alice's `displayName`
- **AND** observes a `role=article` with accessible name `Post` containing `Profile cross-user seed post`
- **AND** observes no `role=button` with accessible name `Delete post` within that card
- **AND** observes no `role=textbox` on the page.

### Requirement: E2E ApiClient supports authenticated user fetch

The e2e `ApiClient` SHALL expose an authenticated `getUser(token, userId)` method that performs `GET /api/v1/users/{userId}` with `Authorization: Bearer <token>` and returns a `{ status, body }` shape consistent with the existing `signup`, `login`, `createPost`, `deletePost`, and `listPostsByAuthor` methods. The implementation SHALL use the Orval-generated `getGetUserUrl(userId)` from `e2e/src/api/generated/users-controller/users-controller.ts`, NOT a hardcoded URL.

#### Scenario: ApiClient exposes authenticated getUser

- **WHEN** a test calls `apiClient.getUser(token, userId)` with a valid bearer `token` and an existing `userId`
- **THEN** the helper performs `GET /api/v1/users/{userId}` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing helpers
- **AND** on a 200 response the `body` is a `UserSummary` containing exactly `id` and `displayName`.

#### Scenario: ApiClient.getUser uses the generated URL helper

- **WHEN** a reader inspects the implementation of `apiClient.getUser`
- **THEN** the implementation imports `getGetUserUrl` from `e2e/src/api/generated/users-controller/users-controller.ts`
- **AND** does NOT hardcode the string `/api/v1/users` or any literal path containing it.

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
