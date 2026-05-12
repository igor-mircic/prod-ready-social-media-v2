## Why

The posts capability ships with the richest backend contract in the repo so far:
`GET /api/v1/users/{userId}/posts` is cursor-paginated with an opaque, versioned
base64url cursor (`[0x01][8 bytes createdAt-ms][16 bytes uuid]`), default `limit=20`,
hard cap `limit=50`, and `(createdAt DESC, id DESC)` ordering. The frontend wires
`useInfiniteQuery` to this endpoint and renders a "Load more" button when
`hasNextPage` is true. Both halves are individually covered — backend `*IT.java`
tests pin the cursor and ordering contract, frontend Vitest tests stub MSW handlers
for a two-page walk — but the e2e suite never closes the loop. Nothing in CI today
proves that the SPA can actually walk a cursor across two pages against the real
backend.

The existing posts e2e specs (`posts.spec.ts`, `posts.cross-user.spec.ts`) both
operate on a single page of one author's posts and never trip the `hasNextPage`
machinery. The contract is correct in code; the gap is purely in proof.

## What Changes

- Add a single Playwright spec, `e2e/tests/posts.pagination.spec.ts`, that proves
  the pagination contract through the live UI: Alice signs up via the e2e
  `apiClient`, logs in via the `apiClient` to obtain a bearer token, seeds 21 posts
  via the `apiClient` (one beyond the server's default page size), then drives the
  SPA login, lands on `/home`, and walks the pagination by clicking "Load more".
  Assertions: page 1 renders 20 `PostCard` articles, "Load more" is visible; after
  clicking, page 2 raises the total to 21 cards and "Load more" disappears. The set
  of rendered bodies equals the set of seeded bodies (order-independent — ordering
  is a backend contract proven by `*IT.java`, not by this spec).
- Extend the e2e `ApiClient` with a `createPost(token, input)` method that wraps
  `POST /api/v1/posts` carrying a bearer token, mirroring the existing
  `listPostsByAuthor` and `deletePost` methods.
- Tighten the `posts` capability spec with one new e2e scenario requirement
  ("Playwright e2e spec proves cursor pagination through the UI") and a small
  helper requirement extension covering `apiClient.createPost`. No existing
  requirement text is modified.

### Explicit non-goals (deferred to follow-ups)

- Composer XSS / HTML-escaping proof.
- Composer double-submit protection.
- Composer max-length boundary at `N` and `N+1` (500/501 characters).
- Axe accessibility scans beyond the implicit scan the `runAxeScan` fixture hook
  already runs on every passing test.
- A "Load more" loading-state proof (the button label flips to "Loading…" while
  `isFetchingNextPage`). The cross-page assertion sequencing implicitly waits for
  the next page to land; calling out the intermediate label is micro-coverage.
- Pagination through three or more pages, or with a non-default `limit` query
  parameter. The default-page contract is what the SPA uses today; non-default
  limits are not exposed in the UI.
- Cross-user pagination (Bob walking Alice's pages). The pagination contract is
  per-author, and cross-user access is already proven by `posts.cross-user.spec.ts`.
- Any backend or frontend behavior change. This change is test-only plus spec text;
  controllers, services, repositories, and React components are untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `posts`: adds a new Playwright e2e scenario requirement for cursor pagination
  through the UI, and extends the existing e2e helper requirement to cover
  `apiClient.createPost`. No existing requirement text is modified.

## Impact

- **E2E suite (primary):**
  - New: `e2e/tests/posts.pagination.spec.ts`.
  - Extended: `e2e/src/helpers/apiClient.ts` — adds `createPost(token, input)` to
    the `ApiClient` interface and `createApiClient` factory, mirroring the existing
    `listPostsByAuthor` and `deletePost` methods. URL via the orval-generated
    `getCreatePostUrl()`. The generated client already exposes this helper, so no
    new code generation is required.
  - Existing `e2e/tests/posts.spec.ts` and `e2e/tests/posts.cross-user.spec.ts`
    are unchanged.
- **OpenSpec specs:**
  - `openspec/specs/posts/spec.md` — two new requirements are added (e2e pagination
    scenario, and the `createPost` helper extension). Existing requirements and
    scenarios are preserved.
- **Backend, frontend, API contract, database, dependencies:** no changes.

## Ordering note

The change `expand-posts-e2e-cross-user` is merged but unarchived as of authoring
time; its deltas (which modify three existing requirements and add two new ones)
have not yet been applied to `openspec/specs/posts/spec.md`. This change only adds
new requirements and does not modify any existing requirement text, so its deltas
do not conflict with the pending archive regardless of which lands first.
