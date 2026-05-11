## 1. Backend — DB migration

- [ ] 1.1 Write Flyway migration `backend/src/main/resources/db/migration/V3__create_posts.sql` creating `posts` (`id UUID PRIMARY KEY`, `author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`, `body TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `deleted_at TIMESTAMPTZ NULL`).
- [ ] 1.2 Extend the same migration with the partial composite index `CREATE INDEX posts_author_created_idx ON posts (author_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;`.
- [ ] 1.3 Verify the migration runs cleanly against an empty Testcontainers Postgres (extend an existing context-loads IT or piggy-back on the first `PostIT` test class to assert the table and index exist).

## 2. Backend — entity, repository, cursor codec

- [ ] 2.1 Add `Post` JPA entity under `backend/src/main/java/com/prodready/social/posts/Post.java`: `@Id UUID id`, `UUID authorId` (column `author_id`, NO `@ManyToOne` to `User`), `String body`, `OffsetDateTime createdAt` (column `created_at`, `updatable=false`), `OffsetDateTime deletedAt` (nullable). `@PrePersist` defaults `createdAt` to `OffsetDateTime.now()` when unset. Provide a public constructor for service-side instantiation and a protected no-arg constructor for JPA, matching the `User` pattern.
- [ ] 2.2 Add `PostRepository extends JpaRepository<Post, UUID>` with derived/`@Query` methods sized for the spec'd read patterns: `Optional<Post> findActiveById(UUID id)` (filters `deleted_at IS NULL`), and a cursor-paged author-list method that takes `(authorId, cursorCreatedAt, cursorId, limit)` and returns posts strictly older than the cursor tuple in `(created_at DESC, id DESC)` order — implement with `@Query` using JPQL or native SQL, fetching `limit + 1` rows so the service can detect whether a `nextCursor` should be returned. Keep `findById` package-private and only used by `PostService` for ownership/delete checks.
- [ ] 2.3 Add a `PostCursorCodec` utility (package-private under `posts/`) with `String encode(OffsetDateTime createdAt, UUID id)` → base64url-encoded `[0x01][8-byte BE millis][16-byte UUID]`, and `DecodedCursor decode(String cursor)` returning `(createdAt, id)` or throwing a typed `InvalidCursorException` on bad version/length/encoding.

## 3. Backend — service, DTOs, exceptions

- [ ] 3.1 Add `CreatePostRequest` (record) with `@NotBlank @Size(max = 500) String body`.
- [ ] 3.2 Add `PostResponse` (record): `UUID id`, `AuthorSummary author` (nested record with `UUID id`, `String displayName`), `String body`, `OffsetDateTime createdAt`. No other fields.
- [ ] 3.3 Add `PostListResponse` (record): `List<PostResponse> items`, `String nextCursor` (nullable).
- [ ] 3.4 Add `PostNotFoundException`, `PostAuthorMismatchException`, `InvalidCursorException`, `AuthorNotFoundException` (the last for list-by-author when userId doesn't exist).
- [ ] 3.5 Implement `PostService` exposing: `create(UUID callerId, CreatePostRequest)`, `getById(UUID id)`, `listByAuthor(UUID authorId, String cursor, Integer limit)`, `delete(UUID callerId, UUID postId)`. Internals:
  - `create`: builds a `Post(randomUUID, callerId, body, …)` and persists; returns a `PostResponse` assembled via `assemble(List.of(post))`.
  - `getById`: `findActiveById(...)` → `PostNotFoundException` if absent; returns `assemble(List.of(post))`.
  - `listByAuthor`: verify the author exists (`userRepository.findById(authorId).orElseThrow(AuthorNotFoundException::new)`); decode cursor if present; call the cursor-paged repository method with `limit+1` (clamped to `[1, 50]`, default `20`); if returned size is `limit+1`, drop the last row and emit `nextCursor = codec.encode(lastKept.createdAt, lastKept.id)`; otherwise `nextCursor = null`. Assemble via `assemble(items)`.
  - `delete`: load the row with `postRepository.findById(...)` (package-private raw method). Throw `PostNotFoundException` if missing, soft-deleted, or `authorId != callerId` (all three folded into 404 per spec). On success, set `deletedAt = OffsetDateTime.now()` and save.
  - `assemble(List<Post> posts)`: collect distinct `authorIds`; one `userRepository.findAllById(authorIds)` call; build `Map<UUID, User>`; map each post to `PostResponse` with the embedded `AuthorSummary`. Single batched author lookup per request.

## 4. Backend — controller

- [ ] 4.1 Add `PostsController` (`@RestController @RequestMapping("/api/v1")`) with endpoints `POST /posts`, `GET /posts/{id}`, `GET /users/{userId}/posts`, `DELETE /posts/{id}`. Inject the authenticated `UserPrincipal` via `@AuthenticationPrincipal` for the create + delete endpoints and pass `principal.id()` as the caller id to `PostService`.
- [ ] 4.2 Map `GET /users/{userId}/posts` query params `?cursor` and `?limit` directly to `PostService.listByAuthor`. Return the assembled `PostListResponse`.
- [ ] 4.3 Annotate request/response shapes for springdoc so the OpenAPI snapshot picks up the correct schemas; in particular, annotate the controller with `@SecurityRequirement(name = "bearer-token")` (or whatever scheme the existing protected endpoints use) so the generated client treats all four operations as Bearer-required.
- [ ] 4.4 Extend `GlobalExceptionHandler` to map `PostNotFoundException` → 404 `ProblemDetail`, `AuthorNotFoundException` → 404, `InvalidCursorException` → 400 with `cursor` listed in extensions. (`PostAuthorMismatchException` is folded into 404 inside the service, so a handler is not required — but if added, also map to 404.)

## 5. Backend — integration tests

- [ ] 5.1 Add `PostsITSupport` (or reuse `AuthITSupport`) to provision two test users via the existing signup flow and log them in so tests have two Bearer tokens to work with.
- [ ] 5.2 Add `CreatePostIT`: success path (201, body matches, `author` is the caller, row exists in DB with the request body), unauthenticated → 401, empty body → 400, whitespace-only body → 400, 501-character body → 400.
- [ ] 5.3 Add `ReadPostIT`: happy path 200 with embedded author summary; unknown id → 404; soft-deleted post → 404; unauthenticated → 401.
- [ ] 5.4 Add `ListPostsIT`: seed N posts for a user across distinct timestamps; assert first page returns the most recent `limit`; assert second page advances strictly past the cursor; assert no item appears on both pages; assert soft-deleted rows are excluded; assert `limit` clamped to 50 when exceeded; assert default is 20; assert unknown `userId` returns 404; assert unauthenticated → 401; assert malformed `cursor` → 400 with `cursor` in the ProblemDetail extensions.
- [ ] 5.5 Add `DeletePostIT`: author can soft-delete own post (204 + `deleted_at` set + row not physically removed); subsequent read returns 404; non-author delete attempt → 404 + row unchanged; missing id → 404; already-soft-deleted → 404; unauthenticated → 401.
- [ ] 5.6 Add a `PostsSecurityIT` (or extend the existing `SecurityFilterChainIT`): assert each of the four post endpoints returns 401 ProblemDetail with no `Authorization` header; assert the SecurityConfig allowlist still does NOT enumerate any `/api/v1/posts/**` or `/api/v1/users/*/posts` path.

## 6. OpenAPI contract

- [ ] 6.1 Run `./gradlew generateOpenApiDocs` and confirm `openapi/openapi.json` now declares operations for `createPost`, `getPostById`, `listPostsByAuthor`, and `deletePost`, plus the `CreatePostRequest`, `PostResponse`, `AuthorSummary`, and `PostListResponse` schemas. Commit the updated snapshot.
- [ ] 6.2 Confirm the four operations are marked as requiring the Bearer security scheme in the generated spec; if not, fix the controller annotations and regenerate.

## 7. Frontend — generated client

- [ ] 7.1 Re-run Orval and confirm new generated files exist under `frontend/src/api/generated/queries/posts-controller/` (mutations + queries), `frontend/src/api/generated/zod/posts-controller/` (Zod schemas for the request/response), and `frontend/src/api/generated/msw/posts-controller/` (handlers).
- [ ] 7.2 Verify the generated hooks treat the four operations as Bearer-required (no orval option should be needed if the OpenAPI spec is annotated; otherwise update `frontend/orval.config.ts` to set the security scheme).

## 8. Frontend — posts feature module

- [ ] 8.1 Add `frontend/src/features/posts/PostComposer.tsx`: react-hook-form + Zod resolver bound to the generated `CreatePostRequest` schema; single multiline textarea for `body`; submit invokes the generated create mutation; `onSuccess` calls `queryClient.invalidateQueries({queryKey: [<list-key-for-current-user>]})` and resets the form. Submit button disabled while the form is invalid or the mutation is in flight.
- [ ] 8.2 Add `frontend/src/features/posts/PostList.tsx` accepting a `userId: string` prop. Consumes the generated list query via TanStack Query's `useInfiniteQuery`; `getNextPageParam = (lastPage) => lastPage.nextCursor ?? undefined`. Renders each item via `<PostCard post={item} />`. Includes a "Load more" button visible while `hasNextPage`.
- [ ] 8.3 Add `frontend/src/features/posts/PostCard.tsx`: renders `author.displayName`, formatted `createdAt`, and `body`. Reads `currentUser` from `AuthContext`; if `post.author.id === currentUser.id`, renders a delete control that invokes the generated delete mutation and, on success, invalidates the same list query consumed by `PostList`. If not the author, the control is not rendered at all.
- [ ] 8.4 Style the three components with Tailwind utilities consistent with the existing signup/login forms; no new global CSS, no shadcn pieces beyond what the existing styling spec already permits.

## 9. Frontend — HomePage extension

- [ ] 9.1 Extend `frontend/src/features/home/HomePage.tsx`: keep the existing `Hello, {displayName}` greeting and Logout button verbatim; below them, render `<PostComposer />` and `<PostList userId={currentUser.id} />`. Do not change the route, do not change the existing `useMe` call.
- [ ] 9.2 Confirm the existing `HomePage.test.tsx` still passes; update its assertions only if Tailwind layout changes accidentally affect what it queries for.

## 10. Frontend — Vitest tests

- [ ] 10.1 Add `frontend/src/features/posts/PostComposer.test.tsx`: success path (override MSW handler to return 201; submit valid body; assert the list invalidation triggers a refetch and the new post appears) and validation path (submit empty body; assert validation message rendered; assert no network request fired — `msw` request listener counts zero hits for `POST /api/v1/posts`).
- [ ] 10.2 Add `frontend/src/features/posts/PostList.test.tsx`: pagination across two pages (MSW returns page 1 with non-null `nextCursor`, page 2 with `nextCursor: null`; click "Load more"; assert both pages' items render; assert no third fetch occurs).
- [ ] 10.3 Add `frontend/src/features/posts/PostCard.test.tsx`: delete-own-post path (mount the card with `author.id === currentUser.id`; click delete; MSW returns 204; assert the list invalidation triggers a refetch and the post is gone); other-author path (mount with `author.id !== currentUser.id`; assert delete control is not rendered).

## 11. E2E (Playwright)

- [ ] 11.1 Add `e2e/tests/posts.spec.ts` covering the full vertical: signup a fresh user → login → land on `/home` → fill the composer with a non-empty body and submit → assert the new post appears in the list → click the delete control on its card → assert the post is no longer in the list.
- [ ] 11.2 In the same spec (or a sibling spec file), assert the composer validates an empty body client-side: type nothing, attempt to submit, assert the SPA does not fire `POST /api/v1/posts` (Playwright `page.waitForRequest` with a short timeout or a request listener).

## 12. Wrap-up

- [ ] 12.1 Run `openspec validate add-posts --strict` and resolve any findings.
- [ ] 12.2 Run the full backend test suite (`./gradlew test`), the full frontend test suite (`pnpm -C frontend test`), and the e2e spec (`pnpm -C e2e exec playwright test tests/posts.spec.ts`). All green.
- [ ] 12.3 Manual smoke against a live local stack: `docker compose up`, run the backend, run the frontend dev server, walk the vertical in the browser (signup → login → compose two posts → reload → see both → delete one → see one).
- [ ] 12.4 Update `README.md` (project root) with one short section ("Posting locally") describing how to use the composer + list on `/home`. Do NOT add per-endpoint API docs to the README — those live in `openapi/openapi.json`.
