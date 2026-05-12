## 1. E2E ApiClient extension

- [ ] 1.1 Confirm `getCreatePostUrl()` is present in `e2e/src/api/generated/posts-controller/posts-controller.ts`. If the file is missing or stale, run `pnpm --filter e2e gen:api` to regenerate.
- [ ] 1.2 In `e2e/src/helpers/apiClient.ts`, import `CreatePostRequest` and `PostResponse` from `../api/generated/openAPIDefinition.schemas.ts`; confirm the names from the regenerated module before importing.
- [ ] 1.3 Add a `CreatePostResult` type (parallel to `ListPostsByAuthorResult`) shaped as `{ status: number; body: PostResponse | ProblemDetail }`.
- [ ] 1.4 Add `createPost(token: string, input: CreatePostRequest): Promise<CreatePostResult>` to the `ApiClient` interface.
- [ ] 1.5 Implement `createPost` in `createApiClient`: `POST` against `${baseURL}${getCreatePostUrl()}` with headers `Content-Type: application/json`, `Accept: application/json, application/problem+json`, `Authorization: Bearer <token>`, body `JSON.stringify(input)`; parse the response with the same `text.length > 0 ? JSON.parse(text) : {}` idiom used by the existing methods.

## 2. Pagination Playwright spec

- [ ] 2.1 Create `e2e/tests/posts.pagination.spec.ts` importing `test`, `expect` from `../src/fixtures/test.ts`, `randomSignupInput`, `signupViaApi` from `../src/helpers/signup.ts`, and `loginViaApi` from `../src/helpers/login.ts` (added by the cross-user change).
- [ ] 2.2 In the spec body: generate Alice's input via `randomSignupInput()`; sign her up via `signupViaApi(apiClient, input)`; obtain her bearer token + userId via `loginViaApi(apiClient, { email: input.email, password: input.password })`.
- [ ] 2.3 Seed 21 posts sequentially with `apiClient.createPost(aliceToken, { body: \`Pagination post \${i.toString().padStart(2, '0')}\` })` for `i = 1..21`, awaiting each call so `createdAt` values are strictly increasing. Collect each created post's `body` into a `seededBodies` Set (size 21).
- [ ] 2.4 Drive Alice's SPA login by re-using the local `loginAndLandOnHome` pattern from `posts.spec.ts`. If duplication is starting to bite across three spec files, lift it into `e2e/src/helpers/login.ts` (or a sibling) and update all three call sites — otherwise leave it inline for parity with the existing specs.
- [ ] 2.5 Locate all rendered post cards with `page.getByRole('article', { name: 'Post' })`. Assert the count is exactly 20.
- [ ] 2.6 Assert the "Load more" button is visible: `await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()`.
- [ ] 2.7 Capture the set of rendered bodies after page 1: iterate the 20 cards and read their text content, asserting each is a member of `seededBodies`.
- [ ] 2.8 Click "Load more". Wait for the article count to reach 21: `await expect(page.getByRole('article', { name: 'Post' })).toHaveCount(21)`.
- [ ] 2.9 Assert the "Load more" button is no longer present (no further pages): `await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)`.
- [ ] 2.10 Capture the full set of rendered bodies after page 2 and assert set-equality with `seededBodies` (all 21 seeded bodies present, no others).
- [ ] 2.11 Add a top-of-file comment naming the contract being proven (cursor pagination through the SPA across two pages against the real backend), so the spec's intent is grep-able.

## 3. Verification

- [ ] 3.1 Run the new spec in isolation: `pnpm --filter e2e test tests/posts.pagination.spec.ts` — passes against the real harness across all three browsers (chromium, firefox, webkit).
- [ ] 3.2 Run the full e2e suite: `pnpm --filter e2e test` — no regressions in existing specs.
- [ ] 3.3 Run typecheck on the e2e package: `pnpm --filter e2e exec tsc --noEmit` — clean.
- [ ] 3.4 Inspect the Playwright HTML report; confirm the implicit axe scan (`runAxeScan` in `e2e/src/fixtures/test.ts`) passes on the new spec.

## 4. Spec sync

- [ ] 4.1 Verify the change with `openspec validate prove-posts-pagination-e2e --strict` before opening the PR.
- [ ] 4.2 After PR merge, the change is archived in a follow-up PR using the standard archive workflow (modifies `openspec/specs/posts/spec.md` by applying the delta). Archive the predecessor (`expand-posts-e2e-cross-user`) first or in the same PR so the spec deltas apply in author order.
