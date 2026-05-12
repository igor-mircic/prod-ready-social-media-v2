## 1. Backend: `GET /api/v1/users/{userId}` endpoint

- [x] 1.1 Create `backend/src/main/java/com/prodready/social/useraccounts/UserSummary.java` as a `public record UserSummary(UUID id, String displayName) {}` with a `fromEntity(User)` static factory.
- [x] 1.2 Create `backend/src/main/java/com/prodready/social/useraccounts/UsersController.java` annotated `@RestController @RequestMapping("/api/v1/users")` with a single `@GetMapping("/{userId}")` that takes `@PathVariable UUID userId`, calls `userRepository.findById(userId).orElseThrow(...)`, and returns `ResponseEntity.ok(UserSummary.fromEntity(user))`. Annotate `@SecurityRequirement(name = "bearerAuth")` and add `@ApiResponse` entries for 200, 401, and 404 mirroring `AuthController.me`.
- [x] 1.3 Configure the unknown-id branch to throw a `ResponseStatusException(NOT_FOUND)` (or capture-and-translate via the existing `RestExceptionHandler`) so the 404 body is a `ProblemDetail` consistent with other endpoints.
- [x] 1.4 Confirm the existing `SecurityFilterChain` already authenticates `/api/v1/users/**` (it does — the `posts` capability uses the same prefix). Do NOT add any allowlist entry.
- [x] 1.5 Create `backend/src/test/java/com/prodready/social/useraccounts/UsersControllerIT.java` extending the existing Testcontainers integration-test pattern, with cases: (a) happy path returns 200 + `{id, displayName}`, (b) unknown id returns 404 + ProblemDetail, (c) unauthenticated returns 401, (d) the 200 body's JSON does NOT contain `email`, `password`, `passwordHash`, or `createdAt`.

## 2. API contract: regenerate `openapi.json` and Orval client surfaces

- [x] 2.1 Run the backend's `bootRun` long enough to dump the OpenAPI snapshot, or use the existing snapshot-generation gradle task — whichever the repo's existing scripts use — to refresh `openapi/openapi.json`.
- [x] 2.2 Verify the regenerated snapshot includes the path `/api/v1/users/{userId}` with the `UserSummary` schema and `ProblemDetail` 401/404 responses.
- [x] 2.3 Run Orval against the refreshed snapshot to regenerate `frontend/src/api/generated/users-controller/` and `e2e/src/api/generated/users-controller/`. Confirm the generated `useGetUser` hook and `getGetUserUrl` URL helper are present.
- [x] 2.4 If the existing CI drift check reports any unexpected diff, reconcile (e.g. the Author/User summary schemas dedup-conflicting on `title` — let OpenAPI emit two schemas with distinct titles rather than forcing one).

## 3. Frontend: `ProfilePage` feature module

- [x] 3.1 Create `frontend/src/features/profile/ProfilePage.tsx` that calls `useParams<{ userId: string }>()`, fires `useGetUser({ userId })` and renders `<PostList userId={userId} />`. Render the user's `displayName` in an `<h1>` (or matching heading element used by `HomePage`). Do NOT render a `PostComposer`.
- [x] 3.2 Handle the `useGetUser` query states: while loading, render a brief loading affordance for the header (the list owns its own loading state); on `404`, render an "User not found" message at the page level (do NOT redirect); on other error, render an error affordance consistent with the rest of the app.
- [x] 3.3 Create `frontend/src/features/profile/ProfilePage.test.tsx` covering:
  - 3.3.a renders the header + a `PostList` for a user with seeded posts (mock the MSW handlers for `getUser` 200 and `listPostsByAuthor` 200 with one item);
  - 3.3.b renders the header + an empty-state when `listPostsByAuthor` returns `200 {items: [], nextCursor: null}`;
  - 3.3.c renders the "User not found" message when `getUser` returns 404;
  - 3.3.d does NOT render a `PostComposer` regardless of viewer identity (assert by accessible role).
- [x] 3.4 Mount with `<MemoryRouter initialEntries={['/users/{id}']}>` and a `Routes` shell so the `useParams` hook resolves correctly inside the test harness.

## 4. Frontend: protected route `/users/:userId`

- [x] 4.1 Modify `frontend/src/App.tsx` to add `<Route path="/users/:userId" element={<ProfilePage />} />` inside the existing `<Route element={<ProtectedRoute />}>` block, adjacent to the `/home` route.
- [x] 4.2 Add a Vitest case to whatever file covers `App.tsx` routing today asserting that visiting `/users/:userId` while unauthenticated redirects to `/login` (the `ProtectedRoute` behavior, already pinned).

## 5. Frontend: `PostCard` author becomes a link

- [x] 5.1 Modify `frontend/src/features/posts/PostCard.tsx` to wrap the author's `displayName` in a `react-router-dom` `<Link to={`/users/${post.author.id}`}>`. The link's text content is exactly the `displayName`. The `<article>` itself is NOT a link.
- [x] 5.2 Update `frontend/src/features/posts/PostCard.test.tsx` to:
  - 5.2.a wrap each card render in `<MemoryRouter>` so the `<Link>` resolves;
  - 5.2.b add one assertion that the author's name is rendered as a `link` with the accessible name equal to the `displayName` and `href` equal to `/users/{author.id}`;
  - 5.2.c re-verify the existing Delete-control-only-for-self assertions still pass under the new wrapping.

## 6. E2E: `apiClient.getUser(token, userId)` helper

- [x] 6.1 Modify `e2e/src/helpers/apiClient.ts` to add `getUser(token: string, userId: string): Promise<{status: number; body: UserSummary | ProblemDetail}>` using `getGetUserUrl(userId)` (imported from `e2e/src/api/generated/users-controller/users-controller.ts`) as the URL. Send `Authorization: Bearer <token>`.
- [x] 6.2 The helper's `{status, body}` return shape SHALL mirror `signup`, `login`, `createPost`, `deletePost`, `listPostsByAuthor`.
- [x] 6.3 Add a smoke test for the helper if the e2e suite has one for the others; otherwise rely on the consumer specs to exercise it.

## 7. E2E: `e2e/tests/profile.spec.ts`

- [x] 7.1 Create `e2e/tests/profile.spec.ts` with two scenarios in one file.
- [x] 7.2 Scenario A — author navigates to their own profile via the SPA:
  - Alice signs up via `apiClient.signup(randomSignupInput())`;
  - Alice's bearer token obtained via `apiClient.login(...)`;
  - one post seeded via `apiClient.createPost(aliceToken, { body: 'Profile seed post' })`;
  - drive `loginAndLandOnHome(page, aliceInput)` so the SPA is on `/home` and Alice's `PostCard` is visible;
  - locate the rendered author link (`getByRole('link', { name: aliceDisplayName })`) on her own card and click it;
  - assert `await expect(page).toHaveURL(/\/users\/[0-9a-f-]+$/)`;
  - assert the rendered page contains a heading with text equal to Alice's `displayName`;
  - assert the page contains a `role=article` with name `Post` containing `Profile seed post`;
  - assert there is NO `role=textbox` (composer hidden).
- [x] 7.3 Scenario B — non-author visits another user's profile by URL:
  - Alice signs up + seeds one post via `apiClient`;
  - Bob signs up via `apiClient` with a distinct email;
  - drive `loginAndLandOnHome(page, bobInput)` for Bob;
  - `await page.goto('/users/' + aliceId)`;
  - assert URL ends `/users/{aliceId}`;
  - assert heading text equals Alice's `displayName`;
  - assert a `role=article` `Post` containing Alice's seeded body is rendered;
  - assert NO `role=button` with name `Delete post` is visible inside that card;
  - assert NO `role=textbox` (composer hidden).

## 8. E2E: extend the axe-routes spec to cover `/users/:userId`

- [x] 8.1 Modify `e2e/tests/axe.routes.spec.ts` to add a fourth step:
  - after the existing `/home` step, navigate to `/users/{aliceId}` (Alice is already signed in from the prior step);
  - run `runAxeScan` and assert no violations.
- [x] 8.2 Keep the spec a single `test()` walking four routes sequentially — do not split.

## 9. Spec sync, validate, format

- [x] 9.1 Confirm `openspec/changes/add-user-profile/specs/user-profile/spec.md`, `specs/user-accounts/spec.md`, and `specs/posts/spec.md` reflect the implementation as shipped (route name, helper name, link `href` shape). Adjust any drift before opening the PR.
- [x] 9.2 Run `openspec validate add-user-profile --strict` and resolve any errors.
- [x] 9.3 Run the backend formatter, the frontend formatter (prettier or whatever the repo uses), and the e2e formatter. Confirm the diff is clean.

## 10. Full-suite smoke

- [x] 10.1 Run `./gradlew :backend:test` and confirm `UsersControllerIT` passes alongside the existing IT suite.
- [x] 10.2 Run `pnpm --dir frontend test` and confirm the new `ProfilePage.test.tsx` plus the updated `PostCard.test.tsx` and `App.tsx` routing test pass.
- [x] 10.3 Run `pnpm --dir e2e test` on Chromium, Firefox, and WebKit. Confirm `profile.spec.ts` passes and `axe.routes.spec.ts` still passes with the new fourth route.

## 11. PR

- [x] 11.1 Open a PR titled `add-user-profile`. Body links to the proposal and design.
- [x] 11.2 Call out in the description: (a) one new endpoint, (b) one new SPA route + page, (c) `PostCard` author becomes a link, (d) no schema change, (e) no new dependencies. Reviewers should be able to confirm the change set is `backend/**` (small) + `frontend/**` + `e2e/**` + `openapi/openapi.json` + `openspec/**`.
