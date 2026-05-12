## 1. Confirm preconditions and helper signatures

- [x] 1.1 Read `e2e/src/helpers/apiClient.ts` and confirm whether `listPostsByAuthor` already accepts an optional `cursor` parameter. If not, this becomes task 2.3; if yes, drop task 2.3 from the plan.
- [x] 1.2 Read `e2e/src/fixtures/axe.ts` and confirm `runAxeScan` is exported with a signature usable from a `test()` body (independent of the implicit per-test hook). Note the exact import path for use in `axe.routes.spec.ts`.
- [x] 1.3 Read `e2e/src/helpers/signup.ts` and `e2e/src/helpers/login.ts` and confirm whether the signup or login response body already exposes the new user's id (needed by the cross-user pagination spec to address Alice's posts). If neither does, plan to add a minimal helper that calls `GET /api/v1/users/me` (or the equivalent already exposed) and returns the user id.

## 2. Helper additions

- [x] 2.1 Add `e2e/src/helpers/seedPosts.ts` exporting `seedPosts(apiClient, token, count, bodyAt?)` that performs `count` sequentially-awaited `apiClient.createPost(token, { body: bodyAt(i) })` calls and returns the array of `PostResponse` bodies in order. Default `bodyAt(i)` returns `\`Seeded post NN\`` for `NN` zero-padded to 2 digits.
- [x] 2.2 Add `e2e/tests/fixtures/payloads.ts` exporting `XSS_PAYLOAD` (contains `<script>` and `<img ... onerror=...>` setting `window.__xss = true`) and `maxLengthBody(n: number): string` (deterministic, distinguishable repeating pattern; e.g. `'abcd'.repeat(n / 4 + 1).slice(0, n)`).
- [x] 2.3 If task 1.1 found no cursor support: extend `apiClient.listPostsByAuthor` to accept an optional `params?: { cursor?: string }` third argument and pass `cursor` as a query parameter when present. Use the orval-generated URL helper if available (mirror `apiClient.createPost`'s approach), not a hardcoded string. Skip this task if cursor support already exists.

## 3. Composer hardening spec

- [x] 3.1 Add `e2e/tests/posts.composer.hardening.spec.ts` with one `test()` block per scenario in the spec delta (XSS escape, double-submit, 500-char success, 600-char truncation). Each block does its own signup/login (fresh Alice). Share imports and helpers; do not share state between blocks.
- [x] 3.2 Wire the XSS test to import `XSS_PAYLOAD` from `e2e/tests/fixtures/payloads.ts`, assert literal text rendering, zero `<script>`/`<img>` children inside the `PostCard`, and `(window as any).__xss === undefined` via `page.evaluate`.
- [x] 3.3 Wire the double-submit test: register a `page.on('request', ...)` listener counting `POST /api/v1/posts`, fill the body, issue two `click({ force: true })` calls back-to-back, wait for the new card, and assert exactly one rendered card AND a request count of 1 AND `apiClient.listPostsByAuthor(aliceToken, aliceId)` returns one item.
- [x] 3.4 Wire the 500-char and 600-char tests: use `maxLengthBody(500)` and `maxLengthBody(600)` from the payloads fixture. For 600, assert the textarea's `value.length` is exactly 500 before clicking submit (Playwright `expect(textarea).toHaveValue(...)` against the first-500-char slice).

## 4. Deep pagination spec

- [x] 4.1 Add `e2e/tests/posts.pagination.deep.spec.ts` with one `test()` per scenario in the spec delta (loading-state proof, three-page walk). Both share the 41-post seed via `seedPosts(apiClient, aliceToken, 41, i => \`Deep pagination post NN\`)`.
- [x] 4.2 Wire the loading-state assertions: click `Load more`, then immediately `expect(loadMore).toHaveText('Loading…')` and `expect(loadMore).toBeDisabled()`; after page 2 lands, assert count 40; click again, after page 3 lands assert count 41 and no `Load more` button anywhere.
- [x] 4.3 Wire the three-page walk assertions: page 1 count 20, button present; click; count 40, button present; click; count 41, button absent; assert assembled set equals seeded set.
- [x] 4.4 Run the spec locally; if the `Loading…` label flake reproduces, add a `page.route('**/users/*/posts*', ...)` delay of ~250ms to widen the window. Note the throttle in a comment if added.

## 5. Cross-user pagination spec

- [x] 5.1 Add `e2e/tests/posts.cross-user.pagination.spec.ts`. Seed Alice with 21 posts via `seedPosts`. Sign up Bob with a distinct email. Obtain both bearer tokens.
- [x] 5.2 Capture Alice's user id (from signup response, login response, or a `/users/me` helper per task 1.3).
- [x] 5.3 Call `apiClient.listPostsByAuthor(bobToken, aliceId)` — assert status 200, `items.length === 20`, `nextCursor` is a non-empty string. Collect the 20 bodies.
- [x] 5.4 Call `apiClient.listPostsByAuthor(bobToken, aliceId, { cursor: nextCursor })` — assert status 200, `items.length === 1`, `nextCursor` is null or absent. Add the body to the collected set.
- [x] 5.5 Assert the union of all 21 collected bodies equals the seeded set.

## 6. Axe routes spec

- [x] 6.1 Add `e2e/tests/axe.routes.spec.ts` with a single `test()` walking `/login`, `/signup`, `/home` and calling `runAxeScan` at each.
- [x] 6.2 Before visiting `/home`, sign up Alice via `apiClient`, seed one post via `apiClient.createPost(aliceToken, { body: 'Axe seed post' })`, and log Alice in via the SPA. Confirm the seeded post is rendered before scanning.
- [x] 6.3 Assert each `runAxeScan` reports zero violations.

## 7. Spec sync and validation

- [x] 7.1 Run `pnpm --filter e2e exec playwright test posts.composer.hardening.spec.ts posts.pagination.deep.spec.ts posts.cross-user.pagination.spec.ts axe.routes.spec.ts` locally. Fix any flakes; keep the suite deterministic.
- [x] 7.2 Run `openspec validate harden-posts-e2e --strict` and resolve any reported issues.
- [x] 7.3 Open the PR with the proposal/design/specs/tasks files staged alongside the e2e test additions and helper extensions. Match the title/body convention of PR #12 (`Implement and archive prove-posts-pagination-e2e`).

## 8. Archive

- [x] 8.1 After merge, run the archive flow (`openspec-archive-change`) to fold the seven new scenarios into `openspec/specs/posts/spec.md` and move this change to `openspec/changes/archive/`.
