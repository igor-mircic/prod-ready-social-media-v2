## ADDED Requirements

### Requirement: PostCard author renders as a link to the author's profile

The `frontend/src/features/posts/PostCard.tsx` component SHALL render the author's `displayName` inside a `react-router-dom` `<Link to={`/users/${author.id}`}>`. The link's accessible name SHALL equal the author's `displayName`. The `<article>` element of the card itself SHALL NOT be a link — only the author's name is the navigation target. Existing behaviors of `PostCard` (the conditional Delete control on own posts, the rendered body, the rendered `createdAt`) SHALL be unchanged.

#### Scenario: Author renders as a link with the correct href

- **WHEN** a reader inspects `frontend/src/features/posts/PostCard.tsx`
- **THEN** the rendered author `displayName` is wrapped in a `react-router-dom` `<Link>`
- **AND** the link's `to` prop equals `/users/{author.id}` (interpolating the author's UUID)
- **AND** the link's rendered text content equals the author's `displayName`.

#### Scenario: PostCard's <article> is not itself a link

- **WHEN** a reader inspects `frontend/src/features/posts/PostCard.tsx`
- **THEN** the `<article>` element has no `<Link>` wrapper around it
- **AND** the only `role=link` inside the card is the author's `displayName`.

#### Scenario: Clicking the author link navigates to the profile route

- **WHEN** a user clicks the author's `displayName` on a rendered `PostCard`
- **THEN** the SPA navigates to `/users/{author.id}` via client-side routing (no full page reload).

#### Scenario: Vitest covers the author-link affordance

- **WHEN** a reader inspects `frontend/src/features/posts/PostCard.test.tsx`
- **THEN** the test file wraps card renders in a `react-router-dom` router (e.g. `MemoryRouter`)
- **AND** asserts that the author's name renders as a `link` whose accessible name equals the `displayName`
- **AND** asserts the link's `href` resolves to `/users/{author.id}`.

## MODIFIED Requirements

### Requirement: Playwright e2e spec proves explicit axe scans on key routes

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/axe.routes.spec.ts` that performs explicit `runAxeScan` calls on four key routes: `/login`, `/signup`, `/home` (after a fresh user has signed up, logged in, and seeded one post via the `apiClient` so the composer and list are both rendered with non-trivial content), and `/users/:userId` (using the same signed-in user's id so the profile page renders the header and the seeded post). The scans SHALL use the existing `runAxeScan` fixture without modification. The spec SHALL be a single `test()` walking the four routes sequentially.

#### Scenario: Axe scans clean across /login, /signup, /home, and /users/:userId

- **WHEN** the Playwright spec runs against the harness
- **THEN** it visits `/login` and runs `runAxeScan` and observes no violations
- **AND** it visits `/signup` and runs `runAxeScan` and observes no violations
- **AND** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds one post authored by Alice via `apiClient.createPost(aliceToken, { body: 'Axe seed post' })`
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** the rendered page contains a `role=article` with accessible name `Post` containing `Axe seed post`
- **AND** runs `runAxeScan` on `/home` and observes no violations
- **AND** navigates to `/users/{aliceId}` via `page.goto`
- **AND** the rendered page contains a heading with text equal to Alice's `displayName`
- **AND** the rendered page contains a `role=article` with accessible name `Post` containing `Axe seed post`
- **AND** runs `runAxeScan` on `/users/{aliceId}` and observes no violations.
