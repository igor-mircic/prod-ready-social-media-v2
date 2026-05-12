# follows Specification

## Purpose
TBD - created by archiving change add-follows. Update Purpose after archive.
## Requirements
### Requirement: A `follows` table is created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V4__create_follows.sql` that creates a `follows` table representing a directed, public, insta-follow relationship between two users.

#### Scenario: Migration creates the table

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** a `follows` table exists
- **AND** has a `follower_id` column of type `UUID NOT NULL` with a foreign key to `users(id)` declared `ON DELETE CASCADE`
- **AND** has a `followee_id` column of type `UUID NOT NULL` with a foreign key to `users(id)` declared `ON DELETE CASCADE`
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` with a default of `now()`
- **AND** has a composite primary key `(follower_id, followee_id)`
- **AND** has a `CHECK` constraint enforcing `follower_id <> followee_id`.

#### Scenario: Foreign keys are CASCADE, not RESTRICT

- **WHEN** a reader inspects the migration
- **THEN** the `follower_id` foreign-key constraint declares `ON DELETE CASCADE`
- **AND** the `followee_id` foreign-key constraint declares `ON DELETE CASCADE`
- **AND** neither constraint declares `ON DELETE RESTRICT` or `ON DELETE SET NULL`.

#### Scenario: Reverse index supports the "who-follows-this-user" read pattern

- **WHEN** a reader inspects the migration
- **THEN** an index `follows_followee_follower_idx` exists on `follows (followee_id, follower_id)`
- **AND** the index is non-unique (the underlying tuple is already unique by the composite PK).

#### Scenario: Self-follow is rejected at the DB layer

- **WHEN** a SQL-level `INSERT INTO follows (follower_id, followee_id, created_at) VALUES ($1, $1, now())` is attempted with `$1` equal to itself
- **THEN** the database raises a check-constraint violation
- **AND** no row is inserted.

### Requirement: Follow endpoint inserts the (caller, target) row and is idempotent

The backend SHALL expose `POST /api/v1/users/{userId}/follow`. On success the endpoint SHALL insert a `(caller, userId)` row in `follows` and SHALL return `204 No Content`. The endpoint SHALL be idempotent: a `POST` from a caller who already follows `userId` SHALL also return `204 No Content` without raising a unique-constraint error. A `POST` whose `userId` equals the caller SHALL be rejected with `400 ProblemDetail` before reaching the DB. Unknown `userId` SHALL return `404 ProblemDetail`. Unauthenticated callers SHALL receive `401 ProblemDetail`.

#### Scenario: First follow inserts the row and returns 204

- **WHEN** an authenticated caller posts `POST /api/v1/users/{targetId}/follow` for an existing `targetId` that the caller does not yet follow
- **THEN** the response status is 204
- **AND** the response body is empty
- **AND** a new row exists in `follows` whose `(follower_id, followee_id)` equals `(callerId, targetId)`.

#### Scenario: Repeated follow is idempotent

- **WHEN** the same authenticated caller posts `POST /api/v1/users/{targetId}/follow` a second time for the same `targetId`
- **THEN** the response status is 204
- **AND** the response body is empty
- **AND** exactly one row in `follows` exists for `(callerId, targetId)` (not two).

#### Scenario: Self-follow is rejected with 400

- **WHEN** an authenticated caller posts `POST /api/v1/users/{callerId}/follow` with `userId` equal to the caller's own id
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` whose `detail` mentions that a user cannot follow themselves
- **AND** no row is inserted into `follows`.

#### Scenario: Unknown target returns 404

- **WHEN** an authenticated caller posts `POST /api/v1/users/{userId}/follow` with a syntactically-valid `userId` that does not exist in `users`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404
- **AND** no row is inserted into `follows`.

#### Scenario: Unauthenticated caller receives 401

- **WHEN** a client posts `POST /api/v1/users/{userId}/follow` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401
- **AND** no row is inserted into `follows`.

### Requirement: Unfollow endpoint deletes the (caller, target) row and is idempotent

The backend SHALL expose `DELETE /api/v1/users/{userId}/follow`. On success the endpoint SHALL remove the `(caller, userId)` row from `follows` and SHALL return `204 No Content`. The endpoint SHALL be idempotent: a `DELETE` from a caller who does not currently follow `userId` (including the self-unfollow case where no row could exist by construction) SHALL also return `204 No Content`. Unknown `userId` SHALL return `404 ProblemDetail`. Unauthenticated callers SHALL receive `401 ProblemDetail`.

#### Scenario: Unfollow removes the row and returns 204

- **WHEN** an authenticated caller deletes `DELETE /api/v1/users/{targetId}/follow` for a `targetId` that the caller currently follows
- **THEN** the response status is 204
- **AND** the response body is empty
- **AND** no row exists in `follows` for `(callerId, targetId)`.

#### Scenario: Unfollow when not following is idempotent

- **WHEN** an authenticated caller deletes `DELETE /api/v1/users/{targetId}/follow` for a `targetId` that the caller does not currently follow
- **THEN** the response status is 204
- **AND** the response body is empty
- **AND** the `follows` table is unchanged.

#### Scenario: Self-unfollow returns 204

- **WHEN** an authenticated caller deletes `DELETE /api/v1/users/{callerId}/follow` with `userId` equal to the caller's own id
- **THEN** the response status is 204
- **AND** the response body is empty
- **AND** the `follows` table is unchanged.

#### Scenario: Unknown target returns 404

- **WHEN** an authenticated caller deletes `DELETE /api/v1/users/{userId}/follow` with a syntactically-valid `userId` that does not exist in `users`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: Unauthenticated caller receives 401

- **WHEN** a client deletes `DELETE /api/v1/users/{userId}/follow` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.

### Requirement: Follow-stats endpoint returns counts and the viewer relationship

The backend SHALL expose `GET /api/v1/users/{userId}/follow-stats` returning a JSON body `{ followers: long, following: long, viewerFollows: boolean }`. `followers` SHALL be the count of rows in `follows` where `followee_id = userId`. `following` SHALL be the count of rows in `follows` where `follower_id = userId`. `viewerFollows` SHALL be `true` iff a row exists in `follows` where `(follower_id, followee_id) = (callerId, userId)`. Unknown `userId` SHALL return `404 ProblemDetail`. Unauthenticated callers SHALL receive `401 ProblemDetail`.

#### Scenario: Counts reflect the live `follows` table

- **WHEN** an authenticated caller fetches `GET /api/v1/users/{targetId}/follow-stats`
- **AND** the `follows` table contains exactly N rows with `followee_id = targetId`
- **AND** the `follows` table contains exactly M rows with `follower_id = targetId`
- **THEN** the response status is 200
- **AND** the response body's `followers` equals N
- **AND** the response body's `following` equals M.

#### Scenario: viewerFollows is true when the caller follows the target

- **WHEN** an authenticated caller fetches `GET /api/v1/users/{targetId}/follow-stats`
- **AND** a row exists in `follows` for `(callerId, targetId)`
- **THEN** the response body's `viewerFollows` is `true`.

#### Scenario: viewerFollows is false when the caller does not follow the target

- **WHEN** an authenticated caller fetches `GET /api/v1/users/{targetId}/follow-stats`
- **AND** no row exists in `follows` for `(callerId, targetId)`
- **THEN** the response body's `viewerFollows` is `false`.

#### Scenario: viewerFollows is false for the caller's own profile

- **WHEN** an authenticated caller fetches `GET /api/v1/users/{callerId}/follow-stats` with `userId` equal to the caller's own id
- **THEN** the response status is 200
- **AND** the response body's `viewerFollows` is `false`
- **AND** the `followers` and `following` counts are the caller's own counts (computed exactly as for any other target).

#### Scenario: Unknown target returns 404

- **WHEN** an authenticated caller fetches `GET /api/v1/users/{userId}/follow-stats` with a syntactically-valid `userId` that does not exist in `users`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: Unauthenticated caller receives 401

- **WHEN** a client fetches `GET /api/v1/users/{userId}/follow-stats` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.

### Requirement: All follow endpoints are authenticated under the existing security chain

Every endpoint introduced by this capability (`POST /api/v1/users/{userId}/follow`, `DELETE /api/v1/users/{userId}/follow`, `GET /api/v1/users/{userId}/follow-stats`) SHALL require a valid `Authorization: Bearer <access-token>` header and SHALL fall under the existing deny-by-default `SecurityFilterChain` without adding any allowlist entries.

#### Scenario: Allowlist is unchanged

- **WHEN** a reader inspects the security configuration class
- **THEN** the allowlist does NOT include any `/api/v1/users/*/follow` or `/api/v1/users/*/follow-stats` entry.

#### Scenario: Each follow endpoint rejects unauthenticated callers

- **WHEN** a client calls any of `POST /api/v1/users/{userId}/follow`, `DELETE /api/v1/users/{userId}/follow`, or `GET /api/v1/users/{userId}/follow-stats` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

### Requirement: Cross-aggregate reference is by UUID, not JPA relationship

The `Follow` JPA entity SHALL hold the relationship endpoints as `UUID followerId` and `UUID followeeId` fields, NOT as `@ManyToOne User follower` / `@ManyToOne User followee` relationships. `FollowService` SHALL fetch user existence checks via `userRepository.existsById(...)`, not via a JPA association on `Follow`.

#### Scenario: Follow entity has no JPA relationship to User

- **WHEN** a reader inspects `backend/src/main/java/com/prodready/social/follows/Follow.java`
- **THEN** the entity declares a `followerId` field of type `java.util.UUID`
- **AND** declares a `followeeId` field of type `java.util.UUID`
- **AND** does NOT declare any `@ManyToOne`, `@OneToMany`, `@OneToOne`, or `@ManyToMany` annotation referencing `User`.

#### Scenario: Service checks user existence via repository, not via association

- **WHEN** a reader inspects `FollowService` for the unknown-id check path
- **THEN** the service calls `userRepository.existsById(...)` (or equivalent) to verify the target user exists
- **AND** does NOT navigate from a `Follow` instance to a `User` via a JPA association.

### Requirement: Backend integration tests cover the follow lifecycle

The `backend/` project SHALL include Testcontainers integration tests (matching the existing `*IT.java` pattern under `backend/src/test/java/com/prodready/social/posts/` and `.../useraccounts/`) under `backend/src/test/java/com/prodready/social/follows/` that exercise: follow happy path, follow idempotent on duplicate, self-follow rejected with 400, follow unknown target returns 404, follow unauthenticated returns 401, unfollow happy path, unfollow idempotent when not following, self-unfollow returns 204, unfollow unknown target returns 404, unfollow unauthenticated returns 401, stats happy path with mixed `viewerFollows: true` and `false` cases across two callers, stats for the caller's own id returns `viewerFollows: false`, stats unknown target returns 404, stats unauthenticated returns 401.

#### Scenario: Test class exists and is wired to Testcontainers

- **WHEN** a reader inspects `backend/src/test/java/com/prodready/social/follows/`
- **THEN** there is at least one `*IT.java` class that uses Testcontainers Postgres
- **AND** asserts each of the lifecycle cases listed above.

### Requirement: OpenAPI snapshot includes the new follow endpoints

The committed `openapi/openapi.json` snapshot SHALL include the three new follow endpoints with the agreed request / response schemas, and CI's existing drift check SHALL fail if the snapshot is stale.

#### Scenario: Snapshot lists the new paths

- **WHEN** a reader inspects `openapi/openapi.json`
- **THEN** the document declares a `paths` entry for `/api/v1/users/{userId}/follow` with `post` and `delete` operations
- **AND** declares a `paths` entry for `/api/v1/users/{userId}/follow-stats` with a `get` operation
- **AND** the stats operation's `200` response references a schema declaring exactly `followers` (integer), `following` (integer), and `viewerFollows` (boolean)
- **AND** the operations' `401` and `404` responses reference `ProblemDetail`.

#### Scenario: CI fails on snapshot drift

- **WHEN** a developer modifies a follow controller without regenerating the snapshot, and pushes
- **THEN** the existing CI drift-check job fails
- **AND** the failure blocks merge.

### Requirement: E2E ApiClient exposes authenticated follow, unfollow, and getFollowStats

The e2e `ApiClient` SHALL expose three new methods: `follow(token, userId)`, `unfollow(token, userId)`, and `getFollowStats(token, userId)`. Each method SHALL perform the corresponding HTTP call against the real backend with `Authorization: Bearer <token>`, SHALL use the Orval-generated URL helpers from `e2e/src/api/generated/follows-controller/follows-controller.ts` (not a hardcoded path), and SHALL return a `{ status, body }` shape consistent with the existing `signup`, `login`, `getUser`, `createPost`, `deletePost`, and `listPostsByAuthor` methods.

#### Scenario: ApiClient exposes authenticated follow

- **WHEN** a test calls `apiClient.follow(token, userId)` with a valid bearer `token` and an existing `userId`
- **THEN** the helper performs `POST /api/v1/users/{userId}/follow` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing helpers.

#### Scenario: ApiClient exposes authenticated unfollow

- **WHEN** a test calls `apiClient.unfollow(token, userId)` with a valid bearer `token` and an existing `userId`
- **THEN** the helper performs `DELETE /api/v1/users/{userId}/follow` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing helpers.

#### Scenario: ApiClient exposes authenticated getFollowStats

- **WHEN** a test calls `apiClient.getFollowStats(token, userId)` with a valid bearer `token` and an existing `userId`
- **THEN** the helper performs `GET /api/v1/users/{userId}/follow-stats` against the real backend with `Authorization: Bearer <token>`
- **AND** returns a `{ status, body }` shape consistent with the existing helpers
- **AND** on a 200 response the `body` declares exactly the properties `followers`, `following`, and `viewerFollows`.

#### Scenario: ApiClient follow helpers use the generated URL helpers

- **WHEN** a reader inspects the implementations of `apiClient.follow`, `apiClient.unfollow`, and `apiClient.getFollowStats`
- **THEN** each implementation imports its URL helper from `e2e/src/api/generated/follows-controller/follows-controller.ts`
- **AND** none of the three hardcode the string `/api/v1/users` or any literal path containing it.

### Requirement: Playwright e2e spec exercises the follow vertical through the UI

The `e2e/` project SHALL include a Playwright spec at `e2e/tests/follows.spec.ts` that exercises the follow / unfollow round-trip end-to-end against the real backend and frontend. The spec SHALL prove four facts in one run: (1) Bob's first visit to Alice's profile shows the correct initial counts and a **Follow** button; (2) clicking **Follow** updates both the counts AND the button label on the rendered page without a navigation; (3) the underlying graph reflects the change from Alice's perspective (her `followers` count goes up by 1 as observed via `apiClient.getFollowStats(aliceToken, aliceId)`) AND from Bob's perspective (his `following` count goes up by 1); (4) clicking **Unfollow** reverts (1) — counts and label.

#### Scenario: Bob follows then unfollows Alice through the SPA

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI) and captures Alice's id
- **AND** obtains Alice's bearer access token via `apiClient.login(...)` (no UI)
- **AND** signs up Bob via the `apiClient` (no UI) with a distinct email and captures Bob's id
- **AND** obtains Bob's bearer access token via `apiClient.login(...)` (no UI)
- **AND** logs Bob in via the SPA's login form and lands on `/home`
- **AND** navigates Bob directly to `/users/{aliceId}` via `page.goto`
- **AND** observes a heading with text equal to Alice's `displayName`
- **AND** observes follower / following count text reflecting `followers: 0, following: 0`
- **AND** observes a visible `role=button` with accessible name `Follow`
- **AND** clicks the `Follow` button
- **AND** observes the count text update to reflect `followers: 1, following: 0`
- **AND** observes a visible `role=button` whose accessible name reflects the followed state (e.g. `Unfollow` or `Following`)
- **AND** `apiClient.getFollowStats(aliceToken, aliceId)` returns `{ followers: 1, following: 0, viewerFollows: false }`
- **AND** `apiClient.getFollowStats(bobToken, bobId)` returns `{ followers: 0, following: 1, viewerFollows: false }`
- **AND** clicks the followed-state button to unfollow
- **AND** observes the count text revert to reflect `followers: 0, following: 0`
- **AND** observes a visible `role=button` with accessible name `Follow`.

### Requirement: Playwright e2e spec proves the API-level edge cases

The `e2e/` project SHALL include Playwright coverage (in the same `follows.spec.ts` file or a sibling) that proves the corner cases that do not surface in the UI: self-follow via the API is rejected with `400`; repeated follow via the API is idempotent (both calls return `204` and the stats `followers` count stays at `1`); unfollow when not following via the API is idempotent (returns `204` and the stats are unchanged); follow / unfollow / stats against an unknown target id return `404`; all three endpoints return `401` when called without a bearer token.

#### Scenario: Self-follow via the API returns 400

- **WHEN** the spec calls `apiClient.follow(aliceToken, aliceId)` with `userId` equal to Alice's own id
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` with `status` 400.

#### Scenario: Repeated follow is idempotent at the API

- **WHEN** the spec calls `apiClient.follow(bobToken, aliceId)` twice in a row
- **THEN** both responses have status 204
- **AND** `apiClient.getFollowStats(aliceToken, aliceId)` returns `followers: 1` (not `2`).

#### Scenario: Unfollow when not following is idempotent at the API

- **WHEN** the spec calls `apiClient.unfollow(bobToken, aliceId)` for a relationship that does not currently exist
- **THEN** the response status is 204
- **AND** `apiClient.getFollowStats(aliceToken, aliceId)` returns the same `followers` count as before the call.

#### Scenario: Follow, unfollow, and stats against an unknown id return 404

- **WHEN** the spec calls each of `apiClient.follow`, `apiClient.unfollow`, and `apiClient.getFollowStats` with a syntactically-valid `userId` that does not exist
- **THEN** all three responses have status 404
- **AND** all three response bodies are `ProblemDetail` with `status` 404.

#### Scenario: All three endpoints reject unauthenticated calls with 401

- **WHEN** the spec calls each of the three endpoints with no `Authorization` header (via a raw `fetch`, since the `apiClient` helpers always send the bearer)
- **THEN** all three responses have status 401
- **AND** all three response bodies are `ProblemDetail` with `status` 401.

### Requirement: Playwright axe scan covers the profile route with a seeded follow relationship

The `e2e/` project's existing `axe.routes.spec.ts` SHALL be extended (or a sibling spec under the same "explicit axe scans on key routes" requirement SHALL be added) to run `runAxeScan` on `/users/:userId` AFTER seeding a follow relationship via the `apiClient`, so the scan exercises the rendered counts and the Follow / Unfollow toggle affordance.

#### Scenario: Axe scans clean on /users/:userId with a seeded follow relationship

- **WHEN** the Playwright spec runs against the harness
- **THEN** it signs up Alice via the `apiClient` (no UI)
- **AND** signs up Bob via the `apiClient` (no UI)
- **AND** Bob follows Alice via `apiClient.follow(bobToken, aliceId)`
- **AND** logs Bob in via the SPA's login form and lands on `/home`
- **AND** navigates Bob to `/users/{aliceId}`
- **AND** the rendered page contains follower / following counts reflecting the seeded relationship
- **AND** the rendered page contains a button reflecting the followed state
- **AND** runs `runAxeScan` on `/users/{aliceId}` and observes no violations.
