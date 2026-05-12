## ADDED Requirements

### Requirement: Get-user-by-id endpoint returns a public user summary

The backend SHALL expose `GET /api/v1/users/{userId}` returning a public `UserSummary { id, displayName }` body. The endpoint SHALL require authentication under the existing deny-by-default `SecurityFilterChain` (no new allowlist entry). The response SHALL exclude `email`, `password`, `passwordHash`, and `createdAt`. Unknown ids SHALL return `404 ProblemDetail`. Unauthenticated callers SHALL receive `401 ProblemDetail`.

#### Scenario: Successful fetch returns id and displayName only

- **WHEN** an authenticated client calls `GET /api/v1/users/{userId}` with an existing `userId`
- **THEN** the response status is 200
- **AND** the response body declares exactly the properties `id` (uuid) and `displayName` (string)
- **AND** the response body does NOT declare `email`, `password`, `passwordHash`, or `createdAt`.

#### Scenario: Unknown id returns 404

- **WHEN** an authenticated client calls `GET /api/v1/users/{userId}` with a syntactically-valid `userId` that does not exist in `users`
- **THEN** the response status is 404
- **AND** the response body is a `ProblemDetail` with `status` 404.

#### Scenario: Unauthenticated caller receives 401

- **WHEN** a client calls `GET /api/v1/users/{userId}` without an `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.

#### Scenario: Endpoint is under the existing security chain with no new allowlist entry

- **WHEN** a reader inspects the security configuration class
- **THEN** the allowlist does NOT include any `/api/v1/users/{userId}` or `/api/v1/users/*` entry
- **AND** the endpoint relies on the existing deny-by-default `SecurityFilterChain`.

#### Scenario: Response shape excludes email at the OpenAPI level

- **WHEN** a reader inspects `openapi/openapi.json`
- **THEN** the `UserSummary` schema (or whatever `$ref` the new endpoint's `200` response points at) declares exactly the properties `id` (uuid) and `displayName` (string)
- **AND** the schema does NOT declare `email`, `password`, `passwordHash`, or `createdAt`.

### Requirement: Backend integration tests cover the get-user-by-id endpoint

The `backend/` project SHALL include a Testcontainers integration test (matching the existing `*IT.java` pattern under `backend/src/test/java/com/prodready/social/useraccounts/`) that exercises: the happy path; the 404 for an unknown id; the 401 for an unauthenticated caller; and a body-shape assertion that the 200 response does NOT contain `email`, `password`, `passwordHash`, or `createdAt`.

#### Scenario: Test class exists and is wired to Testcontainers

- **WHEN** a reader inspects `backend/src/test/java/com/prodready/social/useraccounts/`
- **THEN** there is at least one `*IT.java` class that uses Testcontainers Postgres
- **AND** asserts each of the cases listed above.

#### Scenario: 200 body does not leak email or any other private field

- **WHEN** the IT calls `GET /api/v1/users/{userId}` with a valid token for an existing user
- **AND** the response status is 200
- **THEN** the response body JSON contains exactly the keys `id` and `displayName`
- **AND** the response body JSON does NOT contain `email`, `password`, `passwordHash`, or `createdAt`.

### Requirement: OpenAPI snapshot includes the get-user-by-id endpoint

The committed `openapi/openapi.json` snapshot SHALL include the `GET /api/v1/users/{userId}` endpoint with the agreed `UserSummary` response schema and the agreed `ProblemDetail` 401/404 responses, and CI's existing drift check SHALL fail if the snapshot is stale.

#### Scenario: Snapshot lists the new path

- **WHEN** a reader inspects `openapi/openapi.json`
- **THEN** the document declares a `paths` entry for `/api/v1/users/{userId}` with a `get` operation
- **AND** the operation's `200` response references a schema with exactly `id` (uuid) and `displayName` (string)
- **AND** the operation's `401` and `404` responses reference `ProblemDetail`.

#### Scenario: CI fails on snapshot drift

- **WHEN** a developer modifies the new controller without regenerating the snapshot, and pushes
- **THEN** the existing CI drift-check job fails
- **AND** the failure blocks merge.
