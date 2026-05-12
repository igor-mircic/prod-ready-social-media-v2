## 1. Backend: Flyway migration `V4__create_follows.sql`

- [x] 1.1 Create `backend/src/main/resources/db/migration/V4__create_follows.sql` declaring a `follows` table with columns `follower_id UUID NOT NULL`, `followee_id UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
- [x] 1.2 Declare the composite primary key `PRIMARY KEY (follower_id, followee_id)` in the same `CREATE TABLE` statement.
- [x] 1.3 Declare both foreign keys with `REFERENCES users(id) ON DELETE CASCADE`. Do NOT use `RESTRICT` or `SET NULL`.
- [x] 1.4 Declare a `CHECK (follower_id <> followee_id)` constraint in the same `CREATE TABLE` statement (named, e.g. `follows_no_self`).
- [x] 1.5 Create a non-unique index `follows_followee_follower_idx ON follows (followee_id, follower_id)` to support the "who-follows-this-user" read pattern. The composite PK already covers the `(follower_id, followee_id)` direction.
- [x] 1.6 Confirm by `psql` (or the IT bootstrap) that `flyway:migrate` against an empty database leaves `follows` in the expected shape and constraints. Sanity-check the CHECK and the cascade by hand: `INSERT … (uuid_a, uuid_a, now())` raises a constraint violation; deleting a `users` row removes any `follows` rows that reference it.

## 2. Backend: `follows/` package — entity, id, repository, DTO, service

- [x] 2.1 Create package `backend/src/main/java/com/prodready/social/follows/`.
- [x] 2.2 Create `follows/FollowId.java` as a `public record FollowId(UUID followerId, UUID followeeId) implements Serializable {}` annotated `@Embeddable`. Provide a protected/public no-arg form as JPA may require (use a default-arg constructor or set fields via the record's canonical constructor — verify against the existing entity patterns).
- [x] 2.3 Create `follows/Follow.java` annotated `@Entity @Table(name = "follows")` with `@EmbeddedId FollowId id;` and `@Column(name = "created_at", nullable = false, updatable = false) private OffsetDateTime createdAt;`. Add a `@PrePersist void onCreate()` that sets `createdAt = OffsetDateTime.now()` when null. Do NOT declare `@ManyToOne User follower` or `@ManyToOne User followee`. The entity's references to users are by UUID only (the id components).
- [x] 2.4 Create `follows/FollowRepository.java` as a `public interface FollowRepository extends JpaRepository<Follow, FollowId>` with derived query methods: `boolean existsById(FollowId id)` (inherited), `long countByIdFollowerId(UUID followerId)`, `long countByIdFolloweeId(UUID followeeId)`, `void deleteById(FollowId id)` (inherited). Confirm the property-path syntax matches Spring Data's expected pattern for `@EmbeddedId` composite-key fields (`Id` prefix on the path).
- [x] 2.5 Create `follows/FollowStatsResponse.java` as `public record FollowStatsResponse(long followers, long following, boolean viewerFollows) {}`.
- [x] 2.6 Create `follows/SelfFollowException.java` as a small `RuntimeException` subclass that the controller / global handler can translate to `400 ProblemDetail` with a `detail` like "You cannot follow yourself". Match the existing `posts/PostAuthorMismatchException` / `posts/AuthorNotFoundException` style.
- [x] 2.7 Create `follows/FollowService.java` injected with `FollowRepository` and `UserRepository`. Implement:
  - `void follow(UUID callerId, UUID targetId)` — if `callerId.equals(targetId)` throw `SelfFollowException`; if `!userRepository.existsById(targetId)` throw `AuthorNotFoundException` (or a follow-specific `UserNotFoundException`, matching whichever pattern the existing handler maps to 404); if `followRepository.existsById(new FollowId(callerId, targetId))` return without insert (idempotent); otherwise `save(new Follow(new FollowId(callerId, targetId)))`.
  - `void unfollow(UUID callerId, UUID targetId)` — if `!userRepository.existsById(targetId)` throw the 404 exception; otherwise `followRepository.deleteById(new FollowId(callerId, targetId))` and swallow `EmptyResultDataAccessException` (the JPA `deleteById` default) so a missing row is a no-op. The self-unfollow case is naturally a no-op because no `(caller, caller)` row can exist.
  - `FollowStatsResponse stats(UUID callerId, UUID targetId)` — if `!userRepository.existsById(targetId)` throw the 404 exception; otherwise compute `followers = countByIdFolloweeId(targetId)`, `following = countByIdFollowerId(targetId)`, `viewerFollows = followRepository.existsById(new FollowId(callerId, targetId))` (which is `false` when `callerId.equals(targetId)` by construction).

## 3. Backend: `FollowsController` with three endpoints

- [x] 3.1 Create `follows/FollowsController.java` annotated `@RestController @RequestMapping("/api/v1") @SecurityRequirement(name = "bearerAuth")`, mirroring `PostsController`'s style exactly. Inject `FollowService`. Carry a private `requirePrincipal(principal)` helper identical in shape to `PostsController.requirePrincipal`.
- [x] 3.2 `@PostMapping("/users/{userId}/follow")`: `@Operation(operationId = "followUser", summary = "Follow a user")`. `@ApiResponses` covering 204 (no body), 400 (`ProblemDetail`), 401 (`ProblemDetail`), 404 (`ProblemDetail`). Handler signature: `public ResponseEntity<Void> followUser(@AuthenticationPrincipal UserPrincipal principal, @PathVariable("userId") UUID userId)`. Body: `UUID callerId = requirePrincipal(principal).id(); followService.follow(callerId, userId); return ResponseEntity.noContent().build();`.
- [x] 3.3 `@DeleteMapping("/users/{userId}/follow")`: `@Operation(operationId = "unfollowUser", summary = "Unfollow a user")`. `@ApiResponses` covering 204, 401, 404. Handler signature mirrors followUser. Body: `followService.unfollow(callerId, userId); return ResponseEntity.noContent().build();`.
- [x] 3.4 `@GetMapping("/users/{userId}/follow-stats")`: `@Operation(operationId = "getFollowStats", summary = "Follow stats for a user (counts + viewer relationship)")`. `@ApiResponses` covering 200 (`FollowStatsResponse`), 401, 404. Handler signature: `public ResponseEntity<FollowStatsResponse> getFollowStats(@AuthenticationPrincipal UserPrincipal principal, @PathVariable("userId") UUID userId)`. Body: `return ResponseEntity.ok(followService.stats(callerId, userId));`.
- [x] 3.5 Ensure `SelfFollowException` translates to `400 ProblemDetail` via the existing global exception handler. If the handler doesn't already cover a generic "bad request" subclass, add a one-method `@ExceptionHandler` to map it. Mirror how `PostAuthorMismatchException` is handled.
- [x] 3.6 Confirm the existing `SecurityFilterChain` already authenticates `/api/v1/users/**` (it does — the `posts` and user-profile capabilities use the same prefix). Do NOT add any allowlist entry.

## 4. Backend: Testcontainers integration tests

- [x] 4.1 Create `backend/src/test/java/com/prodready/social/follows/FollowsControllerIT.java` extending the existing Testcontainers integration-test base used by `PostsControllerIT` / `UsersControllerIT`.
- [x] 4.2 Seed test helpers: a method to sign up + log in two users (Alice and Bob), returning their ids and bearer tokens. Reuse the existing `useraccounts` test helpers if present.
- [x] 4.3 Cases (each as its own `@Test`):
  - 4.3.a `follow_happyPath_returns204AndInsertsRow` — Bob follows Alice; response is 204; one row exists in `follows` for `(bobId, aliceId)`.
  - 4.3.b `follow_repeated_isIdempotent` — Bob follows Alice twice; both responses 204; exactly one row exists for `(bobId, aliceId)`.
  - 4.3.c `follow_self_returns400` — Alice follows Alice; response is 400 with a `ProblemDetail` whose `detail` mentions self-follow; no row inserted.
  - 4.3.d `follow_unknownTarget_returns404` — Bob follows a random UUID not in `users`; response 404; `ProblemDetail` with `status` 404; no row inserted.
  - 4.3.e `follow_unauthenticated_returns401` — POST without an Authorization header; response 401; `ProblemDetail`.
  - 4.3.f `unfollow_happyPath_returns204AndRemovesRow` — seed `(bobId, aliceId)`; Bob unfollows Alice; response 204; no row exists.
  - 4.3.g `unfollow_whenNotFollowing_isIdempotent` — no row seeded; Bob unfollows Alice; response 204; `follows` is empty.
  - 4.3.h `unfollow_self_returns204` — Alice unfollows Alice; response 204; `follows` unchanged.
  - 4.3.i `unfollow_unknownTarget_returns404` — Bob unfollows a random UUID; response 404.
  - 4.3.j `unfollow_unauthenticated_returns401` — DELETE without an Authorization header; response 401.
  - 4.3.k `stats_happyPath_viewerFollowsTrue` — seed `(bobId, aliceId)`; Bob fetches stats for Alice; response 200 `{followers: 1, following: 0, viewerFollows: true}`.
  - 4.3.l `stats_happyPath_viewerFollowsFalse` — no row; Bob fetches stats for Alice; response 200 `{followers: 0, following: 0, viewerFollows: false}`.
  - 4.3.m `stats_ownProfile_viewerFollowsFalse` — Alice fetches stats for Alice; `viewerFollows` is `false`; counts reflect her actual followers / following.
  - 4.3.n `stats_unknownTarget_returns404` — Bob fetches stats for a random UUID; response 404.
  - 4.3.o `stats_unauthenticated_returns401` — GET without an Authorization header; response 401.

## 5. API contract: regenerate `openapi.json` and Orval client surfaces

- [x] 5.1 Refresh `openapi/openapi.json` via the repo's existing snapshot-generation task (whichever `./gradlew` task or `bootRun` flow `add-user-profile` used — confirm by reading `backend/build.gradle.kts` or the README).
- [x] 5.2 Verify the regenerated snapshot includes:
  - path `/api/v1/users/{userId}/follow` with `post` and `delete` operations, each declaring 204/401/404 responses (and 400 on the `post`);
  - path `/api/v1/users/{userId}/follow-stats` with a `get` operation declaring 200 / 401 / 404 responses;
  - a `FollowStatsResponse` schema declaring exactly `followers` (integer), `following` (integer), `viewerFollows` (boolean).
- [x] 5.3 Run Orval against the refreshed snapshot. Confirm:
  - `frontend/src/api/generated/follows-controller/follows-controller.ts` exists (or whatever tag-name Orval picks — adjust references downstream to match);
  - generated hooks `useFollowUser`, `useUnfollowUser`, `useGetFollowStats` exist;
  - generated URL helpers `getFollowUserUrl`, `getUnfollowUserUrl`, `getGetFollowStatsUrl` exist;
  - matching `e2e/src/api/generated/follows-controller/follows-controller.ts` exists with the same URL helpers.
- [x] 5.4 If the existing CI drift check reports any unexpected diff (e.g. operation re-ordering inside an existing controller), reconcile by re-running the snapshot generator and committing the freshly-deterministic output.

## 6. Frontend: extend `ProfilePage` with counts and the Follow / Unfollow toggle

- [x] 6.1 Modify `frontend/src/features/profile/ProfilePage.tsx` to fire `useGetFollowStats(safeUserId)` in parallel with the existing `useGetUser(safeUserId)`. Both queries run unconditionally on mount.
- [x] 6.2 Import the auth context (same hook `PostCard` uses to compare against `currentUser.id`) and capture `currentUser`. Compute `isOwnProfile = currentUser?.id === safeUserId`.
- [x] 6.3 Render under the existing display-name heading a counts row, e.g. `<p>{followers} followers · {following} following</p>`. Wrap each numeric value in a `<strong>` (or matching emphasis used elsewhere) so screen readers can pick out the count.
- [x] 6.4 When `!isOwnProfile`, render a Follow / Unfollow toggle button. Label rule:
  - `viewerFollows === false` → button accessible name `Follow`;
  - `viewerFollows === true` → button accessible name `Unfollow` (lock in one specific name in the implementation — the spec accepts either `Unfollow` or `Following`, but the tests need a stable string).
- [x] 6.5 Wire the button to the Orval-generated mutation hooks `useFollowUser` / `useUnfollowUser`. On mutation `onSuccess`, invalidate the `useGetFollowStats(safeUserId)` query key so the counts and the label refresh. Use the `queryClient.invalidateQueries({ queryKey: getGetFollowStatsQueryKey(safeUserId) })` pattern (Orval exposes the key factory alongside the hook).
- [x] 6.6 Disable the button while either mutation is in flight (`useFollowUser().isPending` / `useUnfollowUser().isPending`). Prevent double-submit by the same pattern the composer uses (the `posts.composer.hardening` requirement is precedent).
- [x] 6.7 While `useGetFollowStats` is still loading, render skeleton placeholders for the counts AND (when `!isOwnProfile`) for the toggle button. Match the visual weight of the loaded state so the layout does not jump on resolve. Reuse whatever skeleton primitive the project already has under `frontend/src/components/ui/` (e.g. `Skeleton`); if none, render a non-clickable placeholder span with width matching the loaded text and a muted background.
- [x] 6.8 When `isOwnProfile`, render counts but NOT the toggle button (return `null` for that region). Counts must still render even on own profile.
- [x] 6.9 If `useGetFollowStats` errors out (non-404 — the user query handles 404 at the page level), render a small inline error affordance under the counts region without taking down the rest of the page. Counts and button degrade gracefully; the rest of the page (heading, PostList) remains usable.

## 7. Frontend: Vitest extensions for `ProfilePage`

- [x] 7.1 Modify `frontend/src/features/profile/ProfilePage.test.tsx` (or add a sibling `ProfilePage.follows.test.tsx` under `frontend/src/features/profile/` — pick one based on file-length cleanliness). Mount with `<MemoryRouter initialEntries={['/users/{id}']}>` + `Routes` shell + auth-context provider seeded with the desired `currentUser.id`.
- [x] 7.2 Test cases (each an `it()` or `test()`):
  - 7.2.a "Non-own profile, viewerFollows=false renders Follow button" — `getUser` 200, `getFollowStats` 200 `{followers: 0, following: 0, viewerFollows: false}`, auth context's `currentUser.id !== userId`. Assert a `button` named `Follow` is rendered and `0 followers` text is present.
  - 7.2.b "Non-own profile, viewerFollows=true renders followed-state button" — same as above but `viewerFollows: true`, `followers: 1`. Assert a `button` named `Unfollow` (or whichever name was locked in 6.4) is rendered.
  - 7.2.c "Own profile renders counts but no toggle button" — auth context's `currentUser.id === userId`. Assert counts render and `screen.queryByRole('button', { name: /follow|unfollow|following/i })` returns null.
  - 7.2.d "Clicking Follow invokes the mutation and refetches stats" — set up MSW to respond to `POST /api/v1/users/{id}/follow` with 204 and to swap the next `getFollowStats` response to `viewerFollows: true, followers: 1`. Click Follow, then `await screen.findByRole('button', { name: 'Unfollow' })`, and assert the followers count visibly increased to `1`.
  - 7.2.e "Clicking Unfollow invokes the mutation and refetches stats" — mirror image of (d): start with `viewerFollows: true, followers: 1`; click the Unfollow button; MSW responds 204; next `getFollowStats` swaps to `viewerFollows: false, followers: 0`; assert button name becomes `Follow` and the count shows `0`.
- [x] 7.3 Smoke: re-run the existing 3 `ProfilePage.test.tsx` cases (heading + list, empty state, 404) and confirm they still pass against the extended page (the new query just adds a third query; the existing queries are unchanged).

## 8. E2E: `apiClient.follow / unfollow / getFollowStats` helpers

- [x] 8.1 Modify `e2e/src/helpers/apiClient.ts`:
  - import `getFollowUserUrl`, `getUnfollowUserUrl`, `getGetFollowStatsUrl` from `e2e/src/api/generated/follows-controller/follows-controller.ts`;
  - import the generated `FollowStatsResponse` type from `e2e/src/api/generated/openAPIDefinition.schemas.ts`;
  - add three result interfaces: `FollowResult { status: number; body: ProblemDetail | Record<string, never> }`, `UnfollowResult` (same shape), `GetFollowStatsResult { status: number; body: FollowStatsResponse | ProblemDetail }`.
- [x] 8.2 Add three methods to the `ApiClient` interface and to the `createApiClient` factory return:
  - `follow(token: string, userId: string): Promise<FollowResult>` — POST to `${baseURL}${getFollowUserUrl(userId)}` with `Authorization: Bearer <token>`, no body. Parse response text the same way the other helpers do.
  - `unfollow(token: string, userId: string): Promise<UnfollowResult>` — DELETE to `${baseURL}${getUnfollowUserUrl(userId)}` with `Authorization: Bearer <token>`.
  - `getFollowStats(token: string, userId: string): Promise<GetFollowStatsResult>` — GET `${baseURL}${getGetFollowStatsUrl(userId)}` with `Authorization: Bearer <token>` and `Accept: application/json, application/problem+json`.
- [x] 8.3 Confirm each new helper imports from the generated URL-helper module and does NOT hardcode the path string. This is asserted in the spec.

## 9. E2E: `e2e/tests/follows.spec.ts`

- [x] 9.1 Create `e2e/tests/follows.spec.ts` with two top-level `test.describe` blocks: "UI vertical" and "API edges". Keep them in one file so a CI failure points cleanly at the follow capability.
- [x] 9.2 UI-vertical `test()` — "Bob follows then unfollows Alice through the SPA":
  - sign up Alice via `apiClient.signup(randomSignupInput())`, capture `aliceId` and the input;
  - obtain Alice's token via `apiClient.login(aliceInput)`;
  - sign up Bob via `apiClient.signup(randomSignupInput())`, capture `bobId` and the input;
  - obtain Bob's token via `apiClient.login(bobInput)`;
  - drive `loginAndLandOnHome(page, bobInput)` so the SPA is on `/home`;
  - `await page.goto('/users/' + aliceId)`;
  - assert heading text equals Alice's `displayName`;
  - assert text "0 followers" and "0 following" visible (use `getByText` with a regex tolerant of formatting);
  - assert a `getByRole('button', { name: 'Follow' })` is visible;
  - click the Follow button;
  - await the counts updating: `await expect(page.getByText(/1 follower/i)).toBeVisible()`;
  - await the button label changing: `await expect(page.getByRole('button', { name: 'Unfollow' })).toBeVisible()`;
  - assert `apiClient.getFollowStats(aliceToken, aliceId)` returns `{followers: 1, following: 0, viewerFollows: false}`;
  - assert `apiClient.getFollowStats(bobToken, bobId)` returns `{followers: 0, following: 1, viewerFollows: false}`;
  - click the Unfollow button;
  - await `await expect(page.getByText(/0 followers/i)).toBeVisible()`;
  - await `await expect(page.getByRole('button', { name: 'Follow' })).toBeVisible()`.
- [x] 9.3 API-edges block:
  - 9.3.a `test('self-follow returns 400')` — sign up Alice, get token; assert `apiClient.follow(aliceToken, aliceId)` returns `{status: 400, body: <ProblemDetail with status 400>}`.
  - 9.3.b `test('repeated follow is idempotent at the API')` — sign up Alice and Bob; `apiClient.follow(bobToken, aliceId)` twice; both return 204; `getFollowStats(aliceToken, aliceId).body.followers === 1`.
  - 9.3.c `test('unfollow when not following is idempotent')` — sign up Alice and Bob; `apiClient.unfollow(bobToken, aliceId)` (no row); response 204; stats unchanged.
  - 9.3.d `test('follow/unfollow/stats on an unknown id return 404')` — generate a random UUID not in `users`; all three calls return 404 + ProblemDetail.
  - 9.3.e `test('all three endpoints reject unauthenticated calls with 401')` — bypass the apiClient helpers (which always send Bearer) and `fetch` each URL directly with no `Authorization` header; assert each returns 401 + ProblemDetail. Use the generated URL helpers to build the paths so the test stays in sync with the snapshot.

## 10. E2E: extend the axe-routes spec with a seeded follow relationship

- [x] 10.1 Modify `e2e/tests/axe.routes.spec.ts` (the existing "explicit axe scans on key routes" spec). After the existing `/home` and `/users/{aliceId}` scan steps, seed a follow: sign up Bob via `apiClient`, have Bob follow Alice via `apiClient.follow(bobToken, aliceId)`. Then log Bob into the SPA via `loginAndLandOnHome(page, bobInput)` and navigate Bob to `/users/{aliceId}`.
- [x] 10.2 Before running the scan, assert that the rendered page reflects the seeded relationship: counts text shows `1 follower` and a button named `Unfollow` is visible. (This is verification that the scan is exercising the seeded state, not just a pristine page.)
- [x] 10.3 Run `runAxeScan` on `/users/{aliceId}` and assert no violations. Reuse the existing `runAxeScan` fixture without modification.
- [x] 10.4 Keep the spec a single `test()` walking the routes sequentially — do not split into multiple `test()`s. If the existing spec is one `test()`, append to it; if it's structured otherwise, append in the same shape.

## 11. Spec sync, validate, format

- [x] 11.1 Confirm `openspec/changes/add-follows/specs/follows/spec.md` and `openspec/changes/add-follows/specs/user-profile/spec.md` reflect the implementation as shipped (button accessible name picked in 6.4, counts format picked in 6.3, IT case names, e2e file structure). Adjust any drift before opening the PR.
- [x] 11.2 Run `openspec validate add-follows --strict` and resolve any errors. Re-run after any spec edits.
- [x] 11.3 Run the backend formatter (`./gradlew :backend:spotlessApply` or whichever task the project uses — confirm from `backend/build.gradle.kts`), the frontend formatter (`pnpm --dir frontend format` / prettier), and the e2e formatter. Confirm the diff is clean.

## 12. Full-suite smoke

- [x] 12.1 Run `./gradlew :backend:test` and confirm `FollowsControllerIT` passes alongside the existing IT suite. Spot-check that no existing IT was affected by the new migration (a new `V*.sql` is additive and should be transparent, but a stray index-naming collision or DB-bootstrap order issue would surface here).
- [x] 12.2 Run `pnpm --dir frontend test` and confirm the new / extended `ProfilePage.test.tsx` cases pass and existing Vitest cases (especially the `useGetUser` 404 case and the empty-list case) still pass.
- [x] 12.3 Run `pnpm --dir e2e test` on Chromium, Firefox, and WebKit. Confirm `follows.spec.ts` passes on all three. Confirm `axe.routes.spec.ts` still passes with the new follow-seeding step. If the known `posts.composer.hardening` Firefox flake fires, re-run only — it's a tracked existing flake, not a regression of this change.

## 13. PR

- [x] 13.1 Open a PR titled `add-follows`. Body links to the proposal and design.
- [x] 13.2 Call out in the description: (a) three new endpoints under `/api/v1/users/{userId}/follow*`, (b) one new migration `V4__create_follows.sql` introducing the project's first composite-PK table, (c) no changes to `posts`, `PostList`, `PostCard`, `HomePage`, `App.tsx`, or `AuthContext` — the follow surface is fully scoped to `ProfilePage`, (d) no new dependencies, (e) follower / following list pages are explicitly deferred (see proposal non-goals). Reviewers should be able to confirm the change set is `backend/src/main/resources/db/migration/V4__*.sql` + `backend/src/main/java/com/prodready/social/follows/**` + `backend/src/test/java/com/prodready/social/follows/**` + `openapi/openapi.json` + `frontend/src/features/profile/**` + `frontend/src/api/generated/**` (regenerated) + `e2e/src/helpers/apiClient.ts` + `e2e/src/api/generated/**` (regenerated) + `e2e/tests/follows.spec.ts` + `e2e/tests/axe.routes.spec.ts` + `openspec/**`.
