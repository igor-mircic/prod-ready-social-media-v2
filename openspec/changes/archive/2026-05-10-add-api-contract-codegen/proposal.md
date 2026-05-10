## Why

The backend and frontend scaffolds are complete, but no API contract approach is in place. Every feature from this point forward — starting with signup — needs typed DTOs on the server, typed clients on the browser, a consistent error envelope, and a way to test the frontend without a running backend. Choosing the contract pipeline once, before endpoints proliferate, prevents drift between Java and TypeScript, eliminates hand-written fetch code, and makes the inner-loop fast enough that "add a field" stays a one-minute change rather than a multi-step chore.

## What Changes

- Adopt **springdoc-openapi** on the backend to expose `/v3/api-docs` from controller annotations, plus the **springdoc-openapi Gradle plugin** so the OpenAPI spec can be generated headlessly (without running a server) as part of the build.
- Standardize all error responses on **RFC 7807 `ProblemDetail`** via a global `@RestControllerAdvice`, so every generated TypeScript error type is uniform.
- Commit a generated `openapi.json` snapshot into the repo, with a CI **drift check** that regenerates the spec on a fresh checkout and fails the build if the committed file is out of date.
- Adopt **Orval** on the frontend with three targets: typed **TanStack Query** hooks, **Zod** schemas (for form validation), and **MSW** handlers (for tests and offline development).
- Add a frontend **custom client / mutator** that injects the API base URL per environment, parses non-2xx responses as `ProblemDetail`, and throws a typed error class consumed by TanStack Query's `onError`.
- Add a **`pnpm gen:api`** script that orchestrates the full regenerate cycle locally.
- Adopt a **`/api/v1/...`** versioning prefix for all HTTP routes from day one.
- **First demonstration slice**: `POST /api/v1/auth/signup` — accepts an email/password/displayName, persists a `User` row, returns the created user. **Tight scope: no session, no token, no login**; authentication strategy is deferred to a future change.
- Frontend ships a signup form that consumes the generated TanStack Query hook and Zod schema, with a vitest test driven by the generated MSW handler.

## Capabilities

### New Capabilities

- `api-contract`: Owns the HTTP API contract pipeline — the OpenAPI spec as source of truth, the codegen flow, the standardized error envelope, the route-versioning convention, and the frontend integration of generated hooks/schemas/mocks. Future features consume this capability rather than redefining contract mechanics.
- `user-accounts`: Owns the user-record domain — for now, only account creation via the signup endpoint, including validation rules (email format, password minimum length) and the uniqueness constraint on email. Future requirements (profile reads, deletion, etc.) extend this capability.

### Modified Capabilities

None. Existing specs (`monorepo-layout`, `project-context`, `backend-scaffold`, `frontend-scaffold`) describe structure rather than runtime behavior and are not affected by this change.

## Impact

- **Backend dependencies**: adds `springdoc-openapi-starter-webmvc-ui` (runtime) and the `org.springdoc.openapi-gradle-plugin` (build-time) to `backend/build.gradle.kts` and the version catalog. No changes to existing dependencies.
- **Frontend dependencies**: adds `@tanstack/react-query`, `react-hook-form`, `zod`, `@hookform/resolvers`, `orval` (devDep), and `msw` (devDep) to `frontend/package.json`.
- **Build pipeline**: introduces a `./gradlew generateOpenApiDocs` task that writes the spec to a known location, and a frontend `pnpm gen:api` script that runs Orval against it. CI gains a job that runs the full regenerate-and-diff cycle to enforce the drift check.
- **Repository**: adds a committed `openapi.json` artifact at a path defined in the design.
- **Source code**: introduces the first `@RestController`, the first request/response DTOs, the global `@RestControllerAdvice`, the first Flyway migration (for the `users` table), the frontend API client/provider scaffolding, and the signup feature module.
- **Future work unblocked**: every subsequent endpoint (login, posts, feed, follows) consumes this contract pipeline rather than defining its own.
