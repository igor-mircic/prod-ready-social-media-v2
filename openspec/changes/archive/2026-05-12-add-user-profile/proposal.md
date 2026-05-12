## Why

The SPA can authenticate, compose posts, and list posts only for the
signed-in user on `/home`. The backend already exposes
`GET /api/v1/users/{userId}/posts` for cross-user reads, and the e2e suite
already proves that contract end-to-end — but only through the `apiClient`
helper, because (as the existing `posts.cross-user.spec.ts` and
`posts.cross-user.pagination.spec.ts` proposals/specs explicitly note) the
SPA has no route to view another user's posts. That gap is a real usability
hole today and a structural blocker for the next two domain capabilities
the project context calls out as upcoming — **follows** and **feed** — both
of which need a profile surface to attach a Follow button to and to
navigate into from a multi-author timeline.

This change introduces the user-profile surface: a thin
`GET /api/v1/users/{userId}` point-lookup, a new SPA route
`/users/:userId` rendering a `ProfilePage`, and the `PostCard` author-name
becoming a link into that route. The backend's existing cross-user list
contract is reused unchanged; this change wires it into the UI and adds
the small fetch needed to render a profile header for a user with zero
posts.

## What Changes

- **Backend — add `GET /api/v1/users/{userId}`** returning a public
  `UserSummary { id, displayName }` body. The endpoint sits under the
  existing deny-by-default `SecurityFilterChain` (no allowlist entry).
  The response body's schema is the same `{id, displayName}` shape that
  already embeds as `AuthorSummary` inside `PostResponse`, and SHALL NOT
  include `email`, `password`, `passwordHash`, or `createdAt`. (Contrast
  with `GET /api/v1/auth/me`, which returns the broader `UserResponse`
  including `email` and is rightly scoped to the caller's own account.)
  Returns `404 ProblemDetail` for an unknown id and `401` for
  unauthenticated callers.
- **Backend — Testcontainers `*IT.java`** covering happy path, 404
  unknown id, 401 unauthenticated, and a "no email leak" assertion that
  pins the body shape to exactly `{id, displayName}`.
- **API contract — refresh `openapi/openapi.json`** to include the new
  endpoint and the `UserSummary` schema; the existing CI drift check
  enforces this. Orval regenerates the frontend and e2e client surfaces.
- **Frontend — new feature module `frontend/src/features/profile/`**
  containing a `ProfilePage` component that, given a `userId` from the
  URL, fetches the user via the Orval-generated query and renders:
  - the user's `displayName` as the page header,
  - a `<PostList userId={userId} />` (the existing component, reused),
  - **no** `PostComposer` (composing for another user is meaningless).
  The existing `PostCard` already shows the Delete control only for the
  caller's own posts, so the cross-user case naturally hides Delete with
  no `PostCard` code changes.
- **Frontend — protected route `/users/:userId`** wired into
  `frontend/src/App.tsx` under the existing `ProtectedRoute` element
  (parallel to `/home`).
- **Frontend — `PostCard` author becomes a link.** The author's
  `displayName` SHALL render as a `<Link to={`/users/${author.id}`}>`,
  so users can navigate from any post (including their own on `/home`)
  into the author's profile.
- **Frontend — Vitest** covering: profile renders header + list for a
  user with posts; profile renders header + empty-state for a user with
  zero posts; profile renders a 404 fallback for an unknown id; the
  author link on `PostCard` carries the correct `href`.
- **E2E — `apiClient.getUser(token, userId)` helper** in
  `e2e/src/helpers/apiClient.ts` using the Orval-generated URL helper,
  parallel to the existing `signup` / `login` / `listPostsByAuthor` /
  `createPost` / `deletePost` methods.
- **E2E — `e2e/tests/profile.spec.ts`** exercising the full vertical:
  - Alice signs up via `apiClient`, seeds one post via `apiClient`, logs
    in via the SPA, lands on `/home`, clicks her own name on the
    rendered `PostCard`, lands on `/users/{aliceId}`, sees the
    `displayName` header and her seeded post body in a `PostCard`, and
    sees no `role=textbox` for the composer.
  - Bob signs up via `apiClient`, logs in via the SPA, navigates
    directly to `/users/{aliceId}`, sees Alice's header and post, and
    sees no `Delete` button on Alice's post.
- **E2E — axe scan** of `/users/:userId` for an authenticated user,
  added under the existing `axe.routes.spec.ts` "explicit axe scans on
  key routes" requirement (one additional `runAxeScan` call against a
  freshly-rendered profile route with a seeded post).

### Explicit non-goals (deferred to follow-ups)

- **Follows / unfollow.** No `follows` table, no follow endpoint, no
  Follow button on the profile page. That work lands in its own change
  once the social-graph backend is built.
- **Edit-profile flow.** Changing `displayName`, `email`, or `password`
  via the SPA is out of scope. The new endpoint is read-only.
- **Avatar / profile picture.** No upload, no image storage. The
  `users` table is unchanged.
- **Bio / about text.** No new column on `users`.
- **User discovery / search.** This change adds only the point-lookup
  `GET /api/v1/users/{userId}`. Listing arbitrary users, search, and
  pagination of `users` are follow-ups.
- **Privacy / visibility settings.** All profiles are visible to all
  authenticated callers, consistent with the existing posts model
  (cross-user list is already permitted by the `posts` spec).
- **Public-by-link profiles.** `/users/:userId` is auth-required (sits
  under `ProtectedRoute` like `/home`). Unauthenticated public profiles
  are a follow-up.
- **Flyway migration / schema change.** The existing `users` table is
  sufficient; no `V*__*.sql` is added.
- **`PostCard` Delete-control changes.** The existing requirement
  ("PostCard renders the delete control only for the caller's own
  posts") is unchanged and unconditionally already gives the right
  cross-user behavior on the profile page.

## Capabilities

### New Capabilities

- `user-profile` — the SPA route and page that render another user's
  display name and posts, the `PostCard` author-link affordance that
  navigates into that route, the Vitest coverage of the page, the
  Playwright vertical spec, and the axe coverage on the new route.

### Modified Capabilities

- `user-accounts` — adds a new requirement: an authenticated
  `GET /api/v1/users/{userId}` endpoint that returns a public
  `UserSummary { id, displayName }`, 404 for unknown, 401 for
  unauthenticated, and never leaks `email` / `password` / `createdAt`.
  Existing requirements (signup, login, refresh, logout, `/me`) are not
  modified.
- `posts` — adds a requirement that `PostCard`'s author `displayName`
  renders as a `<Link>` to `/users/{author.id}`. Existing posts
  requirements (composer, list, delete, pagination, cross-user contract,
  composer hardening, etc.) are not modified.

## Impact

- **Backend:**
  - New: `useraccounts/UsersController.java` exposing
    `GET /api/v1/users/{userId}`. Lives in the `useraccounts` package
    alongside `AuthController` because users are a `user-accounts`
    concept; the controller is split from `AuthController` because the
    route is `/api/v1/users/**`, not `/api/v1/auth/**`.
  - New: `useraccounts/UserSummary.java` record `(UUID id, String
    displayName)`. The existing `posts/AuthorSummary` record will
    continue to live in `posts/` (it's owned by `PostResponse`); the
    OpenAPI schema for the two will deduplicate at the contract layer
    if their shapes stay aligned. Whether to share a single Java type
    is a design.md decision.
  - New: `useraccounts/UsersControllerIT.java` covering the four cases
    above, matching the existing `*IT.java` Testcontainers pattern.
- **Frontend:**
  - New: `frontend/src/features/profile/ProfilePage.tsx`,
    `ProfilePage.test.tsx`.
  - Modified: `frontend/src/App.tsx` adds the
    `/users/:userId` route under `<ProtectedRoute>`.
  - Modified: `frontend/src/features/posts/PostCard.tsx` to render
    `author.displayName` inside a `react-router-dom` `<Link>`. The
    existing `PostCard.test.tsx` gets one new assertion (link `href`
    equals `/users/{author.id}`).
- **API contract / codegen:**
  - `openapi/openapi.json` regenerated to include
    `GET /api/v1/users/{userId}` and the `UserSummary` schema.
  - Orval regenerates `frontend/src/api/generated/users-controller/...`
    and the matching `e2e/src/api/generated/users-controller/...`.
- **E2E:**
  - New: `e2e/tests/profile.spec.ts` (two scenarios: own-profile via
    UI navigation, other-user-profile via direct URL).
  - Modified: `e2e/src/helpers/apiClient.ts` adds `getUser(token,
    userId)`.
  - Modified: `e2e/tests/axe.routes.spec.ts` (or a sibling under the
    same requirement) gains a `/users/{userId}` axe scan against a
    seeded, signed-in session.
- **OpenSpec specs:**
  - New: `openspec/specs/user-profile/spec.md` (capability spec for the
    new profile surface — created during the openspec workflow's
    artifact step).
  - Modified: `openspec/specs/user-accounts/spec.md` gains a new
    requirement for the `GET /api/v1/users/{userId}` endpoint.
  - Modified: `openspec/specs/posts/spec.md` gains a single scenario
    under the existing `Frontend ships a posts feature module wired to
    the generated hooks` requirement asserting that `PostCard`'s author
    renders as a `<Link>` to the profile route. (Or, if cleaner during
    spec drafting, lifted into its own small requirement — design call.)
- **CI:** No new jobs. The existing OpenAPI drift check, Vitest job,
  backend integration tests, and Playwright job pick up the new files
  automatically.
- **Database:** No migration. The existing `users` table is sufficient.
- **Dependencies:** None added. `react-router-dom` is already a
  dependency (`App.tsx` uses `BrowserRouter` / `Route` today).
