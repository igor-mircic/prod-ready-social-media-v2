## ADDED Requirements

### Requirement: A `users` table is created by Flyway migration

The `backend/` project SHALL include a Flyway migration `V1__create_users.sql` that creates a `users` table with columns sufficient to represent a registered account: a primary key, a unique email, a hashed password, a display name, and a creation timestamp.

#### Scenario: Migration creates the table

- **WHEN** Flyway runs the migrations against an empty database
- **THEN** a `users` table exists
- **AND** has a primary key column `id` of type `UUID` (or equivalent)
- **AND** has a `email` column of type `TEXT` (or `VARCHAR(...)`) marked `NOT NULL` with a `UNIQUE` constraint
- **AND** has a `password_hash` column of type `TEXT` (or `VARCHAR(...)`) marked `NOT NULL`
- **AND** has a `display_name` column marked `NOT NULL`
- **AND** has a `created_at` column of type `TIMESTAMPTZ NOT NULL` with a default of `now()`.

#### Scenario: Email uniqueness is enforced at the database level

- **WHEN** an `INSERT` attempts to add a row whose email already exists
- **THEN** the database raises a unique-constraint violation.

### Requirement: Signup endpoint creates a new user account

The backend SHALL expose `POST /api/v1/auth/signup` accepting a JSON body of `email`, `password`, and `displayName`. On success, the endpoint SHALL persist a new `users` row with the password hashed and SHALL return `201 Created` with a JSON body containing the new account's `id`, `email`, `displayName`, and `createdAt`.

#### Scenario: Successful signup persists the user and returns the account

- **WHEN** a client posts a valid signup request to `POST /api/v1/auth/signup`
- **THEN** the response status is 201
- **AND** the response body contains exactly the fields `id`, `email`, `displayName`, `createdAt`
- **AND** the response body does NOT contain `password`, `password_hash`, or any field derived from the password
- **AND** a new row exists in `users` whose email matches the request and whose `password_hash` is not the plaintext password.

#### Scenario: Signup is publicly reachable

- **WHEN** a client posts to `POST /api/v1/auth/signup` without any credentials
- **THEN** the request is accepted and processed (no authentication is required for signup).

### Requirement: Signup validates input fields

The signup endpoint SHALL validate request bodies using `jakarta.validation` annotations on the request DTO and SHALL reject invalid bodies with a 400 `ProblemDetail` whose extensions enumerate the failing fields.

#### Scenario: Missing or malformed email is rejected

- **WHEN** a client posts a signup request whose `email` is missing, empty, or not a valid email format
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `email` among the failing fields.

#### Scenario: Password shorter than 8 characters is rejected

- **WHEN** a client posts a signup request whose `password` is fewer than 8 characters (or missing/empty)
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `password` among the failing fields.

#### Scenario: Display name longer than 80 characters or empty is rejected

- **WHEN** a client posts a signup request whose `displayName` is empty or longer than 80 characters
- **THEN** the response status is 400
- **AND** the response body is a `ProblemDetail` listing `displayName` among the failing fields.

### Requirement: Signup rejects duplicate emails with a typed conflict response

The signup endpoint SHALL reject requests whose email is already registered with a 409 `ProblemDetail`.

#### Scenario: Duplicate email returns 409

- **WHEN** a client posts a signup request whose `email` already exists in `users`
- **THEN** the response status is 409
- **AND** the response body is a `ProblemDetail` with `status` 409 and a `detail` describing the conflict
- **AND** no new row is inserted into `users`.

### Requirement: Passwords are hashed with bcrypt and never persisted or returned in plaintext

The backend SHALL hash signup passwords using `BCryptPasswordEncoder` from `spring-security-crypto` before persisting, SHALL store only the hash in the `password_hash` column, and SHALL never include the password or its hash in any HTTP response or log line.

#### Scenario: Password is hashed before insert

- **WHEN** the signup endpoint persists a new user
- **THEN** the value written to `password_hash` is a bcrypt hash (begins with `$2a$`, `$2b$`, or `$2y$`)
- **AND** the value is not equal to the plaintext password.

#### Scenario: Password and hash are absent from responses

- **WHEN** a reader inspects the signup endpoint's response schema in `openapi/openapi.json`
- **THEN** the schema does not contain a `password` or `passwordHash` (or `password_hash`) property.

#### Scenario: Password is not logged

- **WHEN** the signup flow runs at any log level
- **THEN** no log line includes the plaintext password or its hash.

### Requirement: Frontend ships a signup form using the generated hook and Zod schema

The `frontend/` project SHALL include a signup feature module under `frontend/src/features/signup/` that renders a form, validates input client-side using the Orval-generated Zod schema for the signup request, and submits via the Orval-generated TanStack Query mutation.

#### Scenario: Form fields are validated client-side using the generated Zod schema

- **WHEN** a user types invalid input (e.g., a malformed email, a short password) and tabs out of the field
- **THEN** the form displays an inline error sourced from the generated Zod schema
- **AND** the submit button does not fire a network request while the form is invalid.

#### Scenario: Successful submission calls the generated mutation hook

- **WHEN** a user fills in valid email, password, and display name
- **AND** clicks Submit
- **THEN** the form invokes the Orval-generated signup mutation hook
- **AND** displays a success state when the mutation resolves with a 201.

#### Scenario: Server-side errors surface via the typed ApiError

- **WHEN** the signup mutation rejects with an `ApiError` (e.g., 409 duplicate email)
- **THEN** the form renders the `ProblemDetail`'s `detail` field as the error message
- **AND** does not crash the React tree.

### Requirement: Vitest test exercises the signup form via generated MSW handlers

The `frontend/` project SHALL include a vitest test for the signup form that overrides the generated MSW handler for `POST /api/v1/auth/signup` to simulate both a successful response and a 409 conflict, asserting the form renders each outcome correctly.

#### Scenario: Successful signup path

- **WHEN** the test mounts the signup form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 201 and a user payload
- **THEN** the test asserts the success state is rendered.

#### Scenario: Duplicate-email path

- **WHEN** the test mounts the signup form
- **AND** fills valid fields and submits
- **AND** the MSW handler responds with 409 and a `ProblemDetail` body
- **THEN** the test asserts the error message from the `ProblemDetail`'s `detail` is rendered.
