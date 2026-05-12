# posts Specification

## Purpose
TBD - created by archiving change add-posts. Update Purpose after archive.
## Requirements
### Requirement: A `posts` table is created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V3__create_posts.sql` that creates a `posts` table with columns sufficient to represent an authored post with soft-delete semantics: a primary key, an author foreign key, a body, a creation timestamp, and a nullable deletion timestamp.

#### Scenario: Migration creates the table

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** a `posts` table exists
- **AND** has a primary key column `id` of type `UUID`
- **AND** has an `author_id` column of type `UUID NOT NULL` with a foreign key to `users(id)` declared `ON DELETE RESTRICT`
- **AND** has a `body` column of type `TEXT NOT NULL`
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` with a default of `now()`
- **AND** has a `deleted_at` column of type `TIMESTAMPTZ NULL`.

#### Scenario: Author foreign key is RESTRICT, not CASCADE

- **WHEN** a reader inspects the migration
- **THEN** the `author_id` foreign-key constraint declares `ON DELETE RESTRICT`
- **AND** the constraint does NOT declare `ON DELETE CASCADE` or `ON DELETE SET NULL`.

#### Scenario: Composite index supports the author-timeline read pattern

- **WHEN** a reader inspects the migration
- **THEN** an index `posts_author_created_idx` exists on `posts (author_id, created_at DESC, id DESC)`
- **AND** the index is partial with predicate `WHERE deleted_at IS NULL`.

### Requirement: Create-post endpoint persists a new post

The backend SHALL expose `POST /api/v1/posts` accepting a JSON body of `{ body: string }`. On success, the endpoint SHALL persist a new `posts` row whose `author_id` is the authenticated caller, and SHALL return `201 Created` with a `PostResponse` body.

#### Scenario: Successful create persists the post and returns the resource

- **WHEN** an authenticated client posts a valid `{ body }` to `POST /api/v1/posts`
- **THEN** the response status is 201
- **AND** the response body is a `PostResponse` containing the new post's `id`, embedded `author` summary (`id`, `displayName`), `body`, and `createdAt`
- **AND** a new row exists in `posts` whose `author_id` matches the authenticated user's id and whose `body` matches the request
- **AND** the new row's `deleted_at` is `NULL`.

#### Scenario: Create requires authentication

- **WHEN** a client posts to `POST /api/v1/posts` without an `Authorization` header
- **THEN** the response status is 401
- **AND** no new row is inserted into `posts`.

### Requirement: Create-post validates the body

The create endpoint SHALL validate the request using `jakarta.validation` annotations on the request DTO. The `body` SHALL be non-blank and SHALL be no longer than 500 characters. Validation failures SHALL be rejected with `400 ProblemDetail` whose extensions enumerate the failing fields.

#### Scenario: Empty body is rejected

- **WHEN** an authenticated client posts a create request whose `body` is missing, empty, or whitespace-only
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `body` among the failing fields
- **AND** no row is inserted into `posts`.

#### Scenario: Over-length body is rejected

- **WHEN** an authenticated client posts a create request whose `body` exceeds 500 characters
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `body` among the failing fields
- **AND** no row is inserted into `posts`.

### Requirement: Read-post-by-id endpoint returns the post

The backend SHALL expose `GET /api/v1/posts/{id}`. On success, the endpoint SHALL return `200 OK` with a `PostResponse` body for the requested post. The endpoint SHALL exclude soft-deleted rows. Read access is NOT scoped to the post's author — any authenticated caller SHALL be able to read any non-deleted post.

#### Scenario: Read returns the post

- **WHEN** an authenticated client calls `GET /api/v1/posts/{id}` for an existing, non-deleted post
- **THEN** the response status is 200
- **AND** the response body is a `PostResponse` containing `id`, `author` (`id`, `displayName`), `body`, and `createdAt`.

#### Scenario: Read returns 404 for an unknown id

- **WHEN** an authenticated client calls `GET /api/v1/posts/{id}` with an id that does not exist
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: Read returns 404 for a soft-deleted post

- **WHEN** an authenticated client calls `GET /api/v1/posts/{id}` for a post whose `deleted_at IS NOT NULL`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: Read requires authentication

- **WHEN** a client calls `GET /api/v1/posts/{id}` without an `Authorization` header
- **THEN** the response status is 401.

#### Scenario: Cross-user read is permitted

- **WHEN** an authenticated client whose user id is NOT equal to the post's `author_id` calls `GET /api/v1/posts/{id}` for an existing, non-deleted post
- **THEN** the response status is 200
- **AND** the response body is the same `PostResponse` shape that the author would receive.

### Requirement: List-posts-by-author endpoint is cursor-paginated

The backend SHALL expose `GET /api/v1/users/{userId}/posts` that returns the requested user's non-deleted posts ordered by `created_at DESC, id DESC`. The endpoint SHALL accept optional query parameters `cursor` (opaque string) and `limit` (integer). The response body SHALL be `{ items: PostResponse[], nextCursor: string | null }`. List access is NOT scoped to the path's `userId` — any authenticated caller SHALL be able to list any user's non-deleted posts.

#### Scenario: First page returns the most recent posts

- **WHEN** an authenticated client calls `GET /api/v1/users/{userId}/posts` with no `cursor`
- **THEN** the response status is 200
- **AND** the response body's `items` is an array of `PostResponse` objects ordered by `createdAt` descending (ties broken by `id` descending)
- **AND** none of the returned items has been soft-deleted
- **AND** if there are more rows beyond the page, `nextCursor` is a non-null string; otherwise `nextCursor` is `null`.

#### Scenario: Subsequent page advances by cursor

- **WHEN** an authenticated client calls `GET /api/v1/users/{userId}/posts?cursor=<nextCursor-from-previous-page>`
- **THEN** the response status is 200
- **AND** the response body's `items` are the next page of posts strictly older than the cursor (by the `(created_at DESC, id DESC)` ordering)
- **AND** no item from the previous page appears on this page.

#### Scenario: limit parameter is honored within the cap

- **WHEN** an authenticated client calls the list endpoint with `?limit=N` for any `1 <= N <= 50`
- **THEN** the response's `items` length is at most `N`.

#### Scenario: Default and cap for limit

- **WHEN** an authenticated client omits `limit`
- **THEN** the server treats `limit` as `20`.

- **WHEN** an authenticated client supplies `limit` greater than `50`
- **THEN** the server clamps the effective limit to `50`.

#### Scenario: Soft-deleted posts are excluded from the list

- **WHEN** an authenticated client calls the list endpoint for a user whose posts include both live and soft-deleted rows
- **THEN** the response's `items` contains no `PostResponse` for any soft-deleted post
- **AND** pagination still terminates correctly (the `nextCursor` reflects only live rows).

#### Scenario: Unknown userId returns 404

- **WHEN** an authenticated client calls `GET /api/v1/users/{userId}/posts` with a syntactically-valid `userId` that does not exist in `users`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: List requires authentication

- **WHEN** a client calls `GET /api/v1/users/{userId}/posts` without an `Authorization` header
- **THEN** the response status is 401.

#### Scenario: Cross-user list is permitted

- **WHEN** an authenticated client whose own user id is NOT equal to the path `userId` calls `GET /api/v1/users/{userId}/posts`
- **THEN** the response status is 200
- **AND** the response body is the same `{ items, nextCursor }` shape that the path-user would receive.

### Requirement: Cursor is opaque and versioned

The list endpoint's `nextCursor` SHALL be an opaque `base64url`-encoded string whose decoded byte sequence is `[version-byte] [created_at-millis-since-epoch, 8 bytes big-endian] [id-uuid, 16 bytes]`. Clients SHALL treat the cursor as opaque.

#### Scenario: Decoded cursor carries a version byte

- **WHEN** a reader decodes a server-issued `nextCursor` from base64url
- **THEN** the first byte is `0x01`
- **AND** the next 8 bytes are the milliseconds-since-epoch of the page's last item's `createdAt`, big-endian
- **AND** the final 16 bytes are the page's last item's `id` encoded as a UUID.

#### Scenario: Malformed cursor is rejected

- **WHEN** an authenticated client calls the list endpoint with a `cursor` that is not valid base64url, has the wrong length, or has an unrecognized version byte
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `cursor` among the failing fields
- **AND** no list is returned.

### Requirement: Delete-post endpoint soft-deletes the caller's own post

The backend SHALL expose `DELETE /api/v1/posts/{id}`. On success, the endpoint SHALL set `deleted_at = now()` on the post row and SHALL return `204 No Content`. The endpoint SHALL refuse to delete posts the caller does not author. A non-author delete SHALL be rejected with `404 Not Found` (not `403 Forbidden`) as a deliberate non-disclosure choice: the endpoint MUST NOT reveal to a non-author whether a given `postId` exists. The same `404` response is returned for an unknown id, a soft-deleted id, and another user's id — externally indistinguishable.

#### Scenario: Author can soft-delete their own post

- **WHEN** an authenticated client calls `DELETE /api/v1/posts/{id}` for a post whose `author_id` is the caller's id and whose `deleted_at IS NULL`
- **THEN** the response status is 204
- **AND** the post row's `deleted_at` is set to a non-null `TIMESTAMPTZ`
- **AND** the row is NOT physically removed from `posts`.

#### Scenario: Subsequent reads of a soft-deleted post return 404

- **WHEN** the same client (after delete) calls `GET /api/v1/posts/{id}` for the just-deleted post
- **THEN** the response status is 404.

#### Scenario: Deleting a post authored by someone else returns 404

- **WHEN** an authenticated client calls `DELETE /api/v1/posts/{id}` for a post whose `author_id` is NOT the caller's id
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404
- **AND** the post row is unchanged (its `deleted_at` remains `NULL`).

#### Scenario: Deleting a missing post returns 404

- **WHEN** an authenticated client calls `DELETE /api/v1/posts/{id}` with an id that does not exist
- **THEN** the response status is 404.

#### Scenario: Deleting an already-soft-deleted post returns 404

- **WHEN** an authenticated client calls `DELETE /api/v1/posts/{id}` for a post whose `deleted_at IS NOT NULL`
- **THEN** the response status is 404
- **AND** the post row's `deleted_at` is not updated.

#### Scenario: Delete requires authentication

- **WHEN** a client calls `DELETE /api/v1/posts/{id}` without an `Authorization` header
- **THEN** the response status is 401.

#### Scenario: 404 responses for cross-user, unknown, and soft-deleted ids are indistinguishable

- **WHEN** a non-author authenticated client calls `DELETE /api/v1/posts/{id}` for each of: (a) another user's live post, (b) a syntactically-valid id that does not exist, (c) a soft-deleted post
- **THEN** all three responses have status 404
- **AND** all three response bodies are `ProblemDetail` with `status` 404
- **AND** no field of the response body discloses which of (a), (b), or (c) the id actually was.

### Requirement: PostResponse embeds an author summary

Every `PostResponse` produced by the API SHALL embed a minimal author summary alongside the post's own fields. The author summary SHALL contain exactly `id` and `displayName`. The response SHALL NOT include `password`, `password_hash`, `email`, or any other account-private field.

#### Scenario: PostResponse shape

- **WHEN** a reader inspects the `PostResponse` schema in `openapi/openapi.json`
- **THEN** the schema declares exactly the properties `id` (uuid), `author` (object with `id` (uuid) and `displayName` (string)), `body` (string), and `createdAt` (date-time)
- **AND** the schema does NOT declare a top-level `authorId`, `email`, `password`, or `passwordHash` property
- **AND** the `author` object's schema does NOT declare an `email`, `password`, or `passwordHash` property.

### Requirement: Cross-aggregate reference is by UUID, not JPA relationship

The `Post` JPA entity SHALL hold the author reference as a `UUID authorId` field, NOT as a `@ManyToOne User author` relationship. The `PostService` SHALL assemble response DTOs by collecting distinct author IDs and performing a single `UserRepository.findAllById(authorIds)` call per request.

#### Scenario: Post entity has no JPA relationship to User

- **WHEN** a reader inspects `backend/src/main/java/com/prodready/social/posts/Post.java`
- **THEN** the entity declares an `authorId` field of type `java.util.UUID`
- **AND** the entity does NOT declare any `@ManyToOne`, `@OneToMany`, `@OneToOne`, or `@ManyToMany` annotation referencing `User`.

#### Scenario: Service assembles the DTO with a single batched author lookup

- **WHEN** a reader inspects `PostService` for the list and read code paths
- **THEN** the service collects distinct `authorIds` from the loaded `Post`s
- **AND** calls `userRepository.findAllById(authorIds)` exactly once per request
- **AND** does NOT call `userRepository.findById(...)` inside a per-post loop.

### Requirement: Backend integration tests cover the post lifecycle

The `backend/` project SHALL include Testcontainers integration tests (matching the existing `*IT.java` pattern under `backend/src/test/java/com/prodready/social/useraccounts/`) under `backend/src/test/java/com/prodready/social/posts/` that exercise: create happy path, create unauthenticated, create body validation (empty and over-length), read happy path, read 404 for missing, read 404 for soft-deleted, list pagination across multiple pages with cursor, list excludes soft-deleted rows, list 404 for unknown userId, delete happy path, delete 404 for not-author, delete 404 for already-deleted, delete unauthenticated.

#### Scenario: Test class exists and is wired to Testcontainers

- **WHEN** a reader inspects `backend/src/test/java/com/prodready/social/posts/`
- **THEN** there is at least one `*IT.java` class that uses Testcontainers Postgres
- **AND** asserts each of the lifecycle cases listed above.

### Requirement: All post endpoints are authenticated under the existing security chain

Every endpoint introduced by this capability (`POST /api/v1/posts`, `GET /api/v1/posts/{id}`, `GET /api/v1/users/{userId}/posts`, `DELETE /api/v1/posts/{id}`) SHALL require a valid `Authorization: Bearer <access-token>` header and SHALL fall under the existing deny-by-default `SecurityFilterChain` without adding any allowlist entries.

#### Scenario: Allowlist is unchanged

- **WHEN** a reader inspects the security configuration class
- **THEN** the allowlist does NOT include any `/api/v1/posts/**` or `/api/v1/users/*/posts` entry.

#### Scenario: Each post endpoint rejects unauthenticated callers

- **WHEN** a client calls any of `POST /api/v1/posts`, `GET /api/v1/posts/{id}`, `GET /api/v1/users/{userId}/posts`, or `DELETE /api/v1/posts/{id}` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

### Requirement: OpenAPI snapshot includes the new endpoints

The committed `openapi/openapi.json` snapshot SHALL include the four new post endpoints with the agreed request/response schemas, and CI's existing drift check SHALL fail if the snapshot is stale.

#### Scenario: Snapshot lists the new paths

- **WHEN** a reader inspects `openapi/openapi.json`
- **THEN** the document declares `paths` entries for `/api/v1/posts`, `/api/v1/posts/{id}`, and `/api/v1/users/{userId}/posts`
- **AND** declares request and response schemas referenced from those paths.

#### Scenario: CI fails on snapshot drift

- **WHEN** a developer modifies a post controller without regenerating the snapshot, and pushes
- **THEN** the existing CI drift-check job fails
- **AND** the failure blocks merge.

### Requirement: Frontend ships a posts feature module wired to the generated hooks

The `frontend/` project SHALL include a posts feature module under `frontend/src/features/posts/` containing a `PostComposer`, a `PostList`, and a `PostCard` component, all wired to the Orval-generated TanStack Query hooks and Zod schemas for the new endpoints.

#### Scenario: PostComposer uses the generated create mutation and Zod schema

- **WHEN** a reader inspects `frontend/src/features/posts/PostComposer.tsx`
- **THEN** the component invokes the Orval-generated create-post mutation hook
- **AND** validates the input client-side using the Orval-generated Zod schema for the create-post request body
- **AND** does NOT fire a network request while the form is invalid.

#### Scenario: PostList uses useInfiniteQuery on the generated list query

- **WHEN** a reader inspects `frontend/src/features/posts/PostList.tsx`
- **THEN** the component consumes the Orval-generated list query through TanStack Query's `useInfiniteQuery`
- **AND** advances `pageParam` using the response's `nextCursor`
- **AND** stops fetching further pages when `nextCursor` is `null`.

#### Scenario: PostCard renders the delete control only for the caller's own posts

- **WHEN** a `PostCard` is rendered for a post whose `author.id` equals the auth context's current user id
- **THEN** the card renders a delete control
- **AND** the control invokes the Orval-generated delete mutation when clicked.

- **WHEN** a `PostCard` is rendered for a post whose `author.id` does NOT equal the auth context's current user id
- **THEN** the card does NOT render the delete control.

#### Scenario: Successful compose triggers a list refetch

- **WHEN** the create mutation resolves with 201
- **THEN** the list query for the current user is invalidated
- **AND** the next render shows the new post at the top of the list.

#### Scenario: Successful delete triggers a list refetch

- **WHEN** the delete mutation resolves with 204
- **THEN** the list query for the current user is invalidated
- **AND** the next render no longer shows the deleted post.

### Requirement: HomePage renders the posts feature additively

The `frontend/src/features/home/HomePage.tsx` component SHALL render the `PostComposer` and a `PostList` scoped to the current user, alongside the existing `Hello, {displayName}` greeting and Logout button. The existing greeting and Logout requirements from `user-accounts` SHALL continue to hold unchanged.

#### Scenario: HomePage renders all three: greeting, composer, list

- **WHEN** an authenticated user navigates to `/home`
- **THEN** the page renders the `Hello, {displayName}` greeting
- **AND** renders the Logout button
- **AND** renders `<PostComposer />`
- **AND** renders `<PostList userId={currentUser.id} />` (or the equivalent prop wiring that scopes the list to the current user).

### Requirement: Vitest tests cover the posts feature module

The `frontend/` project SHALL include Vitest tests that override the generated MSW handlers to cover: a successful create (201, asserts list refetches and shows the new post), a create validation failure (asserts the form rejects empty body without firing a network request), a successful list with cursor pagination across two pages (asserts both pages render and `useInfiniteQuery` advances), a successful delete (asserts list refetches and the deleted post is gone), a 401 on list (asserts the refresh interceptor flow already covered by the auth tests is not regressed for this surface).

#### Scenario: Compose success path

- **WHEN** the test mounts the posts feature
- **AND** types a valid body and submits
- **AND** the MSW handler responds with 201 and the new post
- **THEN** the test asserts the list refetches and the new post is rendered.

#### Scenario: Compose validation path

- **WHEN** the test mounts the composer
- **AND** submits an empty body
- **THEN** the test asserts the form shows the validation error
- **AND** asserts no network request was fired.

#### Scenario: List pagination across two pages

- **WHEN** the test mounts `PostList`
- **AND** the MSW handler returns a first page with a non-null `nextCursor`
- **AND** the user (or the test) triggers a load-more
- **AND** the MSW handler returns a second page with `nextCursor: null`
- **THEN** the test asserts both pages' items render
- **AND** asserts no further fetch occurs after the second page.

#### Scenario: Delete success path

- **WHEN** the test mounts the list with one of the current user's posts present
- **AND** clicks the delete control on that post
- **AND** the MSW handler responds with 204
- **THEN** the test asserts the list refetches and the deleted post is gone.

### Requirement: Playwright e2e spec exercises the posts vertical

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.spec.ts` that exercises the full vertical against the real backend and frontend: signup, login, compose a post, see it appear in the list on `/home`, delete it, and confirm it disappears. The spec SHALL also assert at least one validation edge (an empty body cannot be submitted).

#### Scenario: Full vertical round-trip

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up a fresh user via the SPA
- **AND** logs in as that user
- **AND** lands on `/home`
- **AND** composes a post with a non-empty body and submits
- **AND** observes the post in the rendered list
- **AND** deletes the post via the delete control on its card
- **AND** observes the post no longer rendered.

#### Scenario: Composer validates empty body

- **WHEN** the Playwright spec attempts to submit the composer with an empty body
- **THEN** the SPA blocks the submission client-side
- **AND** no network request to `POST /api/v1/posts` is observed.

### Requirement: Playwright e2e spec exercises the cross-user posts contract

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.cross-user.spec.ts` that exercises the multi-user posts contract end-to-end against the real backend and frontend. The spec SHALL prove three facts in one run: (1) any authenticated user can list another user's non-deleted posts via `GET /api/v1/users/{userId}/posts`; (2) a non-author's attempt to `DELETE /api/v1/posts/{postId}` is rejected with status `404` (not `403`); (3) the post remains visible to its author after a non-author's failed delete. The non-author's half of the spec SHALL be driven through the e2e `apiClient` fixture carrying a bearer token, not through the SPA, because the SPA has no route to view another user's posts.

#### Scenario: Cross-user read, blocked cross-user delete, author's view unchanged

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via `POST /api/v1/auth/signup` (no UI)
- **AND** signs up Bob via `POST /api/v1/auth/signup` (no UI)
- **AND** logs Alice in via the SPA's login form
- **AND** Alice composes a post via the SPA's composer with a non-empty body and submits
- **AND** the spec captures Alice's new post id from the `POST /api/v1/posts` response body
- **AND** Alice observes the post in her rendered list on `/home`
- **AND** Bob obtains a bearer token via `POST /api/v1/auth/login` driven through the `apiClient` (no UI)
- **AND** Bob calls `GET /api/v1/users/{aliceId}/posts` with `Authorization: Bearer <bob-token>`
- **AND** the response status is 200
- **AND** the response body's `items` contains a `PostResponse` whose `id` equals Alice's captured post id and whose `body` equals Alice's composed body
- **AND** Bob calls `DELETE /api/v1/posts/{aliceId-post-id}` with `Authorization: Bearer <bob-token>`
- **AND** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404
- **AND** Alice reloads `/home`
- **AND** Alice still observes her post rendered in the list.

### Requirement: E2E helpers support multi-user API flows

The `e2e/` project SHALL provide helper functions for signing up and logging in additional users via the API (without going through the SPA's UI). The `ApiClient` SHALL expose methods to perform an authenticated `GET /api/v1/users/{userId}/posts` and an authenticated `DELETE /api/v1/posts/{id}` carrying a bearer token supplied per call. These helpers SHALL be implemented as thin wrappers in `e2e/src/helpers/` and/or as additional methods on `e2e/src/helpers/apiClient.ts`, following the existing pattern set by `signupViaApi` and the existing `ApiClient.signup` method.

#### Scenario: ApiClient exposes login

- **WHEN** a test calls `apiClient.login(input)` with a valid `LoginRequest`
- **THEN** the helper performs `POST /api/v1/auth/login` against the real backend
- **AND** returns a `{ status, body }` shape consistent with the existing `signup` method
- **AND** the body on success contains the bearer access token used by subsequent authenticated calls.

#### Scenario: ApiClient exposes authenticated listPostsByAuthor

- **WHEN** a test calls `apiClient.listPostsByAuthor(token, authorId)` with a valid bearer `token` and an existing `authorId`
- **THEN** the helper performs `GET /api/v1/users/{authorId}/posts` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing `signup` method.

#### Scenario: ApiClient exposes authenticated deletePost

- **WHEN** a test calls `apiClient.deletePost(token, postId)` with a valid bearer `token` and any `postId`
- **THEN** the helper performs `DELETE /api/v1/posts/{postId}` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing `signup` method.

### Requirement: Playwright e2e spec proves cursor pagination through the UI

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.pagination.spec.ts` that exercises the cursor pagination contract end-to-end against the real backend and frontend. The spec SHALL prove three facts in one run: (1) when an authenticated user has more posts than the server's default page size, the SPA renders the first page with exactly the default-page-size of `PostCard` articles and exposes a "Load more" affordance; (2) clicking "Load more" causes the SPA to fetch the next page using the server-issued cursor and append its items to the rendered list; (3) when the second page exhausts the remaining posts, the "Load more" affordance is removed and the rendered set equals the full seeded set. Posts SHALL be seeded via the e2e `apiClient` (one API call per post, sequentially awaited) rather than through the SPA's composer, because the subject under test is the list-pagination machinery, not the composer.

#### Scenario: Two-page pagination walk completes against the real stack

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds 21 posts authored by Alice via 21 sequentially-awaited calls to `apiClient.createPost(aliceToken, { body: \`Pagination post NN\` })` for `NN` in `01` through `21`
- **AND** captures each seeded post's `body` in a `seededBodies` Set of size 21
- **AND** logs Alice in via the SPA's login form
- **AND** lands on `/home`
- **AND** observes exactly 20 elements matching `role=article` with accessible name `Post`
- **AND** observes a visible `role=button` with accessible name `Load more`
- **AND** each rendered card's text body is a member of `seededBodies`
- **AND** clicks the `Load more` button
- **AND** observes the count of `role=article` elements with name `Post` rise to exactly 21
- **AND** observes that no `role=button` with name `Load more` is present
- **AND** the set of rendered cards' text bodies after the second page equals `seededBodies` (every seeded body is rendered exactly once, and no rendered body is outside the seeded set).

### Requirement: E2E ApiClient supports authenticated post creation

The e2e `ApiClient` SHALL expose a method to perform an authenticated `POST /api/v1/posts` carrying a bearer token supplied per call, parallel in shape to the existing authenticated `listPostsByAuthor` and `deletePost` methods. The method SHALL be implemented in `e2e/src/helpers/apiClient.ts` using the orval-generated `getCreatePostUrl()` from `e2e/src/api/generated/posts-controller/posts-controller.ts`, NOT a hardcoded URL string.

#### Scenario: ApiClient exposes authenticated createPost

- **WHEN** a test calls `apiClient.createPost(token, input)` with a valid bearer `token` and a valid `CreatePostRequest` body
- **THEN** the helper performs `POST /api/v1/posts` against the real backend with `Authorization: Bearer <token>`, `Content-Type: application/json`, and the serialized `input` as the request body
- **AND** returns a `{ status, body }` shape consistent with the existing `signup`, `login`, `listPostsByAuthor`, and `deletePost` methods
- **AND** on a 201 response the `body` is the parsed `PostResponse` containing the new post's `id`, embedded `author` summary, `body`, and `createdAt`.

#### Scenario: ApiClient.createPost uses the generated URL helper

- **WHEN** a reader inspects the implementation of `apiClient.createPost`
- **THEN** the implementation imports `getCreatePostUrl` from `e2e/src/api/generated/posts-controller/posts-controller.ts`
- **AND** does NOT hardcode the string `/api/v1/posts` or any other literal path.

