## 1. E2E helper extensions

- [x] 1.1 Ensure orval has generated `posts-controller/` URL helpers under `e2e/src/api/generated/`; run `pnpm gen:api` from `e2e/` if not (orval config already wires `openapi/openapi.json` with `clean: true`).
- [x] 1.2 Extend the `LoginRequest`/`LoginResponse` imports in `e2e/src/helpers/apiClient.ts` from the generated schemas (`e2e/src/api/generated/openAPIDefinition.schemas.ts`); confirm the names from the regenerated module before importing.
- [x] 1.3 Add `login(input: LoginRequest): Promise<{ status; body }>` to `ApiClient` in `e2e/src/helpers/apiClient.ts`, mirroring the existing `signup` method shape; URL from `getLoginUrl()`.
- [x] 1.4 Add `listPostsByAuthor(token: string, authorId: string): Promise<{ status; body }>` to `ApiClient`; URL from the orval-generated `getListPostsByAuthorUrl(authorId)`; send `Authorization: Bearer <token>`.
- [x] 1.5 Add `deletePost(token: string, postId: string): Promise<{ status; body }>` to `ApiClient`; URL from the orval-generated `getDeletePostUrl(postId)`; send `Authorization: Bearer <token>`; tolerate a 204 (no body).
- [x] 1.6 In `e2e/src/helpers/`, add a `loginViaApi(client: ApiClient, input: LoginRequest): Promise<{ accessToken: string; userId: string }>` helper that throws if status is not 200, parallel to the existing `signupViaApi`. Place it in a new file `e2e/src/helpers/login.ts` or alongside `signup.ts` — pick whichever fits the existing layout.

## 2. Cross-user Playwright spec

- [x] 2.1 Create `e2e/tests/posts.cross-user.spec.ts` importing `test`, `expect` from `../src/fixtures/test.ts` and the new helpers.
- [x] 2.2 In the spec: sign up Alice and Bob via `signupViaApi(apiClient, ...)`, capturing each user's `id` and credentials.
- [x] 2.3 Drive Alice's login through the SPA (re-use the local `loginAndLandOnHome` pattern from `posts.spec.ts`; consider lifting it into a shared helper if duplication starts to bite).
- [x] 2.4 Have Alice compose a post via the SPA; capture the new post's `id` from the `POST /api/v1/posts` response using `page.waitForResponse(...)` and parsing the JSON body.
- [x] 2.5 Assert Alice's post is visible in her rendered list on `/home`.
- [x] 2.6 Drive Bob's login through `apiClient.login(...)` (no UI); assert status 200; extract Bob's bearer access token from the response body.
- [x] 2.7 Call `apiClient.listPostsByAuthor(bobToken, aliceId)`; assert status 200, `items` length >= 1, and that one item's `id` and `body` match Alice's captured post.
- [x] 2.8 Call `apiClient.deletePost(bobToken, alicePostId)`; assert status 404; assert the response body is a `ProblemDetail` with `status: 404`.
- [x] 2.9 Reload Alice's page; assert Alice's post is still rendered in her list.
- [x] 2.10 Add a short `test.describe` header or top-of-file comment naming the multi-user contract being proven, so the spec's intent is grep-able from the file list.

## 3. Verification

- [x] 3.1 Run the new spec in isolation: `pnpm --filter e2e test tests/posts.cross-user.spec.ts` — passes against the real harness.
- [x] 3.2 Run the full e2e suite: `pnpm --filter e2e test` — no regressions in existing specs.
- [x] 3.3 Run typecheck on the e2e package: `pnpm --filter e2e exec tsc --noEmit` — clean.
- [x] 3.4 Inspect the Playwright HTML report; confirm the implicit axe scan (`runAxeScan` in `e2e/src/fixtures/test.ts`) passes on the new spec.

## 4. Spec sync

- [x] 4.1 Verify the change with `openspec validate expand-posts-e2e-cross-user --strict` before opening the PR.
- [ ] 4.2 After PR merge, the change is archived in a follow-up PR using the standard archive workflow (modifies `openspec/specs/posts/spec.md` by applying the delta).
