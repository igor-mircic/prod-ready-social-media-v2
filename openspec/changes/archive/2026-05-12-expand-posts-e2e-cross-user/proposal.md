## Why

The posts vertical landed with one happy-path Playwright spec that exercises a single
user composing, listing, and deleting their own post. The multi-user contract — anyone
authenticated can read any non-deleted post or list any author's posts, but only the
author can delete, and a non-author delete is folded into `404` (not `403`) to avoid
leaking existence — is encoded only in the backend service code and its `*IT` tests.
The end-to-end suite never proves it against the real stack, and a follow-up exploration
flagged this as the highest-value coverage gap to close before stacking more product on
top of `posts`.

The existing spec also under-specifies the *cross-user* posture: the read-by-id, list-by-author,
and delete requirements all say "an authenticated client" without ever stating whether
the caller and the post's author are the same or different person. The current implementation
allows cross-user reads and forbids cross-user deletes (folded into 404), but that posture
is implicit. This change makes it explicit in the spec and pins it down with one e2e proof.

## What Changes

- Add a single Playwright spec, `e2e/tests/posts.cross-user.spec.ts`, that exercises the
  multi-user contract end-to-end against the real backend: Alice signs up and composes a
  post via the SPA; Bob (a second, independently signed-up user) hits
  `GET /api/v1/users/{aliceId}/posts` via the e2e `apiClient` fixture with his own bearer
  token and observes Alice's post; Bob then attempts `DELETE /api/v1/posts/{postId}` and
  receives `404` (not `403`); Alice reloads `/home` and her post is still rendered.
- Tighten the `posts` capability spec on three fronts:
  - **Read-by-id** is explicitly callable across users — any authenticated caller can fetch
    any non-deleted post.
  - **List-by-author** is explicitly callable across users — any authenticated caller can
    list any author's non-deleted posts.
  - **Delete** explicitly folds the non-author case into `404` *as a non-disclosure choice*,
    not as a missing-resource accident — the rationale belongs in the spec, not just in
    the service-code comment.
- Add a new e2e scenario requirement for the cross-user Playwright spec, alongside the
  existing single-user `posts.spec.ts` requirement.
- Extend the e2e helpers with a small `loginViaApi(apiClient, input)` helper if one does
  not already exist, so Bob's `apiClient` can carry a bearer token without going through
  the SPA's login form. This is a test-only helper under `e2e/src/helpers/`.

### Explicit non-goals (deferred to follow-ups)

- Composer XSS / HTML-escaping proof.
- Composer double-submit protection.
- Composer max-length boundary at `N` and `N+1`.
- Pagination beyond the first page in the UI flow.
- Axe accessibility scans on key routes.
- A UI route to view another user's posts. Today the SPA only renders `PostList` for the
  current user on `/home`; adding a "view profile" route is product scope, not test scope,
  and is out of scope here. Bob's half of the new spec is API-only by design.
- Any backend or frontend behavior change. This change is test-only plus spec text;
  controllers, services, repositories, and React components are untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `posts`: tightens the spec to make the cross-user read/list posture explicit, names
  the non-disclosure rationale behind the non-author-delete → 404 fold, and adds a new
  Playwright e2e scenario requirement covering the multi-user contract end-to-end.

## Impact

- **E2E suite (primary):**
  - New: `e2e/tests/posts.cross-user.spec.ts`.
  - Possibly new: `e2e/src/helpers/login.ts` (or extension of an existing helper file) to
    provide `loginViaApi(apiClient, input)` returning a configured `apiClient` carrying
    Bob's bearer token. Verify against the existing `signupViaApi` helper and the
    `apiClient` fixture before adding — if the fixture already exposes a way to swap
    tokens, prefer that.
  - Existing `e2e/tests/posts.spec.ts` is unchanged — the cross-user case is a separate
    spec, not a rewrite.
- **OpenSpec specs:**
  - `openspec/specs/posts/spec.md` — three requirements have their text tightened
    (read-by-id, list-by-author, delete) and one new requirement is added for the
    cross-user e2e scenario. Existing scenarios are preserved; new scenarios are
    additive.
- **Backend, frontend, API contract, database, dependencies:** no changes.
