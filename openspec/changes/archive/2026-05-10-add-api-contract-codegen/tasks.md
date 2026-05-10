## 1. Backend dependencies and version catalog

- [x] 1.1 Add `springdoc-openapi-starter-webmvc-ui` version and library coordinates to `backend/gradle/libs.versions.toml`.
- [x] 1.2 Add the `org.springdoc.openapi-gradle-plugin` plugin coordinates to `backend/gradle/libs.versions.toml`.
- [x] 1.3 Add `org.springframework.security:spring-security-crypto` (only the crypto module — not full Spring Security) to the version catalog.
- [x] 1.4 Wire all three new entries into `backend/build.gradle.kts` via the `libs` accessors; ensure no inline coordinates are introduced.

## 2. Backend headless OpenAPI generation

- [x] 2.1 Configure `org.springdoc.openapi-gradle-plugin` in `backend/build.gradle.kts` so that `./gradlew generateOpenApiDocs` writes the spec to `<repo-root>/openapi/openapi.json` (configure `outputDir` and `outputFileName` accordingly).
- [x] 2.2 Verify `./gradlew generateOpenApiDocs` runs cleanly with no backend already running and produces a non-empty `openapi/openapi.json`.
- [x] 2.3 Confirm `GET /v3/api-docs` and `GET /swagger-ui.html` are reachable when the backend is running.

## 3. Backend ProblemDetail error envelope

- [x] 3.1 Add a global `@RestControllerAdvice` (e.g., `web/error/GlobalExceptionHandler.java`) extending `ResponseEntityExceptionHandler`, mapping validation failures to 400 ProblemDetail with field-level extensions, generic `ResponseStatusException` to its declared status, and unhandled `Throwable` to 500 ProblemDetail without exposing stack traces.
- [x] 3.2 Add a domain exception type for conflict cases (e.g., `EmailAlreadyRegisteredException`) and map it to 409 ProblemDetail in the advice.
- [x] 3.3 Configure springdoc to advertise `application/problem+json` with the `ProblemDetail` schema for 4xx/5xx responses on every operation (global response config in the advice or via `@ApiResponse` defaults).

## 4. Backend `/api/v1` prefix

- [x] 4.1 Decide and apply the `/api/v1` prefix mechanism (either `spring.mvc.servlet.path=/api/v1` in `application.yaml` with Actuator and springdoc reconfigured to remain unprefixed, or per-controller `@RequestMapping("/api/v1/...")`); document the choice inline.
- [x] 4.2 Verify Actuator (`/actuator/health`) and springdoc (`/v3/api-docs`, `/swagger-ui.html`) remain reachable at their unversioned paths.

## 5. Backend `users` domain (persistence)

- [x] 5.1 Add Flyway migration `backend/src/main/resources/db/migration/V1__create_users.sql` creating `users(id UUID PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
- [x] 5.2 Add a `User` JPA entity in a `useraccounts/` package (or chosen equivalent) mapping the `users` table; do NOT expose `password_hash` via accessors that could leak it into logs or responses.
- [x] 5.3 Add a `UserRepository extends JpaRepository<User, UUID>` with an `existsByEmail(String)` finder and a `findByEmail(String)` finder.

## 6. Backend signup endpoint

- [x] 6.1 Add a `SignupRequest` DTO record with `@Email`/`@NotBlank` on `email`, `@NotBlank` and `@Size(min=8)` on `password`, `@NotBlank` and `@Size(max=80)` on `displayName`.
- [x] 6.2 Add a `UserResponse` DTO record exposing only `id`, `email`, `displayName`, `createdAt`.
- [x] 6.3 Add a `BCryptPasswordEncoder` `@Bean` (single shared instance) and a `SignupService` that hashes the password, persists the user via `UserRepository`, and returns the persisted user mapped to `UserResponse`.
- [x] 6.4 Make `SignupService` throw `EmailAlreadyRegisteredException` when `existsByEmail` returns true, before attempting the insert.
- [x] 6.5 Add `AuthController` with `@PostMapping("/auth/signup")` (or full path, matching the prefix mechanism chosen in 4.1), returning `201 Created` with `UserResponse`.
- [x] 6.6 Annotate the controller method with `@Operation` summary and explicit `@ApiResponses` for 201, 400, 409 — each declaring the correct schema (`UserResponse` for 201, `ProblemDetail` for the rest).

## 7. Backend tests

- [x] 7.1 Add a `@SpringBootTest` integration test for the signup happy path: posts a valid body, asserts 201, asserts the response shape contains exactly `id`, `email`, `displayName`, `createdAt`, and asserts a row exists in `users` whose `password_hash` is bcrypt-shaped and not the plaintext.
- [x] 7.2 Add an integration test for validation failure: posts a body with bad email and short password, asserts 400 with `application/problem+json`, asserts the body lists both `email` and `password` as failing fields.
- [x] 7.3 Add an integration test for duplicate-email: posts the same valid body twice, asserts 201 then 409 with `application/problem+json`.
- [x] 7.4 Add a test (or assertion) that the response schema in `openapi.json` contains no `password` or `passwordHash`/`password_hash` properties on any operation.

## 8. Snapshot the OpenAPI spec

- [x] 8.1 Run `./gradlew generateOpenApiDocs` to produce `openapi/openapi.json`.
- [x] 8.2 Add `openapi/README.md` documenting: what the file is, how to regenerate it (`./gradlew generateOpenApiDocs`), and the CI drift-check policy.
- [x] 8.3 Confirm `openapi/openapi.json` is NOT in any `.gitignore` and is staged for commit.

## 9. Frontend dependencies

- [x] 9.1 Add `@tanstack/react-query`, `react-hook-form`, `zod`, `@hookform/resolvers` to `frontend/package.json` runtime dependencies.
- [x] 9.2 Add `orval`, `msw` to `frontend/package.json` dev dependencies.
- [x] 9.3 Run `pnpm install` in `frontend/` and confirm a clean install.

## 10. Frontend API client and providers

- [x] 10.1 Add `frontend/src/api/client.ts` exporting an Orval custom mutator function: reads `import.meta.env.VITE_API_BASE_URL` (default `/api/v1`), performs `fetch`, and on non-2xx parses the JSON `ProblemDetail` body and throws a typed `ApiError`.
- [x] 10.2 Define `ApiError` in the same module (or a sibling) as a class extending `Error` with fields `status`, `title`, `detail`, `type`, `instance`, plus a `extensions: Record<string, unknown>` for unknown fields.
- [x] 10.3 Add `frontend/src/api/query-provider.tsx` exporting a `QueryClient` instance and a `<QueryProvider>` component wrapping `<QueryClientProvider>`.
- [x] 10.4 Wrap the root render in `frontend/src/main.tsx` with `<QueryProvider>`.

## 11. Frontend Orval configuration

- [x] 11.1 Add `frontend/orval.config.ts` declaring three targets, all reading `../openapi/openapi.json`: a `tanstack-query` target writing to `frontend/src/api/generated/queries/`, a `zod` target writing to `frontend/src/api/generated/schemas/`, and an `msw` target writing to `frontend/src/api/generated/msw/`.
- [x] 11.2 Configure each target that emits request functions to use `frontend/src/api/client.ts` as the mutator.
- [x] 11.3 Add `frontend/src/api/generated/` to `frontend/.gitignore` (or repo-root `.gitignore`).
- [x] 11.4 Add a `gen:api` script to `frontend/package.json` that runs `orval`.
- [x] 11.5 Add a `postinstall` script to `frontend/package.json` that runs `pnpm gen:api` (so a fresh `pnpm install` produces the generated tree).
- [x] 11.6 Run `pnpm gen:api` and confirm the three target directories populate without errors.

## 12. Frontend Vite dev proxy

- [x] 12.1 Update `frontend/vite.config.ts` so `server.proxy` forwards `/api/v1` (and sub-paths) to `http://localhost:8080` with `changeOrigin: true`.

## 13. Frontend MSW test wiring

- [x] 13.1 Create `frontend/src/test/msw-server.ts` that imports the generated MSW handlers and creates a Node MSW server.
- [x] 13.2 Update `frontend/src/test-setup.ts` to start the MSW server in `beforeAll`, reset handlers in `afterEach`, and stop the server in `afterAll`.
- [x] 13.3 Confirm the existing `App.test.tsx` still passes against the wired MSW server.

## 14. Frontend signup feature

- [x] 14.1 Add `frontend/src/features/signup/SignupForm.tsx`: a controlled form (email, password, displayName) using `react-hook-form` with the Orval-generated Zod schema as resolver, and the Orval-generated signup mutation hook for submission.
- [x] 14.2 On mutation success, render a success state (e.g., "Account created"). On mutation error (when error is `ApiError`), render the `ProblemDetail.detail` message inline.
- [x] 14.3 Mount `<SignupForm>` from `App.tsx` (replace or augment the scaffold landing UI as a temporary host for the form).

## 15. Frontend signup tests

- [x] 15.1 Add `frontend/src/features/signup/SignupForm.test.tsx`: render the form within `<QueryProvider>`, fill valid fields, submit, override the MSW handler to respond 201 with a sample user payload, assert the success state renders.
- [x] 15.2 Add a test in the same file: fill valid fields, submit, override the MSW handler to respond 409 with a `ProblemDetail` body, assert the `detail` message is rendered.
- [x] 15.3 Add a test that types invalid input (malformed email, short password) and asserts the form shows inline Zod errors and does NOT issue a network request.

## 16. CI drift check

- [x] 16.1 Add a CI job (or step in the existing CI workflow) that, on every push and PR: runs `./gradlew generateOpenApiDocs`, then runs `git diff --exit-code openapi/openapi.json`, failing with a clear message instructing the developer to regenerate and commit.
- [x] 16.2 Add a CI step that runs `pnpm install` (which triggers `gen:api`) followed by `pnpm test` and `pnpm build` to ensure the generated TypeScript typechecks against the committed snapshot.

## 17. Documentation touch-ups

- [x] 17.1 Update `backend/README.md` with a one-liner for `./gradlew generateOpenApiDocs` and a link to `openapi/README.md`.
- [x] 17.2 Update `frontend/README.md` documenting `pnpm gen:api`, the `postinstall` behavior, and the Vite proxy assumption that the backend runs on `:8080`.

## 18. Final validation

- [x] 18.1 Run `openspec validate add-api-contract-codegen --strict` and confirm clean output.
- [x] 18.2 From a clean working tree, run the full local sequence: `./gradlew generateOpenApiDocs && git diff --exit-code openapi/openapi.json && cd frontend && pnpm install && pnpm test && pnpm build`. All steps pass.
- [x] 18.3 Confirm the open questions captured in `design.md` are resolved (generated TS gitignored ✓, MSW wiring documented ✓, signup response shape locked ✓) or explicitly carried forward as a follow-up note.
