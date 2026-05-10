## Context

The repository has a working Spring Boot backend scaffold and a Vite/React frontend scaffold, but no HTTP API surface, no shared contract, and no integration between the two. This change establishes the contract pipeline — how a Java DTO becomes a TypeScript hook — and exercises it end-to-end with a single demonstration endpoint (signup).

Constraints in play:

- The user has prior preferences captured in memory: AI-workflow iteration speed is a first-class concern; official scaffolders/tools are preferred over hand-rolled equivalents.
- The repository already commits to Java 21, Gradle Kotlin DSL with a version catalog, Spring Boot Web MVC, JPA + Flyway + Postgres, pnpm, React 19, Vite 8, vitest.
- `backend/` and `frontend/` are independent build trees; cross-cutting tooling lives at the repo root.
- Coding conventions for this project are still TBD; this change adopts only the conventions strictly required to ship the contract pipeline (e.g., RFC 7807 error envelope, `/api/v1` prefix) and defers the rest.

## Goals / Non-Goals

**Goals:**

- Choose a single, durable approach for the HTTP contract between Spring and React, before endpoint count grows past one.
- Make the inner loop of "add or change a field" fast: regenerate types in seconds, no manual TypeScript edits, no manual fetch wrappers.
- Standardize the error envelope so every generated TypeScript error type is identical in shape.
- Make frontend tests and frontend-only development possible without a running backend.
- Prove the pipeline end-to-end with one feature (signup) to surface integration gaps early.

**Non-Goals:**

- Authentication strategy (sessions vs JWT, login, logout, token refresh, password reset). Signup persists a `User` and returns the user shape; no credential is issued. Auth is a separate future change.
- Authorization, roles, multi-tenancy.
- Rate limiting, CAPTCHA, or abuse protection on the signup endpoint.
- Email verification flows, transactional email infrastructure.
- Production CORS configuration; this change relies on a Vite dev proxy locally and leaves prod CORS to deployment configuration.
- E2E tests against a real running backend (Playwright wiring is a future change).
- Contract testing tools (Pact, Spring Cloud Contract); not justified for a 1-BE / 1-FE setup.
- Real-time transports (SSE, WebSocket); these do not fit OpenAPI naturally and are deferred until a feature requires them.
- API governance tooling beyond the drift check (e.g., breaking-change detection between spec versions).

## Decisions

### D1. Code-first contract via springdoc-openapi

**Decision:** The backend is the source of truth. Controllers, DTOs, and `jakarta.validation` annotations drive the OpenAPI spec via `springdoc-openapi`. The generated `openapi.json` is what the frontend consumes.

**Alternatives considered:**

- *Schema-first* (`openapi.yaml` is the truth, both sides generate from it): cleaner contract discipline, supports parallel FE/BE work, enables Prism mocks. Rejected because it adds upfront friction for a 1-BE/1-FE app where most contract changes will originate on the backend, and because hand-writing OpenAPI YAML is a skill investment not yet justified by the team shape.
- *GraphQL* (Spring for GraphQL + codegen): handles real-time via subscriptions, single-endpoint discipline. Rejected because it commits to a different client model on day one; we don't need subscriptions yet and can revisit if real-time becomes central.

### D2. Headless spec generation via the springdoc Gradle plugin

**Decision:** Use `org.springdoc.openapi-gradle-plugin` to produce the OpenAPI spec without a manually started server. The plugin boots the Spring application context in-process, reads `/v3/api-docs`, writes the file, and exits. The output path is configured to land in the repo's committed location (see D4).

**Alternatives considered:**

- *Require a running server and curl `/v3/api-docs`*: simpler config but creates a "you must have port 8080 free" failure mode in CI and locally. Rejected.

### D3. Orval as the frontend codegen, with three targets

**Decision:** Use Orval to generate, from a single `orval.config.ts`:

- A `tanstack-query` target → typed `useQuery`/`useMutation` hooks.
- A `zod` target → schemas matching request/response DTOs, used by `react-hook-form` via `@hookform/resolvers/zod`.
- A `msw` target → request handlers used by vitest tests and (optionally) by the dev server when the backend is not running.

**Alternatives considered:**

- *`@hey-api/openapi-ts`*: cleaner, more modern code; plugin architecture; smaller output. Rejected primarily because it does not generate MSW handlers — and MSW handler generation is the single largest DX win Orval offers for "frontend without backend" workflows.
- *Plain `openapi-generator-cli` (typescript-fetch / typescript-axios)*: produces a typed client but no React Query integration, no Zod, no MSW. Rejected; would re-add hand-written hooks.

### D4. Commit `openapi.json` at the repository root, with a CI drift check

**Decision:** The generated spec is committed to `openapi/openapi.json`. CI runs `./gradlew generateOpenApiDocs` on a fresh checkout and fails if `git diff --exit-code openapi/openapi.json` is non-zero. The frontend's Orval config reads from `../openapi/openapi.json`.

**Alternatives considered:**

- *Do not commit; CI generates fresh every build*: keeps git clean but hides API surface changes from PR diffs and forces every frontend developer to run codegen on every `git pull`. Rejected on review-quality and FE-developer friction grounds.
- *Commit at `frontend/openapi.json`*: implies the frontend owns the artifact. Rejected because it is produced by the backend; root placement reflects that the contract is shared.

**Rationale for placement at repo root:** the file is consumed by the frontend but produced by the backend; placing it in either subtree implies ownership the file does not have. A top-level `openapi/` directory is a neutral home and leaves room for a future `openapi/README.md` documenting the regen flow.

### D5. RFC 7807 `ProblemDetail` for all error responses

**Decision:** A single `@RestControllerAdvice` extends `ResponseEntityExceptionHandler` and converts every thrown exception (validation failures, domain exceptions, unexpected errors) into a `ProblemDetail` response. Every `@RestController` declares its error responses in OpenAPI metadata as `ProblemDetail`. This guarantees the generated TypeScript error type is the same shape across every hook.

**Alternatives considered:**

- *Custom error envelope (e.g., `{ code, message, fields }`)*: more bespoke, more work, no benefit over RFC 7807. Rejected.
- *Per-endpoint ad-hoc error shapes*: would force each TS hook's error type to be `unknown`, defeating most of the contract win. Rejected.

### D6. `/api/v1/` prefix on all HTTP routes from day one

**Decision:** All endpoints introduced by this and future changes live under `/api/v1/...`. The signup endpoint is `POST /api/v1/auth/signup`.

**Rationale:** introducing a version prefix on day one is trivial; retrofitting one when a breaking change forces it is painful (every controller, every test, every TS call site, every existing client). Cost-benefit is asymmetric in favor of prefixing now.

**Note on the `/auth/` segment:** the URL groups by user-facing concern (a user "signs up" via "auth"). The owning capability in OpenSpec terms is `user-accounts`, not auth. URL grouping and capability naming are independent.

### D7. Custom Orval mutator for the frontend client

**Decision:** Configure Orval to use a custom mutator at `frontend/src/api/client.ts`. The mutator:

- Reads the API base URL from a Vite env variable (`VITE_API_BASE_URL`), defaulting to `/api/v1` (which the Vite dev proxy forwards to the backend).
- Issues requests via the platform `fetch`.
- On non-2xx responses, parses the body as `ProblemDetail` and throws a typed `ApiError` (a small class wrapping the parsed `ProblemDetail`).
- Lets TanStack Query's `onError` paths receive a typed error.

**Alternatives considered:**

- *axios-based mutator*: extra dependency for no current benefit; `fetch` is sufficient. Rejected.

### D8. Password hashing via `spring-security-crypto` only

**Decision:** Add `org.springframework.security:spring-security-crypto` (the crypto module — not the full Spring Security framework) to hash the signup password using `BCryptPasswordEncoder` before persisting. The full Spring Security stack (filters, authentication providers) is not introduced.

**Rationale:** signup must store a password hash, not the password — this is non-negotiable. But pulling in the entire Spring Security framework just to hash a string introduces filter chains, auto-config, and a CSRF/login flow we do not want yet. The crypto module is a standalone library that gives us `BCryptPasswordEncoder` without any of that.

**Alternatives considered:**

- *Full `spring-boot-starter-security`*: brings filter chains and security autoconfig that conflicts with the "no auth in this change" scope. Rejected; revisit when auth lands.
- *Hand-rolled Argon2/bcrypt via a third-party lib*: more dependency surface, less idiomatic for Spring. Rejected.

### D9. Vite dev proxy for local development

**Decision:** Configure Vite's `server.proxy` to forward `/api/v1` to `http://localhost:8080`. The frontend talks to `/api/v1/...` in all environments; only the proxy/CDN configuration changes per environment.

**Rationale:** eliminates CORS during local development without committing to a CORS posture for production yet.

## Risks / Trade-offs

- **springdoc context boot adds seconds to the codegen step** → Mitigation: only run codegen when the API surface changes; the drift check in CI catches forgetting.
- **OpenAPI quality depends on annotations and Spring MVC introspection** → Mitigation: rely on default introspection and `jakarta.validation` annotations; only add `@Schema`/`@Operation` where defaults are insufficient. Don't over-annotate.
- **Orval is opinionated; non-standard patterns require fighting it** → Mitigation: accept Orval's defaults for now. If we hit a real wall, hey-api is a viable swap and the spec/contract layer survives.
- **Committed `openapi.json` adds a manual regen step to PRs touching the API** → Mitigation: drift check fails CI loudly with a clear message; documented in `openapi/README.md`.
- **Generated code in `frontend/src/api/generated/` clutters the source tree** → Mitigation: keep the generated directory under a clear gitignore / lint-ignore boundary (decision deferred to specs/tasks: commit generated TS or regenerate on every install). Recommended path: regenerate on `pnpm install` via a `postinstall` script and gitignore the directory; the `openapi.json` snapshot is already the durable artifact.
- **Vitest tests using MSW handlers don't catch runtime drift between the spec and the actual server** → Mitigation: accepted for now; e2e against a real server is a future change.
- **`spring-security-crypto` without the rest of Spring Security may need rework when auth lands** → Mitigation: minor; the encoder API is identical when Spring Security is later added in full.

## Migration Plan

This change is additive on a greenfield codebase: no existing endpoints to migrate, no existing data to backfill. Deploy strategy is implicit — when the change lands, the backend exposes one new endpoint and the frontend renders one new form. Rollback is `git revert`.

The single migration concern is the `users` table itself (Flyway migration `V1__create_users.sql`). The migration is idempotent at the schema level (Flyway tracks it) and there is no prior `users` schema to reconcile with.

## Open Questions

- **Should generated TypeScript (`frontend/src/api/generated/`) be committed or generated on `pnpm install`?** Recommended: gitignore + `postinstall` script. To be locked in `tasks.md` or, if it has spec implications, in `specs/api-contract/spec.md`.
- **Where do generated MSW handlers live and how are they wired into vitest?** Likely `frontend/src/test/msw-server.ts` setting up a node server that imports the generated handlers; finalize during implementation.
- **Should the signup response include the user's `id` and `createdAt` only, or also `email` and `displayName`?** Lean toward returning the full user shape minus the password hash; finalize in `specs/user-accounts/spec.md`.
