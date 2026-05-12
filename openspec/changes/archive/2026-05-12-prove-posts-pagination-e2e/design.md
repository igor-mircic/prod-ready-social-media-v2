## Context

The posts vertical has the most surface area of any capability in the repo: four
HTTP endpoints, a cursor-paginated list with a versioned opaque cursor, soft-delete
semantics, and cross-user access rules. Two e2e specs already cover slices of it —
`posts.spec.ts` proves the single-user compose/list/delete round-trip on one page,
and `posts.cross-user.spec.ts` proves the multi-user contract (read across users,
delete-as-author-only-folded-to-404). Both operate on a single page of one author's
posts.

The pagination machinery itself — server cursor encoding, `useInfiniteQuery`,
`hasNextPage`, the "Load more" trigger that calls `fetchNextPage()` — is *not*
exercised end-to-end. It is covered:

- On the backend by `PostsServiceIT.java` / `PostsControllerIT.java`-style tests
  via Testcontainers, which assert the cursor format and the cross-page contract
  against a real Postgres.
- On the frontend by `PostList.test.tsx` via MSW handlers, which assert that the
  React component walks two pages and stops when `nextCursor` is null.

What's missing is the join: does the SPA's `useInfiniteQuery` *actually* round-trip
the server's *real* cursor across the wire, parse it, and feed it back? The two
unit-level proofs share a contract (the OpenAPI schema) but never meet at runtime
in CI. This change closes that gap with a single focused spec.

### Current e2e infrastructure (relevant facts)

- `e2e/src/helpers/apiClient.ts` exposes a thin `ApiClient` with `signup`, `login`,
  `listPostsByAuthor`, and `deletePost`. It uses raw `fetch` plus orval-generated
  URL helpers. The `createPost` URL helper (`getCreatePostUrl()`) is already
  present in `e2e/src/api/generated/posts-controller/posts-controller.ts`.
- `e2e/src/helpers/signup.ts` exposes `randomSignupInput()` and
  `signupViaApi(apiClient, input)`.
- `e2e/src/helpers/login.ts` exposes `loginViaApi(apiClient, input)` returning
  `{ accessToken, userId }` (added by `expand-posts-e2e-cross-user`).
- The PostList component renders post cards with `aria-label="Post"` and a
  "Load more" button when `hasNextPage` is true; the button is disabled while
  `isFetchingNextPage` and gets re-labelled "Loading…" during fetch.
- The `runAxeScan` hook in `e2e/src/fixtures/test.ts` runs an axe scan on every
  passing test; any new spec inherits this.

## Goals / Non-Goals

**Goals:**

- Prove end-to-end, against the real stack, that the SPA can walk the cursor
  pagination across two pages: page 1 returns the default 20 items + a non-null
  `nextCursor`, the SPA exposes a "Load more" affordance, clicking it issues a
  follow-up request carrying the cursor, page 2 returns the remaining items + a
  null `nextCursor`, and the SPA hides the "Load more" affordance.
- Capture the contract as a Playwright e2e scenario requirement on the `posts`
  capability spec.
- Capture the `createPost` test-helper extension as a parallel requirement.
- Keep the test fast and self-contained: one user, one browser context, one SPA
  login, no DB seeding fixtures, no test isolation beyond what randomized emails
  already provide.

**Non-Goals:**

- Changing any backend, frontend, or API contract behavior.
- Proving ordering through the UI (the `(createdAt DESC, id DESC)` ordering is a
  backend contract pinned by Testcontainers tests; this spec asserts page-walk
  completeness, not per-card position).
- Proving the loading-state micro-behavior of the "Load more" button (the
  intermediate "Loading…" label, the `disabled` flicker).
- Proving pagination at non-default `limit` values — the SPA never sends `?limit`.
- Proving the three+ page case — the contract is the same after page 2; one
  extra page is sufficient to prove the cursor round-trip.
- Closing other deferred posts gaps (XSS, double-submit, max-length boundary,
  explicit axe runs).

## Decisions

### Decision 1: Seed 21 posts via `apiClient.createPost`, not via the SPA composer

The spec authenticates Alice once, then loops 21 calls to `apiClient.createPost`
to populate her timeline. The SPA composer is never used.

**Why:** The composer's behavior is already proven by `posts.spec.ts` and by the
frontend Vitest suite. Composing 21 posts through the SPA would take ~30s of
clicking and fill-text, would re-render the list 21 times between inserts (forcing
many incremental `useInfiniteQuery` invalidations), and would add no contract
coverage that the API call doesn't already give. The subject of this test is the
*list*'s pagination, not the *composer*.

**Alternative considered:** Direct SQL seeding via a Postgres helper. Rejected:
the e2e suite has deliberately avoided bypassing the API to keep the test stack
black-box. The API-driven seed is fast enough (21 sequential POSTs ≈ 1–2s) and
exercises the same authorization path real users go through.

### Decision 2: Hard-count assertions at exactly 21 = (default limit) + 1

The number of seeded posts is the smallest value that forces a second page given
the documented default `limit=20`: one extra. This produces a fully populated
page 1 (20 cards) and a partial page 2 (1 card), and the test asserts exactly
those counts.

**Why:** Deterministic boundary. A "≥21" or "more than 20" framing would weaken
the assertion and obscure off-by-one regressions. Choosing 21 (rather than 25 or
40) also keeps the test fast and the seeded set small enough to enumerate in a
`Set` assertion.

**Alternative considered:** Seed exactly 41 posts to force a third page and prove
the cursor *chain*, not just the first hop. Rejected as out of scope — the cursor
contract is pinned at the backend by Testcontainers tests across many pages; the
e2e proof needs only to show that the SPA can read *one* `nextCursor` off the
wire and feed it back into a follow-up request.

### Decision 3: Order-independent set-equality, not per-position assertions

The spec asserts that the set of rendered post bodies after walking both pages
equals the seeded set of bodies. It does NOT assert that "Post 21" appears at
DOM index 0 of page 1.

**Why:** The `(createdAt DESC, id DESC)` ordering is a backend contract, and the
e2e harness's `created_at` resolution is whatever Postgres' `now()` gives us
(microsecond, in practice). 21 sequential `POST`s should produce 21 strictly
increasing `createdAt` values in normal operation, but the SPA's job is to render
what the server gives it in the order the server gives it — proving the *order*
in e2e duplicates backend `*IT.java` coverage. Proving the *completeness* of the
two-page walk does not.

Page 1 is also asserted to be a subset of the seeded set (no foreign posts), and
the post that lands on page 2 is therefore implicitly one of the seeded set —
together these rule out "the SPA showed cached/stale data" or "the second page
arrived but rendered a duplicate of page 1".

**Alternative considered:** Assert "Pagination post 21" appears in the first DOM
position. Rejected as fragile against timestamp ties and order-equivalent
implementations.

### Decision 4: Click "Load more" by accessible role, not by CSS selector

The next-page trigger is fetched via `page.getByRole('button', { name: 'Load more' })`
— the same accessible label `PostList.tsx` renders. The spec also asserts the
button disappears after page 2 via the same role-selector.

**Why:** Robust against CSS reshuffles (the existing `posts.spec.ts` already uses
`getByRole`/`getByLabel` everywhere). It also doubles as a tiny accessibility
proof: the button is reachable by its label, which the implicit axe scan
corroborates.

**Alternative considered:** `page.locator('button:has-text("Load more")')`. Same
behavior, but role-based locators are the suite's existing convention.

### Decision 5: Use `loginViaApi` for the token, then drive UI login separately

Alice's bearer token (needed to seed posts) is obtained via `loginViaApi`, which
hits the API directly. Her SPA session (needed for `/home` to render her list) is
established via the existing UI login pattern `loginAndLandOnHome`. The two
logins happen back-to-back.

**Why:** The API client needs her token *before* she signs in via the UI, because
the seeding step runs first. Driving the UI login twice (once to populate via the
composer, once to render the list) would be slower and would reintroduce the
problem Decision 1 already avoided. Two distinct logins (one API, one UI) is the
simplest expression of the requirement.

**Alternative considered:** Intercept the SPA's login response and snarf the
access token from there. Rejected — fragile, indirect, and the existing helper
already gives us the token explicitly.

### Decision 6: New requirements are additive (`ADDED`), not modifications

The spec delta adds two new requirements under the `posts` capability:

- **ADDED** `Playwright e2e spec proves cursor pagination through the UI`.
- **ADDED** `E2E ApiClient supports authenticated post creation`.

No existing requirement text is modified.

**Why:** The pagination contract is already in the spec (under "List-posts-by-author
endpoint is cursor-paginated" and "Frontend ships a posts feature module wired to
the generated hooks"). The new requirement is a new *proof*, not a new contract.
Likewise the `createPost` helper is parallel to the existing `listPostsByAuthor`
and `deletePost` helpers, captured by `expand-posts-e2e-cross-user`'s "E2E helpers
support multi-user API flows" requirement — but adding it to that requirement
would mean modifying a requirement that the predecessor change is in the process
of adding. Cleaner to add a sibling requirement now and let a future cleanup
consolidate.

### Decision 7: Set-membership assertions, not regex assertions, for post body text

Each seeded post body is `"Pagination post 01"` ... `"Pagination post 21"` and is
held in a JS `Set`. After each page walk, the spec reads each card's text content
and asserts `Set.has(...)` for each rendered body.

**Why:** A unique, prefixed body shape ("Pagination post NN") makes the set
disjoint from any post seeded by an earlier spec running in the same harness
(though the suite isolates per-user via random emails, this gives belt-and-braces
isolation against future suite topology changes). Set-membership also fails loudly
on duplicates, which a count-only assertion would silently allow.

**Alternative considered:** Plain string-equality on an array of bodies. Rejected
— order-dependent, see Decision 3.

## Risks / Trade-offs

- **Risk: 21 sequential `POST`s might be too slow for some browsers' timeouts.**
  → Mitigation: each `POST` is ~50ms against the local harness; 21 ≈ 1–2s end to
  end, well within Playwright's default 30s per-test budget. If a future CI
  topology slows this down, the seeding loop could parallelize with `Promise.all`,
  but that reintroduces the timestamp-tie problem. Sequential is the safe default.

- **Risk: The "Load more" button might briefly toggle between visible and hidden
  during the fetch (visible → disabled+"Loading…" → removed if no more pages).**
  → Mitigation: the spec waits for the *card count* to reach 21 first (which
  implies the second-page response landed and the component re-rendered with
  `hasNextPage=false`), *then* asserts the button is gone. The intermediate
  "Loading…" state is not asserted, so this race doesn't bite.

- **Risk: The PostList component renders cards with `aria-label="Post"`; if a
  future styling change drops the label, the role-selector breaks.**
  → Mitigation: the same selector is already used by `posts.spec.ts` and
  `posts.cross-user.spec.ts`; a change that breaks it breaks the existing suite,
  not just this new spec.

- **Risk: The default `limit=20` is a server-side constant; if the server bumps
  it to 50, the test silently passes by seeding 21 posts that all fit on one
  page.**
  → Mitigation: the spec asserts "Load more is visible" after page 1. If the
  server's default cap rises above 21, the button is absent and the assertion
  fails. A future server-side cap change would be caught by this guard.

- **Trade-off: This change doesn't tighten the existing `Frontend ships a posts
  feature module` requirement to mention the "Load more" button by name.** The
  requirement already says `useInfiniteQuery` advances `pageParam` via
  `nextCursor` and stops when `nextCursor` is null — that's the contract; the
  button is one possible affordance. Naming the button in the spec would couple
  the contract to today's UX choice (e.g. it would forbid replacing the button
  with an intersection-observer auto-paginator).

- **Trade-off: The new `createPost` helper is documented in a sibling requirement,
  not folded into `expand-posts-e2e-cross-user`'s "E2E helpers support multi-user
  API flows" requirement.** Cleaner organization would be a single helper
  requirement; cleaner authoring is the parallel ADDED one used here. A future
  consolidation change can merge them once both have landed.
