## Why

PRs #11 (`expand-posts-e2e-cross-user`) and #12 (`prove-posts-pagination-e2e`) both
shipped tight, single-spec additions to the `posts` e2e suite and both deferred the
same set of follow-ups under an "Explicit non-goals" section. That deferred list is
now the longest standing coverage gap on the richest capability in the repo: the
composer can render unescaped HTML for all the e2e suite knows, double-submit is
unspecified, the max-length boundary at 500/501 is pinned only on the backend, axe
runs only via the implicit per-test hook on a handful of routes, the "Load more"
loading-state label is not asserted, pagination is proven only across two pages and
only for the author's own posts, and the cross-user multi-user contract is proven
only on the first page. Each individual gap is small; together they are the next
believable hardening pass before product scope grows on top of `posts`.

The previous PRs landed as one-gap-per-PR specifically because each one introduced
a *new* idea (cross-user posture; pagination through the SPA). This change does not
introduce new ideas — every item here is already in the spec or implicitly assumed
by the implementation. Bundling them into one PR matches the work (a hardening pass,
not a feature) and avoids seven near-duplicate PRs that would each carry the same
scope-and-non-goals boilerplate.

## What Changes

- Add seven new Playwright specs / scenarios that close the deferred-items list:
  1. **Composer XSS / HTML-escape proof** — Alice composes a post whose body is a
     known XSS payload (e.g. `<script>window.__xss=1</script><img src=x onerror="window.__xss=1">`),
     submits via the SPA, and the resulting `PostCard` renders the payload as literal
     text. `window.__xss` is `undefined` after render, the DOM under the post body
     contains the literal source string, and no `<script>` or `<img>` element exists
     inside the post body.
  2. **Composer double-submit protection** — after typing a valid body and clicking
     submit twice in rapid succession (both clicks issued before the first mutation
     resolves), exactly one new `PostCard` is rendered and exactly one row exists for
     Alice via `apiClient.listPostsByAuthor`. Pins the observed behavior — whether
     enforced by a disabled button, an `isPending` guard, or both — without dictating
     the mechanism.
  3. **Composer max-length boundary (500 / 501)** — a body of exactly 500 characters
     submits and renders; a body of 501 characters does NOT result in a new
     `PostCard`. The spec pins the *observable* outcome (one new card vs none) and
     records whichever surface enforces it (client-side validation message OR
     surfaced 400). If both happen, the test asserts whichever is visible.
  4. **Axe scans on key routes** — explicit `runAxeScan` calls at `/login`,
     `/signup`, and `/home` (the last with composer and list rendered), beyond the
     implicit per-test scan.
  5. **"Load more" loading-state proof** — after clicking "Load more" on a
     two-page seed (21 posts), the button label flips to "Loading…" while the
     next page is in flight, then the button disappears once page 2 lands. Asserts
     the intermediate label and the final disappearance.
  6. **Pagination through three pages** — seed 41 posts (default `limit=20`,
     yielding pages of 20/20/1), walk all three pages, assert all 41 bodies are
     rendered after the second "Load more", and the button is gone.
  7. **Cross-user pagination** — Bob walks Alice's pages via the e2e `apiClient`
     (API-only — the SPA has no profile route). Alice is seeded with 21 posts,
     Bob calls `listPostsByAuthor(aliceId)` (page 1: 20 items, `nextCursor` set),
     then `listPostsByAuthor(aliceId, { cursor })` (page 2: 1 item, no
     `nextCursor`). Assembled set equals Alice's 21 bodies.

- Tighten the `posts` capability spec with one new scenario per item, placed under
  the matching existing requirement (e.g. composer scenarios under the frontend
  PostComposer requirement, pagination scenarios under the e2e pagination
  requirement, cross-user pagination under the e2e cross-user requirement).
  Existing scenario text is not modified.

- Extend the e2e helper layer with the small additions the new specs need:
  - `apiClient.createPosts(token, count, bodyFactory)` (or inline equivalent in a
    helper file) — batch-seed helper, so the pagination specs do not call
    `createPost` 41 times inline. Mirrors `apiClient.createPost` from PR #12.
  - A `tests/fixtures/payloads.ts` (or similar) file holding the XSS payload
    constant and a max-length-body builder, so the strings are named and reusable.

### Explicit non-goals (deferred to follow-ups)

- Any frontend or backend behavior change. This is still test-only plus spec text.
  If the composer does not pre-validate at 501 today, the spec records the
  *observed* behavior (e.g. surfaced 400 inline) rather than demanding new UI work.
  Same for double-submit — if the button is not disabled today, the spec pins
  whatever guard actually prevents the duplicate row.
- A UI route to view another user's posts. The SPA still only renders `PostList`
  for the current user on `/home`; cross-user pagination stays API-only.
- Pagination with a non-default `limit` query parameter. The SPA does not expose
  custom limits; covering them is backend-IT territory.
- Pagination through four or more pages. Three is enough to prove the cursor
  re-feeds across more than one "Load more" click without becoming a marathon.
- Reading another user's individual post by id in the UI. The cross-user posture
  on read-by-id was pinned by PR #11's spec text; a UI route is product scope.
- New axe rules / custom severity gates. The new axe assertions use the existing
  `runAxeScan` fixture as-is.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `posts`: Adds seven e2e scenarios under existing requirements (composer
  hardening, pagination depth, cross-user pagination, axe coverage) and extends
  the e2e helper requirement with a batch-seed `apiClient.createPosts` shape and
  a named-payload fixture. No existing requirement text is modified.

## Impact

- **Code**: `e2e/tests/` gains new specs (likely one per concern, possibly bundled
  where they share a seed — e.g. composer XSS / double-submit / max-length all
  operate on a single fresh user and could share a file). `e2e/src/helpers/` or
  `e2e/src/api/` gains the batch-seed helper. `e2e/tests/fixtures/payloads.ts`
  (new) holds the XSS and max-length strings.
- **APIs**: None. No backend endpoint or contract changes.
- **Frontend**: None. No component changes.
- **CI**: Marginally longer e2e run — pagination through three pages seeds 41 rows
  per spec invocation. Expected to stay well under existing per-spec timeouts.
- **Specs**: `openspec/specs/posts/spec.md` gains seven scenarios and one helper
  requirement extension under existing sections.
