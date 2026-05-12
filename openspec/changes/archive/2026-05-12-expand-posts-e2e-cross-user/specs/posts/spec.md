## MODIFIED Requirements

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

## ADDED Requirements

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
