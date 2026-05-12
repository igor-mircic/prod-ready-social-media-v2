## Context

Code state verified against the tree at change-draft time:

- `backend/src/main/java/com/prodready/social/useraccounts/AuthController.java`
  exposes `GET /api/v1/auth/me` returning `UserResponse(id, email,
  displayName, createdAt)`. `UserResponse` is the broad shape and rightly
  includes `email`; this endpoint is scoped to the caller's own account.
- `backend/src/main/java/com/prodready/social/posts/AuthorSummary.java`
  is the public summary embedded inside `PostResponse`: `(UUID id, String
  displayName)`. The `posts` capability spec explicitly bans `email`,
  `password`, and `passwordHash` from this surface — that ban is the
  reason `AuthorSummary` exists separately from `UserResponse`.
- `backend/src/main/java/com/prodready/social/posts/PostsController.java`
  already exposes `GET /api/v1/users/{userId}/posts` and the cross-user
  list contract is e2e-proven through `apiClient` only — the SPA has no
  route to render another user's posts today.
- `frontend/src/App.tsx` wires routes under `<BrowserRouter>` with
  `<ProtectedRoute>` guarding `/home`. `react-router-dom` is already a
  dependency.
- `frontend/src/features/posts/PostCard.tsx` renders the author's
  `displayName` as plain text inside the card; the card itself is a
  `role="article"` with accessible name `Post`. The Delete control is
  conditionally rendered only when `author.id === currentUser.id`.
- `frontend/src/features/posts/PostList.tsx` consumes the Orval-generated
  list query through `useInfiniteQuery`, takes a `userId` prop, and is
  the same component HomePage uses scoped to the current user.
- `e2e/src/helpers/apiClient.ts` exposes `signup`, `login`,
  `listPostsByAuthor(token, authorId, params?)`, `createPost`,
  `deletePost`. There is no `getUser(token, userId)` helper today.

## Goals / Non-Goals

**Goals:**

- Land a thin, read-only `GET /api/v1/users/{userId}` that returns a
  public `UserSummary { id, displayName }` and never leaks `email` /
  `password` / `passwordHash` / `createdAt`.
- Ship a `/users/:userId` SPA route that renders any user's display name
  and posts, reusing the existing `PostList` component.
- Make the author's name on every `PostCard` a link into that route so
  navigation is one click from `/home`.
- Reuse the existing cross-user list contract unchanged — this change is
  pure UI + one new endpoint + e2e proof of the round-trip.

**Non-Goals:**

- Follows, unfollow, follower counts, mutual-follow detection. No social
  graph in this change.
- Edit-profile, avatars, bios, password change. The profile is read-only.
- User search / discovery. No `GET /api/v1/users` collection endpoint.
- Privacy / visibility settings. All profiles visible to all
  authenticated callers, consistent with `posts`.
- Public-by-link profile pages. `/users/:userId` is auth-required.
- A `users` schema change. The existing `users` table is sufficient.

## Decisions

### Decision 1: New endpoint returns `UserSummary {id, displayName}`, not `UserResponse`

The new `GET /api/v1/users/{userId}` SHALL return a body with exactly
`id` (UUID) and `displayName` (string). It SHALL NOT return `email`,
`password`, `passwordHash`, or `createdAt`.

**Why not return `UserResponse`?** `UserResponse` includes `email`, which
the `posts` capability already established is account-private — the
`PostResponse embeds an author summary` requirement explicitly forbids
`email` on a cross-user surface. Returning `UserResponse` from a
cross-user endpoint would directly contradict that. `/me` is the only
endpoint that should leak `email`, and only to the caller themselves.

**Why include `id` in the body even though the caller already supplied
it in the path?** Consistency with `AuthorSummary` and `UserResponse`,
both of which embed `id`. The schema is the same shape consumers already
know from `PostResponse.author`.

### Decision 2: Separate Java record `useraccounts/UserSummary`, do NOT move `posts/AuthorSummary`

The new endpoint's response type SHALL be a new record
`useraccounts/UserSummary(UUID id, String displayName)`. The existing
`posts/AuthorSummary` SHALL stay in the `posts/` package, unmoved.

**Why duplicate the shape across two Java types instead of sharing one?**
Three reasons:

1. **Package ownership clarity.** `AuthorSummary` is *the embedded
   author of a Post* — its name reads correctly inside `PostResponse`.
   `UserSummary` is *a user, summarized publicly* — its name reads
   correctly as the response type of `GET /api/v1/users/{id}`. Renaming
   either to fit the other (`AuthorSummary` returned from a `users`
   endpoint, or `UserSummary` embedded inside posts) is awkward at the
   call site.
2. **No cross-package coupling.** `posts` already depends on
   `useraccounts` for `User` and `UserRepository`. Adding a reverse
   dependency for the shared DTO (or pulling one of them up to a
   `shared/` package that doesn't exist yet) would invent a new package
   for two-field savings.
3. **OpenAPI dedup is structural, not by-Java-type.** Both records have
   the same JSON shape `{id: uuid, displayName: string}`. The OpenAPI
   snapshot will emit a single schema and reference it from both
   responses (or two structurally-identical schemas — the contract
   surface to frontend/e2e consumers is identical either way).

The future option to extract a `shared/` package and unify the type
stays open; it's just not earned by this change alone. Revisit if a
third caller appears.

### Decision 3: Endpoint is authenticated under the existing deny-by-default chain

`GET /api/v1/users/{userId}` SHALL require a valid `Authorization:
Bearer <access-token>` header and SHALL fall under the existing
`SecurityFilterChain` with NO new allowlist entry. Unauthenticated
callers receive `401 ProblemDetail`.

**Why not public?** The existing `posts` cross-user list is
auth-required (any authenticated caller can read any user's posts, but
no unauthenticated read). Profile point-lookup follows the same rule for
consistency: an authenticated graph, not a public-by-link one. Public
profiles are a separately-spec'd follow-up if needed.

### Decision 4: Unknown id returns 404, not 403

A `GET` for a syntactically-valid UUID that does not exist in `users`
SHALL return `404 ProblemDetail`. There is no need for the "indistinguishable
from cross-user / soft-deleted" non-disclosure pattern that `DELETE
/api/v1/posts/{id}` uses: there is no soft-delete on `users` today, and
the read is permitted for any authenticated caller anyway, so `404` for
unknown is the clean answer.

### Decision 5: Profile page fetches user and posts as two parallel queries

`ProfilePage` SHALL fire the Orval-generated `useGetUser` and
`useListPostsByAuthor` (via `PostList`) queries independently. They do
not depend on each other; rendering the page does not wait for both —
the header renders as soon as the user query resolves, and the list
renders as soon as the list query resolves. Each query owns its own
loading/error state.

**Why not chain?** Chaining adds a serial round-trip for no payoff: the
list endpoint already returns `404` for unknown `userId`, but it also
returns `200 {items:[], nextCursor:null}` for a real user with zero
posts. Distinguishing "unknown user" from "real user with no posts"
needs the explicit user fetch, but the list fetch can run in parallel
with it.

**Empty list state.** If the user fetch returns `200 {id, displayName}`
and the list fetch returns `200 {items: [], nextCursor: null}`,
`ProfilePage` SHALL render the header and an empty-state message under
the empty list (e.g. "No posts yet"). The list component already
handles its own empty render — `ProfilePage` does not need to special-case
it beyond a minor styling pass.

**Unknown-user state.** If the user fetch returns `404`, `ProfilePage`
SHALL render an "User not found" message at the page level. It SHALL
NOT redirect to `/not-found` — the URL stays as `/users/:userId` so the
user can edit the id directly in the address bar without losing the
route. (Mirrors how the SPA's existing routing handles bad URLs — the
NotFound component is for non-routes, not for valid-route + bad-id.)

### Decision 6: `PostCard` author renders as a `react-router-dom` `<Link>`

The author's `displayName` SHALL render inside a
`react-router-dom` `<Link to={`/users/${author.id}`}>`. The link's
accessible name SHALL equal the `displayName`. The `<article>` element
of the card SHALL remain non-link — only the author's name is the
navigation target.

**Why not wrap the whole card in a link?** Two reasons:

1. The card already has interactive children (the Delete button for
   own posts, and presumably more in future — Reply, Like, etc.). A
   wrapping link conflicts with nested `button` accessibility and
   click semantics.
2. Mental model: clicking a post's *body* should open the post (a future
   capability), not jump to the author. Keeping the author's *name*
   as the only link disambiguates.

**Why `Link` not `<a href="...">`?** `react-router-dom` `<Link>` does
client-side navigation; a raw `<a>` would full-page reload and lose the
in-memory `AuthContext`'s access token (refresh would silently kick in
to re-bootstrap, but the navigation cost is a regression on every author
click).

### Decision 7: Route under `<ProtectedRoute>` in `App.tsx`

`/users/:userId` SHALL sit inside the existing `<Route
element={<ProtectedRoute />}>` block alongside `/home`. Unauthenticated
visits SHALL redirect to `/login` via the existing `ProtectedRoute`
behavior (no new redirect code).

### Decision 8: New e2e helper `apiClient.getUser(token, userId)` uses the Orval-generated URL helper

The helper SHALL follow the pattern set by `createPost`, `deletePost`,
and `listPostsByAuthor`: import the Orval-generated `getGetUserUrl(...)`
from `e2e/src/api/generated/users-controller/users-controller.ts` and
use it as the URL, NOT a hardcoded string. Return shape is the existing
`{ status, body }` consistent with the other helpers.

**Why add the helper at all when the e2e test could derive `aliceId`
from the `signup` response?** It can — and for the profile happy-path
test it does. But:

1. The profile axe scan and the cross-browser variants benefit from a
   small `getUser` round-trip that doesn't depend on a successful prior
   signup having returned the id.
2. Future capabilities (follows, feed) will read users by id from the
   e2e layer, and the helper keeps that pattern uniform.
3. The cost is ~15 lines mirroring `listPostsByAuthor`'s shape.

### Decision 9: PostList's existing `userId` prop is the integration point — no `PostList` changes

`ProfilePage` SHALL render `<PostList userId={routeUserId} />`. The
existing `PostList` already:

- accepts `userId` as a prop,
- fires `useListPostsByAuthor({ userId })` via `useInfiniteQuery`,
- delegates per-card rendering to `PostCard`,
- gates the Delete control inside `PostCard` on `author.id ===
  currentUser.id`.

No `PostList` code changes. No `PostCard` changes beyond the
author-link wrap (Decision 6).

## Risks / Trade-offs

- **[Risk] Adding `UserSummary` as a second Java type duplicates two
  fields.** → Mitigation: it's a record with two fields. The cost of a
  future unification (extract a `shared/` package, retire `AuthorSummary`)
  is bounded and only worth paying when there's a third caller. Picking
  duplication now keeps cross-package coupling out.
- **[Risk] Two queries on `ProfilePage` mean two loading spinners can
  flash at different times.** → Mitigation: the user fetch is a tiny
  point-lookup that resolves quickly; the list fetch is the larger of
  the two and dictates the visible perceived load time. The header can
  render its own skeleton or a brief "..." while the user fetch is in
  flight without significantly affecting perceived perf.
- **[Risk] `PostCard` author rendering as a link adds keyboard-tabbable
  surface that wasn't there before.** → Mitigation: this is a strict
  a11y win, not a regression — currently the author's name is
  unfocusable text. The axe scan covers the new link without needing
  special-cased rules.
- **[Trade-off] Profile page is read-only; you can navigate *to* it but
  the only mutation surface for posts stays on `/home`.** Acceptable:
  the only mutation an author can do today is delete (composer is for
  the caller only). On the profile route, an author viewing their own
  page sees their own posts with the Delete control (since `PostCard`
  already conditionally renders it for own posts) — so the cross-user
  vs. self-view delete affordance keeps working uniformly on the
  profile route. Future "Edit profile" or composer-on-own-profile lands
  in its own change.
- **[Risk] If a future change introduces soft-delete or visibility flags
  on `users` (e.g. account deactivation), the new endpoint's `404 for
  unknown` rule may need an "indistinguishable" non-disclosure variant
  similar to posts.** → Mitigation: that's a future change's problem;
  re-spec the requirement then. Today there is no soft-delete on
  `users`.
- **[Risk] `react-router-dom` `<Link>` requires the component to render
  inside a `BrowserRouter`. The existing `PostCard.test.tsx` mounts
  cards in isolation.** → Mitigation: wrap mounts in `<MemoryRouter>` in
  the affected vitest cases. Existing patterns elsewhere in
  `frontend/src` already use this wrapper; minimal lift.
