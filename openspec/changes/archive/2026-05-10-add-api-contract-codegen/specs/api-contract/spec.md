## ADDED Requirements

### Requirement: OpenAPI specification is generated from the backend by springdoc

The `backend/` project SHALL apply the springdoc-openapi starter and Gradle plugin so that the OpenAPI 3.x specification is derived from controller annotations and `jakarta.validation` annotations, and SHALL produce the specification headlessly without requiring a manually started server.

#### Scenario: Springdoc starter is on the runtime classpath

- **WHEN** a reader inspects `backend/build.gradle.kts`
- **THEN** the project depends on `springdoc-openapi-starter-webmvc-ui` (version pinned in `gradle/libs.versions.toml`).

#### Scenario: Spec is exposed by the running application

- **WHEN** the backend is running and a developer hits `GET /v3/api-docs`
- **THEN** the response is a JSON OpenAPI 3.x document covering every `/api/v1/...` endpoint
- **AND** `GET /swagger-ui.html` serves the Swagger UI for that document.

#### Scenario: Headless generation produces a spec file

- **WHEN** a developer runs `./gradlew generateOpenApiDocs` with no backend running
- **THEN** the springdoc Gradle plugin boots the Spring context in-process
- **AND** writes the OpenAPI JSON to `openapi/openapi.json` at the repository root
- **AND** exits without leaving a server running.

### Requirement: Committed OpenAPI snapshot is verified by CI drift check

The repository SHALL commit `openapi/openapi.json` as the canonical contract artifact, and CI SHALL fail when the committed snapshot is out of sync with the backend's generated specification.

#### Scenario: Snapshot is committed at the repository root

- **WHEN** a reader inspects the repository
- **THEN** `openapi/openapi.json` exists and is tracked by git
- **AND** is not listed in any `.gitignore`.

#### Scenario: CI fails on drift

- **WHEN** a developer modifies a controller without regenerating the snapshot, and pushes
- **THEN** CI runs `./gradlew generateOpenApiDocs`
- **AND** runs `git diff --exit-code openapi/openapi.json`
- **AND** the diff is non-zero
- **AND** CI fails the build with a message instructing the developer to run `./gradlew generateOpenApiDocs` and commit the result.

#### Scenario: CI passes on no drift

- **WHEN** the committed `openapi/openapi.json` matches what the backend generates
- **THEN** the drift check produces no diff
- **AND** the CI step passes.

### Requirement: All HTTP routes use the `/api/v1/` prefix

All HTTP endpoints introduced by feature controllers SHALL be served under the `/api/v1/` prefix. The Actuator surface (`/actuator/*`), the OpenAPI surface (`/v3/api-docs`, `/swagger-ui*`), and any future static-asset routes are explicitly exempt.

#### Scenario: Feature endpoints are versioned

- **WHEN** a reader inspects every `@RequestMapping`/`@GetMapping`/`@PostMapping` declared on a feature controller
- **THEN** every path begins with `/api/v1/`.

#### Scenario: Infrastructure endpoints are not versioned

- **WHEN** a developer hits `GET /actuator/health` or `GET /v3/api-docs`
- **THEN** the endpoint responds at the unversioned path
- **AND** is not duplicated under `/api/v1/`.

### Requirement: All error responses use RFC 7807 ProblemDetail

The backend SHALL respond to every error condition with an `application/problem+json` body whose shape is RFC 7807 `ProblemDetail`. A single `@RestControllerAdvice` SHALL convert every exception (validation failure, domain exception, unhandled exception) into a `ProblemDetail` response.

#### Scenario: Validation failures produce ProblemDetail

- **WHEN** a client posts a request with body fields that fail `jakarta.validation` constraints
- **THEN** the response status is 400
- **AND** the response `Content-Type` is `application/problem+json`
- **AND** the body is a `ProblemDetail` whose `status` is 400 and whose extensions enumerate the failing fields.

#### Scenario: Domain conflicts produce ProblemDetail

- **WHEN** a domain exception representing a conflict is thrown by a controller
- **THEN** the response status is 409
- **AND** the body is a `ProblemDetail` with `status` 409 and a human-readable `detail`.

#### Scenario: Unhandled exceptions produce ProblemDetail

- **WHEN** an unexpected exception escapes a controller
- **THEN** the response status is 500
- **AND** the body is a `ProblemDetail` with `status` 500
- **AND** no internal stack trace is exposed in the body.

#### Scenario: OpenAPI declares ProblemDetail as the error response

- **WHEN** a reader inspects the generated `openapi/openapi.json`
- **THEN** every operation declares `application/problem+json` with the `ProblemDetail` schema for its 4xx and 5xx responses.

### Requirement: Frontend generates a typed API layer from the OpenAPI snapshot via Orval

The `frontend/` project SHALL configure Orval to read `../openapi/openapi.json` and produce three sets of artifacts: TanStack Query hooks, Zod schemas, and MSW request handlers. Generated TypeScript SHALL be placed under `frontend/src/api/generated/` and SHALL NOT be committed to git.

#### Scenario: Orval config declares three targets

- **WHEN** a reader inspects `frontend/orval.config.ts`
- **THEN** the config declares a target producing TanStack Query hooks
- **AND** declares a target producing Zod schemas
- **AND** declares a target producing MSW handlers
- **AND** all three targets read `../openapi/openapi.json`.

#### Scenario: Generated output is gitignored

- **WHEN** a reader inspects `frontend/.gitignore` (or a parent `.gitignore`)
- **THEN** `frontend/src/api/generated/` is ignored.

#### Scenario: Codegen runs on install and on demand

- **WHEN** a developer runs `pnpm install` in `frontend/`
- **THEN** a `postinstall` script regenerates `frontend/src/api/generated/`.
- **AND WHEN** a developer runs `pnpm gen:api` in `frontend/`
- **THEN** Orval regenerates the same artifacts against the current `openapi/openapi.json`.

### Requirement: Frontend uses a custom Orval mutator that emits typed errors

The `frontend/` project SHALL configure Orval to use a custom mutator at `frontend/src/api/client.ts`. The mutator SHALL read the API base URL from a Vite environment variable, perform requests via the platform `fetch`, and parse non-2xx responses as `ProblemDetail` and throw a typed `ApiError`.

#### Scenario: Mutator is configured

- **WHEN** a reader inspects `frontend/orval.config.ts`
- **THEN** every target that produces request functions references `frontend/src/api/client.ts` as the mutator.

#### Scenario: Base URL comes from env

- **WHEN** the application starts
- **THEN** the mutator reads `import.meta.env.VITE_API_BASE_URL`
- **AND** falls back to `/api/v1` when the variable is not set.

#### Scenario: Non-2xx responses throw a typed error

- **WHEN** a request receives a 4xx or 5xx response with a `ProblemDetail` body
- **THEN** the mutator throws an `ApiError` instance whose properties (`status`, `title`, `detail`, `type`, `instance`, plus extensions) reflect the parsed body
- **AND** TanStack Query's `onError` callbacks receive the `ApiError` typed.

### Requirement: Frontend wires TanStack Query at the app root

The `frontend/` project SHALL configure a single `QueryClient` and provide it to the React tree via a Provider mounted in `frontend/src/main.tsx`.

#### Scenario: Provider is mounted at the root

- **WHEN** a reader inspects `frontend/src/main.tsx`
- **THEN** the rendered tree is wrapped in `<QueryClientProvider client={queryClient}>`
- **AND** the `queryClient` is exported from `frontend/src/api/query-provider.tsx` (or equivalent module) for reuse in tests.

### Requirement: Vite dev proxy forwards the API prefix to the backend

The `frontend/vite.config.ts` SHALL configure a development proxy that forwards requests under `/api/v1` to `http://localhost:8080`, so the frontend can use relative API URLs in every environment without a CORS configuration on the backend in development.

#### Scenario: Dev proxy is configured

- **WHEN** a reader inspects `frontend/vite.config.ts`
- **THEN** the `server.proxy` map forwards `/api/v1` (and its sub-paths) to `http://localhost:8080`
- **AND** `changeOrigin` is enabled.

#### Scenario: Frontend reaches a running backend through the proxy

- **WHEN** the backend is running on `localhost:8080`
- **AND** the frontend dev server is running on `localhost:5173`
- **AND** a frontend request hits `/api/v1/...`
- **THEN** the request is forwarded to the backend
- **AND** the browser observes no CORS error.

### Requirement: Generated MSW handlers are usable from vitest

The `frontend/` project SHALL include a test-setup module that imports the Orval-generated MSW handlers and configures an MSW server for vitest. Test files SHALL be able to override individual handlers per test without re-importing the full set.

#### Scenario: Vitest setup wires the MSW server

- **WHEN** a reader inspects the vitest configuration
- **THEN** a setup file (e.g., `frontend/src/test-setup.ts`) starts the MSW server before all tests
- **AND** resets handlers between tests
- **AND** stops the server after all tests.

#### Scenario: Per-test handler overrides work

- **WHEN** a test calls `server.use(<override handler>)`
- **THEN** subsequent fetches in that test hit the override
- **AND** the override is reset before the next test runs.
