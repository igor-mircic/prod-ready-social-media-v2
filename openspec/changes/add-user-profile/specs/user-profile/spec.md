## ADDED Requirements

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
