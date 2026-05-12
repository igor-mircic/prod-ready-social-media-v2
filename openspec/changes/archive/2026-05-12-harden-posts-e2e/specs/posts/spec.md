## ADDED Requirements

### Requirement: Playwright e2e spec proves the composer escapes HTML payloads

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.composer.hardening.spec.ts` that proves a composed post body containing a known XSS payload is rendered as literal text by the SPA's post list and does not execute as HTML. The payload SHALL contain at least one `<script>` element and one `<img>` element with an `onerror` handler, and SHALL set a global JavaScript variable if executed. The spec SHALL assert three independent facts: (1) inside the rendered `PostCard`'s body region, no `<script>` element and no `<img>` element exist; (2) the literal payload text is findable under the card body; (3) the global JavaScript variable the payload would set if executed is `undefined` after the post lands.

#### Scenario: XSS payload renders as text, not as HTML

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** fills the composer's `Body` field with an `XSS_PAYLOAD` constant whose value contains the substring `<script>` and the substring `onerror=`
- **AND** clicks the `role=button` with accessible name `Post`
- **AND** observes a new `role=article` with accessible name `Post` containing the literal payload string as text
- **AND** inside that `PostCard`, the count of `script` elements is 0
- **AND** inside that `PostCard`, the count of `img` elements is 0
- **AND** the expression `(window as any).__xss` evaluates to `undefined` on the page.

### Requirement: Playwright e2e spec proves the composer prevents double-submit

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.composer.hardening.spec.ts` that proves a rapid double-click on the composer's submit button results in exactly one new post, not two. The spec SHALL pin the *observable* outcome (one rendered `PostCard`, one row returned by `apiClient.listPostsByAuthor`) without dictating which guard mechanism (disabled attribute, `isPending` flag, mutation idempotency) enforces it. The spec SHALL additionally assert that during the mutation in-flight window the submit button is `disabled`, and SHALL assert that only one `POST /api/v1/posts` request reaches the wire across both clicks.

#### Scenario: Two rapid clicks produce one post and one network call

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** registers a counter that increments on every `request` event whose method is `POST` and whose URL contains `/api/v1/posts`
- **AND** fills the composer's `Body` field with a unique deterministic body string
- **AND** issues two `click({ force: true })` calls back-to-back on the `role=button` with accessible name `Post`
- **AND** waits for the SPA's pending state to clear (i.e. the submit button is no longer disabled OR a new `PostCard` becomes visible, whichever resolves first)
- **AND** observes exactly one `role=article` with accessible name `Post` containing the submitted body
- **AND** the request counter equals 1
- **AND** `apiClient.listPostsByAuthor(aliceToken, aliceId)` returns a body whose `items` array has length 1 and whose single item's `body` equals the submitted body.

### Requirement: Playwright e2e spec proves the composer enforces a 500-character cap on input

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.composer.hardening.spec.ts` that proves the composer's textarea enforces a 500-character cap on user input via the browser-level `maxLength` attribute. The spec SHALL prove two facts: (1) a body of exactly 500 characters submits successfully and renders as a new `PostCard` whose body length is 500; (2) when a string longer than 500 characters (e.g. 600) is filled into the textarea, the textarea's `value` is truncated to exactly 500 characters before submission, and after submission the resulting `PostCard`'s body length is exactly 500 characters. The spec SHALL NOT bypass the `maxLength` attribute via direct DOM manipulation or `evaluate(...)` to inject a literal 501-character string; the contract under test is the user-observable cap.

#### Scenario: 500-character body submits and renders at length 500

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** fills the composer's `Body` field with a 500-character deterministic string built by `maxLengthBody(500)`
- **AND** clicks the `role=button` with accessible name `Post`
- **AND** observes a new `role=article` with accessible name `Post` containing the 500-character body
- **AND** the rendered card's body text length is exactly 500.

#### Scenario: A 600-character fill is truncated to 500 before submission

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up a fresh Alice via the `apiClient` (no UI)
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** fills the composer's `Body` field with a 600-character deterministic string built by `maxLengthBody(600)`
- **AND** the textarea's `value` length is exactly 500 (browser-enforced by `maxLength={500}`)
- **AND** clicks the `role=button` with accessible name `Post`
- **AND** observes a new `role=article` with accessible name `Post` whose body text length is exactly 500
- **AND** the rendered card's body equals the first 500 characters of `maxLengthBody(600)`.

### Requirement: Playwright e2e spec proves the "Load more" loading state

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.pagination.deep.spec.ts` that proves the SPA's pagination affordance flips its label to `Loading…` while the next-page fetch is in flight, and is removed from the DOM once the cursor is exhausted. The spec SHALL run on a seeded 41-post fixture (so two `Load more` clicks are exercised), and SHALL assert the intermediate `Loading…` label on at least one click and the final removal after the third page is rendered.

#### Scenario: Load more flips to "Loading…" mid-fetch and is removed after the final page

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds 41 posts authored by Alice via 41 sequentially-awaited calls to `apiClient.createPost(aliceToken, { body: \`Deep pagination post NN\` })` for `NN` in `01` through `41`
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** observes a visible `role=button` whose accessible name is `Load more`
- **AND** clicks the `Load more` button
- **AND** asserts via a Playwright poll that the same button's accessible name becomes `Loading…` within the default expectation timeout
- **AND** the button is `disabled` while its label is `Loading…`
- **AND** the rendered `role=article` `Post` count rises to 40
- **AND** clicks the `Load more` button again (now back to label `Load more`)
- **AND** the rendered `role=article` `Post` count rises to 41
- **AND** no `role=button` with accessible name `Load more` or `Loading…` is present.

### Requirement: Playwright e2e spec proves cursor pagination across three pages through the UI

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.pagination.deep.spec.ts` that exercises the cursor pagination contract end-to-end across three pages against the real backend and frontend. The spec SHALL seed 41 posts (default `limit=20`, yielding pages of 20/20/1), walk the pagination by clicking `Load more` twice, and assert: (1) page 1 renders 20 `PostCard` articles and exposes `Load more`; (2) after the first `Load more`, the rendered count is 40 and `Load more` is still present; (3) after the second `Load more`, the rendered count is 41 and `Load more` is removed. The full assembled set of rendered bodies SHALL equal the seeded set.

#### Scenario: Three-page pagination walk completes against the real stack

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds 41 posts authored by Alice via 41 sequentially-awaited calls to `apiClient.createPost(aliceToken, { body: \`Deep pagination post NN\` })` for `NN` in `01` through `41`
- **AND** captures each seeded post's `body` in a `seededBodies` Set of size 41
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** observes exactly 20 elements matching `role=article` with accessible name `Post`
- **AND** observes a visible `role=button` with accessible name `Load more`
- **AND** clicks the `Load more` button
- **AND** observes the count of `role=article` elements with name `Post` rise to exactly 40
- **AND** observes a visible `role=button` with accessible name `Load more`
- **AND** clicks the `Load more` button
- **AND** observes the count of `role=article` elements with name `Post` rise to exactly 41
- **AND** observes that no `role=button` with name `Load more` is present
- **AND** the set of rendered cards' text bodies after the third page equals `seededBodies` (every seeded body is rendered exactly once, and no rendered body is outside the seeded set).

### Requirement: Playwright e2e spec proves cross-user pagination via the API

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/posts.cross-user.pagination.spec.ts` that proves an authenticated non-author can walk another user's pages of posts via `GET /api/v1/users/{userId}/posts` carrying the non-author's bearer token. The spec SHALL be driven entirely through the e2e `apiClient` because the SPA exposes no route to view another user's posts. The spec SHALL seed Alice with 21 posts via the `apiClient`, then Bob (a second, independently signed-up user) SHALL call `listPostsByAuthor(aliceId)` (page 1: 20 items, `nextCursor` set), then SHALL call `listPostsByAuthor(aliceId, { cursor: nextCursor })` (page 2: 1 item, no `nextCursor`). The assembled set of 21 bodies SHALL equal Alice's seeded set.

#### Scenario: Bob walks Alice's two pages via the apiClient

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** captures Alice's user id via the `signup` response body or via a subsequent `apiClient.me(...)` call, whichever the `apiClient` already exposes
- **AND** seeds 21 posts authored by Alice via 21 sequentially-awaited calls to `apiClient.createPost(aliceToken, { body: \`Cross-user pagination post NN\` })` for `NN` in `01` through `21`
- **AND** captures each seeded post's `body` in a `seededBodies` Set of size 21
- **AND** signs up Bob via the `apiClient` (no UI) with a distinct email
- **AND** obtains Bob's bearer access token via `apiClient.login(...)` (no UI)
- **AND** calls `apiClient.listPostsByAuthor(bobToken, aliceId)` (page 1)
- **AND** observes response status 200, response body `items` length 20, and `nextCursor` is a non-empty string
- **AND** calls `apiClient.listPostsByAuthor(bobToken, aliceId, { cursor: nextCursor })` (page 2)
- **AND** observes response status 200, response body `items` length 1, and `nextCursor` is `null` or omitted
- **AND** the assembled set of bodies across both pages equals `seededBodies`.

### Requirement: Playwright e2e spec proves explicit axe scans on key routes

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/axe.routes.spec.ts` that performs explicit `runAxeScan` calls on three key routes: `/login`, `/signup`, and `/home` (the last after a fresh user has signed up, logged in, and seeded one post via the `apiClient` so the composer and list are both rendered with non-trivial content). The scans SHALL use the existing `runAxeScan` fixture without modification. The spec SHALL be a single `test()` walking the three routes sequentially.

#### Scenario: Axe scans clean across /login, /signup, and /home

- **WHEN** the Playwright spec runs against the harness
- **THEN** it visits `/login` and runs `runAxeScan` and observes no violations
- **AND** it visits `/signup` and runs `runAxeScan` and observes no violations
- **AND** it signs up Alice via the `apiClient` (no UI)
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** seeds one post authored by Alice via `apiClient.createPost(aliceToken, { body: 'Axe seed post' })`
- **AND** logs Alice in via the SPA's login form and lands on `/home`
- **AND** the rendered page contains a `role=article` with accessible name `Post` containing `Axe seed post`
- **AND** runs `runAxeScan` on `/home` and observes no violations.

### Requirement: E2E helpers expose a batch-seed helper and named payload fixtures

The `e2e/` project SHALL expose a `seedPosts(apiClient, token, count, bodyAt?)` helper at `e2e/src/helpers/seedPosts.ts` that performs `count` sequentially-awaited calls to `apiClient.createPost(token, { body: bodyAt(i) })` for `i` in `1..count`, returning the array of created `PostResponse` bodies in order. The default `bodyAt(i)` SHALL be a deterministic, distinguishable string (e.g. `\`Seeded post NN\``). The `e2e/tests/fixtures/payloads.ts` module SHALL export an `XSS_PAYLOAD` string constant containing at least one `<script>` element and one `<img>` element with an `onerror` handler that, if executed, sets `window.__xss = true`, and SHALL export a `maxLengthBody(n: number): string` function returning a deterministic `n`-character string.

#### Scenario: seedPosts seeds N posts sequentially via apiClient.createPost

- **WHEN** a test calls `seedPosts(apiClient, token, 3)` with a valid bearer `token`
- **THEN** the helper performs exactly 3 sequentially-awaited calls to `apiClient.createPost(token, { body: ... })` against the real backend
- **AND** returns an array of 3 `PostResponse` values in creation order
- **AND** the bodies are deterministic and distinguishable across calls.

#### Scenario: XSS_PAYLOAD contains an executable-looking script and image

- **WHEN** a reader inspects `e2e/tests/fixtures/payloads.ts`
- **THEN** the exported `XSS_PAYLOAD` string contains the substring `<script>`
- **AND** contains the substring `onerror=`
- **AND** contains a JavaScript expression that, if evaluated as HTML and executed, would assign a truthy value to `window.__xss`.

#### Scenario: maxLengthBody returns a deterministic n-character string

- **WHEN** a test calls `maxLengthBody(500)`
- **THEN** the returned string's length is exactly 500
- **AND** the returned string is deterministic across calls (the same input yields the same output)
- **AND** the returned string is distinguishable from typical user input (e.g. uses a recognizable repeating pattern rather than arbitrary lorem ipsum).

### Requirement: E2E ApiClient listPostsByAuthor accepts an optional cursor

The e2e `ApiClient.listPostsByAuthor(token, authorId, params?)` method SHALL accept an optional `params` object with a `cursor?: string` field. When `params.cursor` is provided, the helper SHALL pass it as the `cursor` query parameter to `GET /api/v1/users/{authorId}/posts`. When `params.cursor` is omitted or `undefined`, the helper SHALL NOT add a `cursor` query parameter (preserving the existing behavior). The method SHALL continue to return a `{ status, body }` shape consistent with the existing helper.

#### Scenario: listPostsByAuthor passes cursor when provided

- **WHEN** a test calls `apiClient.listPostsByAuthor(token, authorId, { cursor: 'abc' })` with a valid bearer `token`
- **THEN** the helper performs `GET /api/v1/users/{authorId}/posts?cursor=abc` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing helper.

#### Scenario: listPostsByAuthor omits cursor when not provided

- **WHEN** a test calls `apiClient.listPostsByAuthor(token, authorId)` without a `params` argument
- **THEN** the helper performs `GET /api/v1/users/{authorId}/posts` (no `cursor` query parameter) against the real backend
- **AND** returns a `{ status, body }` shape consistent with the existing helper.
