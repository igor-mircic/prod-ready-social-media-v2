## Why

The platform has an auth backbone (`user-accounts`) but no content primitive yet — every
downstream social feature (follows, feed, comments, likes, notifications) needs **posts**
to exist before any of them are meaningful. Adding posts now also stress-tests the full-stack
delivery pattern (Flyway migration → controller → springdoc → orval → React → Playwright)
in a brand-new vertical, well before that pattern hardens around a single feature.

## What Changes

This change ships a **full vertical slice** — backend, database, frontend, and Playwright
e2e — for the new `posts` capability, matching the BE+FE+e2e pattern established by
`user-accounts`.

### Backend & database
- Add a Flyway migration `V3__create_posts.sql` creating a `posts` table with a
  soft-delete column and a composite index sized for the author-timeline read pattern.
- New REST endpoints under `/api/v1/posts` and `/api/v1/users/{userId}/posts`, all behind
  the existing deny-by-default `SecurityFilterChain` (no allowlist changes — every post
  endpoint requires a valid Bearer access token).
- Use **cursor-based pagination from day one** (`(created_at, id)` tuple, opaque base64),
  so the same pattern carries forward into the feed.
- Follow the established `useraccounts` slicing: flat package `com.prodready.social.posts`,
  JPA entity with **no `@ManyToOne`** to `User` — author referenced by `UUID` only, with
  the service explicitly batch-fetching authors to assemble response DTOs.
- Soft delete (`deleted_at`) rather than hard delete; FK `author_id` declared `ON DELETE RESTRICT`
  so any future account-deletion work makes an explicit decision rather than silently cascading.
- No post edits in V1 — `PATCH /posts/{id}` is out of scope and deferred to its own change.
- Testcontainers `*IT.java` tests cover create, read, list-with-cursor, soft-delete,
  author-only-delete authorization, and unauthenticated rejection.

### Frontend
- New feature module `frontend/src/features/posts/` containing a `PostComposer`
  (create), a `PostList` (cursor-paginated list of the current user's posts), and a
  `PostCard` (render + author-only delete control).
- Both forms/lists use the **Orval-generated hooks and Zod schemas** for the new endpoints,
  consistent with how signup/login are wired.
- The existing `/home` route is extended to render `PostComposer` and `PostList` for the
  current user **alongside** the existing `/me` greeting and Logout button. The existing
  HomePage requirements in `user-accounts` are not modified — the new components are
  additive content owned by the `posts` capability.
- Vitest tests override the generated MSW handlers to cover compose-success, compose-validation,
  list-pagination (loading more), delete-success, and 401-on-list error flows.

### End-to-end (Playwright)
- A new spec `e2e/tests/posts.spec.ts` exercises the full vertical: signup → login →
  compose a post → see it appear in the list → delete it → confirm it disappears.
- Covers at least one validation edge (empty body) and verifies the delete control is
  only shown for the current user's posts.

## Capabilities

### New Capabilities

- `posts`: end-to-end post capability — backend storage, REST API, frontend composer and
  timeline, and Playwright e2e coverage. Covers the `posts` table and its Flyway migration;
  the `POST /api/v1/posts`, `GET /api/v1/posts/{id}`, `GET /api/v1/users/{userId}/posts`
  (cursor-paginated), and `DELETE /api/v1/posts/{id}` endpoints; the request/response DTO
  contract (including the embedded author summary); the Testcontainers integration tests;
  the `frontend/src/features/posts/` React module wired to the Orval-generated hooks/Zod
  schemas; the Vitest tests using generated MSW handlers; and the Playwright e2e spec
  exercising signup → login → compose → list → delete.

### Modified Capabilities

None. The change adds endpoints to the existing API surface and adds new components on
the existing `/home` route, but does not change any requirement in `user-accounts`,
`api-contract`, `backend-scaffold`, `frontend-scaffold`, `frontend-styling`, `e2e`, or any
other existing spec. The new endpoints fall under the existing deny-by-default security
policy without needing an allowlist entry; the new OpenAPI paths are picked up automatically
by the existing springdoc pipeline; the new HomePage content is additive and does not remove
or alter the existing `/me` greeting or Logout button.

## Impact

- **DB**: new `posts` table; new Flyway migration `V3__create_posts.sql`. No changes to
  `users` or auth tables. New composite index `posts_author_created_idx` (partial,
  `WHERE deleted_at IS NULL`).
- **Backend code**: new package `com.prodready.social.posts` (entity, repository, service,
  controller, request/response DTOs, exceptions). No changes to existing packages.
- **API contract**: `openapi/openapi.json` snapshot regenerated to include the new post
  endpoints. CI drift check enforces the snapshot is committed.
- **Backend tests**: new `*IT.java` Testcontainers tests under `backend/src/test/java/.../posts/`
  covering create, read, list with cursor pagination, soft-delete, author-only delete
  authorization, and the deny-by-default response for unauthenticated callers.
- **Frontend code**: new feature module `frontend/src/features/posts/` (composer, list,
  card). `frontend/src/features/home/HomePage.tsx` is extended to render the new module
  alongside the existing greeting and Logout button. Orval re-runs to produce hooks,
  Zod schemas, and MSW handlers for the new endpoints.
- **Frontend tests**: new Vitest tests under `frontend/src/features/posts/` for compose,
  list pagination, delete, validation, and 401 flows.
- **E2E**: new Playwright spec `e2e/tests/posts.spec.ts` covering the full vertical
  (signup → login → compose → list → delete).
- **Auth & security**: no changes. All endpoints require a valid `Authorization: Bearer`
  header and are rejected by the existing security chain when one is absent.
- **Dependencies**: none. Uses only libraries already on the classpath
  (Spring Web, Spring Data JPA, Flyway, Postgres driver on the backend; React, TanStack
  Query, Zod, Orval-generated client, Tailwind, Vitest, MSW, Playwright on the frontend).
