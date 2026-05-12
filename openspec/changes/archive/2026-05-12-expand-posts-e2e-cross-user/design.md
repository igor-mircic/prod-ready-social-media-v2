## Context

The posts vertical landed with a single Playwright spec, `e2e/tests/posts.spec.ts`, that
exercises one user composing/listing/deleting their own post. The multi-user contract
(any authenticated user can read; only the author can delete; non-author delete is folded
into `404`) is enforced by `PostService.delete()` and covered by Testcontainers `*IT.java`
tests, but is never exercised through the live SPA + backend.

The existing `posts` spec describes each endpoint as accessible to "an authenticated
client" without ever stating whether the caller and the post's author are the same person.
The implementation today permits cross-user reads and forbids cross-user deletes (folded
into 404). That posture is correct, but it is implicit. This change makes it explicit and
pins it down with one end-to-end proof.

### Current e2e infrastructure (relevant facts)

- `e2e/src/helpers/apiClient.ts` exposes a thin `ApiClient` wrapper with a single method
  (`signup`). It uses raw `fetch` plus orval-generated URL helpers from
  `e2e/src/api/generated/auth-controller/`.
- The orval config (`e2e/orval.config.ts`) has `clean: true` and runs on `postinstall`,
  so the generated tree is regenerated from `openapi/openapi.json` on every `pnpm install`.
  Today only the `auth-controller/` subfolder exists in the generated tree because no
  test code has needed the posts URLs yet; once a test imports a posts helper, orval will
  populate `posts-controller/` automatically on the next install / `pnpm gen:api`.
- The `apiClient` fixture in `e2e/src/fixtures/test.ts` constructs a single shared client
  per test. There is no concept of "logged-in client" — `signup` is unauthenticated, and
  no other endpoint is wrapped yet.
- The `runAxeScan` hook in the same fixture file runs an axe scan on every passing test;
  any new spec inherits that scan automatically.

## Goals / Non-Goals

**Goals:**

- Prove end-to-end, against the real stack, that a second authenticated user (Bob) can
  read another user's (Alice's) post via `GET /api/v1/users/{aliceId}/posts`.
- Prove end-to-end that Bob's attempt to `DELETE /api/v1/posts/{postId}` for Alice's post
  returns exactly `404` (not `403`, not `204`), and that Alice's post remains visible to
  her after the failed delete.
- Make the cross-user posture explicit in the `posts` spec (read/list are cross-user;
  delete is author-only; the non-author-delete fold to 404 is a deliberate non-disclosure
  choice).
- Keep the new test fast: one spec, one browser context, one SPA login, one extra API
  client for Bob, no DB seeding fixtures, no test isolation beyond what randomized emails
  already provide.

**Non-Goals:**

- Changing any backend, frontend, or API contract behavior. The behavior is correct; this
  is a test + spec-text change only.
- Adding UI to view another user's posts. Bob's half of the test is API-only by design.
- Closing the other deferred posts gaps (XSS, double-submit, max-length, pagination, axe).
- Migrating `e2e/tests/posts.spec.ts` into the new file — the single-user round-trip stays
  in its current home; the cross-user case is a separate, focused spec.

## Decisions

### Decision 1: New spec lives in its own file, not extending `posts.spec.ts`

Add `e2e/tests/posts.cross-user.spec.ts` as a new file rather than extending the existing
`posts.spec.ts`.

**Why:** The existing single-user spec is short, readable, and self-contained. The
cross-user case is ~3× the setup of the single-user case (two signups, two clients, two
auth contexts) and reads more clearly as a separate test file. The Playwright runner
parallelizes per-file by default, so this also avoids serializing two distinct flows.

**Alternative considered:** A second `test(...)` inside `posts.spec.ts`. Rejected because
the helper surface diverges (Bob's API-only flow has no UI counterpart in `posts.spec.ts`)
and the file would lose its single-user focus.

### Decision 2: Bob's flow is API-only, using a token-carrying API client

The new spec uses the existing browser `page` only for Alice's UI flow. Bob is represented
entirely by an `ApiClient` configured to carry his bearer token. Bob never opens a browser
page.

**Why:** The SPA has no route to view another user's posts. Adding such a route is product
scope (a profile view), not test scope. Driving Bob through the API directly proves the
backend contract without inventing UI. It also avoids the "two-browser-contexts" pattern,
which Playwright supports but is unnecessary here.

**Alternative considered:** Opening a second browser context for Bob, navigating to a
hypothetical `/users/{aliceId}` route. Rejected — that route doesn't exist and out of
scope.

### Decision 3: Extend `ApiClient` with `login`, `listPostsByAuthor`, `deletePost` rather than introducing a separate "authenticated client"

Add three new methods to the existing `ApiClient` interface:

- `login(input: LoginRequest): Promise<{ status; body }>` — wraps `POST /api/v1/auth/login`,
  returns the parsed body which includes the access token.
- `listPostsByAuthor(token: string, authorId: string): Promise<{ status; body }>` — wraps
  `GET /api/v1/users/{authorId}/posts`, sends `Authorization: Bearer <token>`.
- `deletePost(token: string, postId: string): Promise<{ status; body }>` — wraps
  `DELETE /api/v1/posts/{postId}`, sends `Authorization: Bearer <token>`.

The token is passed per call rather than baked into the client instance.

**Why:** The existing `ApiClient` is already a thin object with one method (`signup`).
Adding three more in the same shape keeps the surface uniform and the test code readable.
Passing the token per call is appropriate for a test harness with a single caller (the new
spec) — there is no callsite hygiene benefit from a builder pattern at this scale, and a
mutable `setAuth(...)` is a footgun (one test forgetting to reset it leaks state).

**Alternative considered:** A separate `AuthedApiClient` returned by `apiClient.login(...)`.
Cleaner in shape, but introduces a second type and a method-chain idiom the rest of the
suite doesn't use. Worth revisiting if a second cross-user test joins this one and the
duplication starts to bite — for one test, it's overkill.

### Decision 4: Use generated orval URL helpers for the new methods

Reach for `getLoginUrl()`, `getListPostsByAuthorUrl(authorId)`, `getDeletePostUrl(id)` from
the generated `e2e/src/api/generated/.../*.ts` modules rather than hardcoding paths.

**Why:** The orval config already regenerates from `openapi/openapi.json` on `postinstall`
and the URL helpers exist (or will, once a posts-touching helper is imported by test code).
Using the generated URLs locks the e2e against the OpenAPI contract; if the path ever
changes, regeneration breaks the import explicitly rather than letting a stale hardcoded
path drift.

**Alternative considered:** Hardcoded URL strings. Rejected — defeats the existing
codegen discipline and breaks the convention set by `signup`.

### Decision 5: Capture Alice's post id from the network, not by parsing the DOM

After Alice clicks `Post`, wait for the `POST /api/v1/posts` response, parse the response
JSON, and read `id`. This becomes the post id Bob will probe.

**Why:** The DOM may or may not expose the post id as a data attribute. Parsing the
typed network response uses the same machinery the rest of the suite trusts and avoids
coupling the test to a DOM convention that isn't required by any current spec.

**Alternative considered:** Wait for the post to appear in `PostList`, then read its
DOM-rendered `data-post-id` (if such an attribute exists). Brittle and undocumented.

### Decision 6: Spec deltas tighten three existing requirements, add one new one

The `posts` spec already says "an authenticated client" for read/list/delete. The deltas:

- **MODIFIED** `Read-post-by-id endpoint returns the post` — add a scenario that the
  authenticated caller need not be the author.
- **MODIFIED** `List-posts-by-author endpoint is cursor-paginated` — add a scenario that
  the authenticated caller need not equal the path's `userId`.
- **MODIFIED** `Delete-post endpoint soft-deletes the caller's own post` — restate the
  existing 404-on-cross-user scenario as a *non-disclosure* design choice in the
  requirement text (preserve the scenario itself, which already asserts the contract).
- **ADDED** `Playwright e2e spec exercises the cross-user posts contract` — a new
  requirement parallel to the existing single-user `posts.spec.ts` requirement.

**Why each is a `MODIFIED` and not `ADDED`:** The behavior was always present; only the
spec text becomes more precise. Modifying the existing requirement keeps the spec a
single source of truth instead of fragmenting "authenticated-client" semantics across
multiple requirements.

## Risks / Trade-offs

- **Risk: orval has not been re-run since the openapi.json grew the posts paths, so
  `getListPostsByAuthorUrl` etc. don't yet exist in `e2e/src/api/generated/`.**
  → Mitigation: the orval config runs on `postinstall` with `clean: true`. The first
  `pnpm install` after this change adds a posts-touching import will populate the missing
  module. If the harness CI cache skips `postinstall`, the implementer adds `pnpm gen:api`
  before the test step or runs orval manually as a task step.

- **Risk: Bob's `DELETE` arrives before Alice's compose response has been parsed, so the
  post id is undefined.**
  → Mitigation: the test awaits the compose response and reads `id` from it before
  starting Bob's flow. Sequential by construction.

- **Risk: The `404` returned by the backend on Bob's `DELETE` *also* fires when the post
  truly doesn't exist, so a spec checking only the status code can pass even if the post
  id is wrong.**
  → Mitigation: the test first verifies that `listPostsByAuthor(token, aliceId)` returns
  Alice's post in `items` (status `200`, length ≥ 1, matching `body`) — Bob therefore
  proves both that the post is reachable to him *and* that his subsequent `DELETE`
  targeting that exact `id` is rejected with `404`. The cross-check rules out the
  "wrong id" false positive.

- **Risk: Alice's reload assertion ("the post is still visible") races the soft-delete
  background path.**
  → Mitigation: there is no such path — Bob's `DELETE` was rejected and the row's
  `deleted_at` is unchanged. The reload assertion is a positive guard against an
  implementation regression that silently honored cross-user deletes.

- **Trade-off: the new `login`, `listPostsByAuthor`, `deletePost` methods on `ApiClient`
  are minimally typed (return `{ status, body }` shaped as `unknown`/loosely-typed).**
  Tighter generics would be nice but the test reads two specific fields off the bodies
  (`accessToken` from login, `items[0].id` from list) and asserts on status codes.
  Investing in generics now would be premature for a one-spec caller.

- **Trade-off: the test depends on a real backend `POST /api/v1/auth/login` happening
  for Bob.** If a future change adds rate-limiting on login, the e2e suite may need
  per-test exemptions or backoff. Out of scope to pre-solve.
