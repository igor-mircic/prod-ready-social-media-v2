## ADDED Requirements

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
