## Context

The `posts` capability is the richest in the repo and has accumulated three Playwright
specs across PRs #8 (`add-posts`), #10/#11 (`expand-posts-e2e-cross-user`), and #12
(`prove-posts-pagination-e2e`). Each of those PRs deferred a list of follow-ups; the
union of the two most recent deferral lists is the seven items this change closes in
one bundled pass.

The implementation surfaces relevant to these specs are already on disk and unchanged
by this change:

- `frontend/src/features/posts/PostComposer.tsx` — RHF + zod resolver, submit button
  is `disabled={!isValid || isSubmitting || mutation.isPending}`, textarea has the
  HTML attribute `maxLength={500}` (browser-enforced), and a `role="alert"` paragraph
  renders any `ApiError.detail` from the create mutation. React's JSX text children
  are auto-escaped, so any composed body becomes a literal DOM text node.
- `frontend/src/features/posts/PostList.tsx` — uses `useInfiniteQuery`; the
  pagination affordance is a `<Button>` rendered only when `hasNextPage`, with label
  `Loading…` while `isFetchingNextPage` is true and `Load more` otherwise; the button
  is also `disabled` while `isFetchingNextPage`.
- `e2e/src/helpers/apiClient.ts` — exposes `signup`, `login`, `listPostsByAuthor`,
  `deletePost`, and `createPost` (the last added by PR #12, using
  `getCreatePostUrl()` from the generated client).
- `e2e/src/fixtures/axe.ts` — `runAxeScan` is the existing accessibility scan helper
  used implicitly per-test; we will reuse it as-is for the explicit per-route scans.

The previous PRs' single-spec-per-PR cadence was right for *new* coverage shapes
(cross-user posture; pagination through the SPA). This change does not introduce any
new shape — every scenario it adds either re-applies an existing shape with a deeper
seed (3-page pagination, cross-user pagination) or pins a behavior that the
implementation already exhibits implicitly (XSS escape, double-submit guard,
loading-state label, max-length cap, axe-clean routes). Bundling matches the work.

## Goals / Non-Goals

**Goals:**

- Close all seven deferred follow-up items from PRs #11 and #12 in one PR, each
  scoped to its own test (or grouped test file where a shared seed is natural).
- Pin the *observed* behavior of each surface against regression — do not require
  any frontend or backend behavior change.
- Add the seven scenarios to `openspec/specs/posts/spec.md` under appropriate
  existing requirements (composer surface, list/pagination surface, e2e helpers,
  axe coverage), creating new requirements only where a scenario does not fit any
  existing requirement.
- Keep the test files small, deterministic, and consistent with the seeding
  patterns established by `posts.pagination.spec.ts`.

**Non-Goals:**

- Any frontend or backend code change. The composer's `maxLength={500}`,
  `disabled-while-pending`, React auto-escaping, and the list's
  `Loading…`/`Load more` label behavior are all current implementation details
  this change merely pins.
- A UI route to view another user's posts. Cross-user pagination stays API-only.
- Pagination with a non-default `limit` query parameter. The SPA does not expose
  custom limits.
- Pagination through more than three pages. Three proves the cursor re-feeds
  more than once without becoming slow.
- New axe rules or custom severity gates. The existing `runAxeScan` fixture is
  used as-is.
- A "view another user's profile" route. Bob's cross-user pagination is via API.

## Decisions

### Decision 1: Group specs by shared seed, not by deferred-item number

There are seven items but four natural seed shapes:

- **Composer concerns** (XSS, double-submit, 500/501 boundary) — fresh Alice with
  no posts; each `test()` makes its own user to avoid coupling.
- **Pagination depth + loading state** (3-page walk; "Loading…" label proof) —
  pagination depth needs a 41-post seed; the loading-state label only needs a
  two-page seed (21 posts), but the 3-page seed also exhibits the label during
  *both* "Load more" clicks. Bundling them into one file lets the loading-state
  test reuse the 41-post seed, paying the cost once.
- **Cross-user pagination** — API-only, two-page seed (21 posts). Different shape
  from the SPA-driven pagination tests; its own file.
- **Axe coverage** — no posts at all; three route visits with `runAxeScan`. Own
  file.

So the file layout is:

```
e2e/tests/
├── posts.composer.hardening.spec.ts    (XSS, double-submit, max-length)
├── posts.pagination.deep.spec.ts        (3-page walk, loading-state label)
├── posts.cross-user.pagination.spec.ts  (Bob walks Alice's 2 pages via API)
└── axe.routes.spec.ts                   (explicit axe on /login, /signup, /home)
```

**Alternative considered**: seven separate spec files, one per deferred item. Rejected
because the test-runner overhead per file (signup, login, build harness) dominates the
actual assertion work, and three of the seven items share a "fresh Alice with no
posts" prelude that would be repeated verbatim. Grouping by seed saves time and
keeps the related assertions adjacent in the codebase.

**Alternative considered**: one mega-spec-file `posts.hardening.spec.ts` holding all
seven. Rejected because pagination-depth and axe-on-login share nothing and the file
would become a kitchen sink. Four files keep each one's purpose obvious from its
name.

### Decision 2: Max-length boundary — pin the UI-side cap, not the network-side 400

`PostComposer.tsx` sets `maxLength={500}` on the `<textarea>`. The browser enforces
this on both keystroke entry and `element.fill()` (Playwright's input-event path),
so a 501-character string cannot reach the form's submit handler via the UI at all.
The submission boundary at the *network* layer (POST with 501 → 400) is already
pinned by backend integration tests (`*IT.java`) and the existing spec scenario
"Over-length body is rejected".

The UI claim the e2e spec should pin is therefore: *a body of 500 characters
submits and renders; a body of 600 characters typed/filled into the textarea is
truncated to 500 characters before submission, and the rendered post body is
exactly 500 characters long*. This is the user-observable contract.

We will **not** attempt to bypass `maxLength={500}` via `evaluate(() => el.value = …)`
to inject a literal 501-char string into the form — that would test a path no real
user can produce and would force us to invent test-only DOM tricks for no
contract gain.

**Alternative considered**: have the spec assert the backend 400 response by
calling `apiClient.createPost(token, { body: '<501-chars>' })` directly, then
the spec also visits the UI and confirms no card appears. Rejected because that
half is purely an API-level assertion that duplicates `*IT.java` coverage and
the "no card appears" half is trivially true (no UI action was taken).

### Decision 3: Double-submit — assert the disabled state and the single-row outcome, not a synthetic race

The submit button is `disabled={!isValid || isSubmitting || mutation.isPending}`.
A "rapid double click" can be modeled in two ways:

1. **State-based**: click submit once; while the mutation is in flight, assert the
   button is `disabled`. After resolution, assert exactly one new `PostCard`
   appears and `apiClient.listPostsByAuthor(aliceId)` returns exactly one item.
2. **Race-based**: issue two `click({ force: true })` calls back-to-back and
   assert only one `POST /api/v1/posts` request is observed on the wire (via
   `page.on('request', …)`).

We will do **both** halves in one test: the state assertion catches static
regressions (someone removes the `mutation.isPending` guard from the disabled
expression); the network-count assertion catches dynamic regressions (someone
adds an `onClick` handler that bypasses `disabled`). The two halves together pin
the contract without dictating which guard mechanism enforces it.

### Decision 4: XSS proof — assert literal text rendering and no DOM side effect

The payload will be a string that, if rendered as HTML, would execute (e.g.
`<script>window.__xss=true</script><img src=x onerror="window.__xss=true">`).

Three assertions, in order of decreasing strictness:

1. **DOM shape**: inside the new `PostCard`'s body region, there is no `<script>`
   element and no `<img>` element. (`postCard.locator('script, img')` has count 0.)
2. **Text content**: the literal payload string is findable as text under the
   card body (`postCard.getByText(payload, { exact: false })` is visible).
3. **Side effect**: `await page.evaluate(() => (window as any).__xss)` is
   `undefined` / falsy after the post lands. If the payload had executed,
   `__xss` would be `true`.

All three must hold; any one failing means a regression. The payload constant
lives in `e2e/tests/fixtures/payloads.ts` so it is named and reusable.

### Decision 5: Loading-state label — assert the label flip and the disappearance, accept the race

The label flips to `Loading…` only while `isFetchingNextPage` is true, which is a
short window (one round-trip to the local backend). Playwright's `expect(...).toHaveText('Loading…')`
with the default 5-second timeout will resolve as soon as it observes the label,
even if that observation is mid-flight. We will issue the click and immediately
assert `expect(loadMore).toHaveText('Loading…')` — Playwright polls and catches
the transient state. After that, `expect(loadMore).toBeHidden()` (or count 0)
captures the steady state once the cursor is exhausted.

If the label flip turns out to be too fast for Playwright to catch reliably on
some machines (CI in particular), we will fall back to a network-throttling
route to delay the `GET /api/v1/users/{id}/posts?cursor=…` response by ~250ms via
`page.route`. We will not throttle by default — only if observed flake forces it.

**Alternative considered**: skip the label-flip assertion and only assert the
button's disappearance after page 2. Rejected because the disappearance is
already pinned by the existing `prove-posts-pagination-e2e` scenario; the new
work here is specifically the intermediate label.

### Decision 6: 3-page pagination — seed via apiClient in a sequential loop, mirroring PR #12

PR #12 seeded 21 posts via a `for` loop calling `apiClient.createPost`
sequentially, awaiting each. Three pages requires 41 posts (default `limit=20`,
yields 20 / 20 / 1). We will use the same pattern, just with a larger upper
bound. The added wall-clock cost is roughly 2× — the previous 21-post seed
takes ~3-4 seconds in CI; 41 should take ~6-8 seconds.

**Alternative considered**: batch insert via a SQL helper. Rejected because the
e2e test must exercise the *contract* path (the HTTP endpoint), and the
contract path is what real users hit; a SQL backdoor would skip auth and
validation and would diverge from production behavior. The marginal seconds are
not worth the divergence.

### Decision 7: Cross-user pagination — API-only, Bob never visits the UI

The SPA has no route to view another user's posts (PR #11 explicitly listed this
as a product-scope non-goal and still does). Bob's half of the cross-user
pagination proof is therefore through `apiClient.listPostsByAuthor` only:
Alice is seeded with 21 posts via the API, Alice never visits the UI in this
spec, Bob obtains a bearer token via `apiClient.login`, calls
`listPostsByAuthor(aliceId)` (page 1: 20 items, `nextCursor` set), then calls
`listPostsByAuthor(aliceId, { cursor: nextCursor })` (page 2: 1 item, no
`nextCursor`). The assembled set of 21 bodies must equal Alice's seeded set.

This requires extending `apiClient.listPostsByAuthor` to accept a `cursor`
parameter if it does not already. (PR #11 added the bearer-token form; the
cursor-passing form may need to be added here.) We will check the existing
signature during implementation and extend minimally if needed.

### Decision 8: Axe scans — explicit calls at three routes, no new rules

The existing `runAxeScan` fixture is already used implicitly by every test via a
post-test hook. The new spec calls it *explicitly* at `/login`, `/signup`, and
`/home` (the last with composer and list rendered, which means logging in a
freshly-signed-up Alice with one seeded post so the post-list path is rendered
non-trivially). The accessible-route check is independent of any post content;
this spec gets one Alice and one seeded post, then visits each route in turn.

**Alternative considered**: spin up three separate `test()`s, one per route.
Rejected because the per-test signup/login/seed cost dominates the route visit
cost; one `test()` walking three routes is faster and the failure attribution
is still clear (axe violations report per-route).

### Decision 9: Helper extensions — minimal, payload constants in a fixtures file

- `e2e/tests/fixtures/payloads.ts` (NEW) — exports `XSS_PAYLOAD` (a known-good
  payload string) and `maxLengthBody(n: number)` (returns a deterministic
  string of `n` characters; e.g. `'a'.repeat(n)` or a longer pattern for
  visual distinguishability). Named exports, no defaults.
- A `seedPosts(apiClient, token, count, bodyAt)` helper in
  `e2e/src/helpers/seedPosts.ts` (NEW) — wraps the for-loop that PR #12 inlined.
  Used by both the deep-pagination spec (count=41) and the cross-user-pagination
  spec (count=21) so the loop is written once.
- No changes to `apiClient.ts` beyond confirming `listPostsByAuthor` accepts a
  `cursor` parameter. If it does not today, extend it in this change with the
  smallest possible diff.

## Risks / Trade-offs

- **Loading-state label flake** → Mitigation: described in Decision 5. Start
  without throttling, add `page.route` delay only if observed flake.
- **41-post seed wall-clock** → Mitigation: sequential `apiClient.createPost`
  calls take ~6-8s against the local stack; well under the existing
  per-test 60s default. If it ever becomes a problem, switch to a batched
  endpoint or parallel-with-concurrency-limit; not needed today.
- **maxLength={500} bypass via Playwright** → Mitigation: design choice in
  Decision 2 — we pin the UI-observable cap, not a synthetic 501-char path.
  The 501-character backend rejection is already pinned by `*IT.java`.
- **Bundling regret** → If review prefers per-item PRs, the four test files are
  trivially separable. Spec-text additions land as one delta either way.
- **Cursor-passing in listPostsByAuthor** → Mitigation: check the signature
  during implementation and extend with the smallest possible diff if missing.
  No design risk.

## Migration Plan

Not applicable. This is a test-only addition. No schema, API, or component
change; no rollback needed beyond `git revert`.

## Open Questions

- Does `apiClient.listPostsByAuthor` already accept a `cursor` parameter? Will
  be confirmed during task 1. If not, that becomes one extra task to extend it
  (no spec change needed — the existing helper scenario covers the bearer-token
  shape; passing an optional cursor is a non-breaking widening).
- Should the XSS payload constant live under `e2e/tests/fixtures/` or
  `e2e/src/fixtures/`? The existing axe fixture is under `e2e/src/fixtures/`;
  the new payloads file follows the same convention. Defer to taste in review.
