## Context

The repo has only OpenSpec scaffolding so far. This change introduces the first executable code and the first opinions about the build chain, format enforcement, and local dev environment. Several decisions made here will be hard to reverse cheaply once feature changes start landing on top — pick mainstream defaults that match enterprise practice, and weight AI-workflow iteration speed as a first-class criterion.

Constraints:
- Stack is fixed by project context: Java/Spring, Postgres, Testcontainers-friendly testing.
- Repo is a flat monorepo (`backend/`, `frontend/`, `e2e/`, `infra/`) per the root README created here.
- No agreed coding conventions yet — this change should not invent style rules. Where a tool needs a config, use its widely-adopted default (e.g., google-java-format).

## Goals / Non-Goals

**Goals:**
- A single `cd backend && ./gradlew test` (with Docker running) builds and runs the smoke test from a clean clone.
- The dependency and tooling baseline covers the obvious near-term needs (web, JPA, validation, actuator, Postgres, Flyway, Testcontainers, Spotless) so the first feature change adds business code, not infrastructure.
- AI-driven inner loop is fast: incremental compile, build cache, configuration cache, format-on-save via direct binary invocation.
- Cloning the repo and running `docker-compose up -d postgres && cd backend && ./gradlew bootRun` works without further setup.

**Non-Goals:**
- Spring Security / authentication — out of scope; needs its own design discussion.
- Lombok — defer; adoption is contentious and conventions are TBD.
- Real domain models, endpoints, or migrations.
- CI pipeline, Dockerfile for deploy, observability stack (logging format, metrics, tracing), pre-commit hooks, static analysis (Error Prone, NullAway, SpotBugs), test layering (separate integrationTest source set), OpenAPI/Swagger setup — all separate changes.
- Multi-module Gradle build — one module is enough until there's a reason to split.
- Frontend, e2e, or infra setup — they have their own scaffold changes.

## Decisions

### Decision 1: Generate the backend skeleton via Spring Initializr (curl), not hand-written files

Use `curl https://start.spring.io/starter.zip` with explicit parameters and unzip into `backend/`. Initializr produces canonical, current-version files: `build.gradle.kts` with the right plugin coordinates, `gradle/wrapper/` with a checksummed wrapper jar, `Application.java`, a basic context-load test, and a project-scoped `.gitignore`. Hand-writing these is faster to type but slower to get right (plugin IDs drift, wrapper checksums must match, Spring Boot's BOM coordinates change between majors).

Hand-write only the deltas Initializr doesn't produce: `gradle.properties` tunings, version catalog, Spotless config, profile-aware `application.yaml`, the Testcontainers smoke test, and `backend/README.md`. Hand-create the repo-root files (Initializr scope is the project, not the surrounding repo).

### Decision 2: Spring Boot 4.0.x with Gradle Kotlin DSL, Java 21

Spring Boot 4.0 is the current Initializr default and has shipped six patches. Starting a greenfield project on the previous major (3.5.x) means starting a year behind. Risks: some 3rd-party libs (especially niche ones) may lag 4.0 support; mitigation is that our dep set is mainstream (Spring Data JPA, Postgres, Flyway, Testcontainers — all maintained at the cutting edge by their owners).

Gradle (Kotlin DSL) over Maven for AI-workflow iteration speed: real incremental compilation, local + remote build cache, configuration cache, daemon. The "Maven is enterprise default" framing weakens once you weight inner-loop speed properly. Kotlin DSL over Groovy DSL because it's statically typed — IDE/AI autocomplete works and refactors are safe.

Java 21 is the latest LTS; Initializr also offers 17, 25, 26. 21 is the right balance of "current LTS" without committing to non-LTS versions.

### Decision 3: Apply Spring Boot's Gradle plugin pair (`org.springframework.boot` + `io.spring.dependency-management`)

This is what Initializr generates. It imports the Spring Boot BOM and gives transitive version management for free. Don't second-guess; it's the conventional pairing.

### Decision 4: Testcontainers Postgres for the smoke test, not H2 or @MockBean

The smoke test boots the Spring context against a real Postgres in a container. H2 mocks SQL behavior incompletely (Postgres types, JSONB, full-text search, sequences differ). Postgres is the production DB; the smoke test should run on Postgres. Cost: tests need Docker — same Docker that's already required for `docker-compose up postgres`, so it's one prerequisite, not two.

Replace Initializr's default `@SpringBootTest` stub with `ApplicationContextIT` that uses a `@Container PostgreSQLContainer` and `@DynamicPropertySource` to wire the JDBC URL.

### Decision 5: Flyway over Liquibase

Both are widely used. Flyway has simpler ergonomics (plain `.sql` files), is the default in Spring Initializr, and matches what the user gets if they ask "how do migrations work in Spring." Liquibase's strength (database-agnostic XML/YAML changelog) doesn't matter when Postgres is the only target.

### Decision 6: Two profiles — default and `test`

The default profile points at the docker-compose Postgres (`localhost:5432`, env-overridable via `SPRING_DATASOURCE_*`). The `test` profile defers DB config to Testcontainers via `@DynamicPropertySource` in the smoke test. We do **not** add `dev`, `prod`, or `staging` profiles — those are deployment concerns and belong with whatever deployment scaffold lands later.

Convert Initializr's default `application.properties` to `application.yaml` for readable nested config (datasource, JPA, actuator).

### Decision 7: Package layout — `com.prodready.social` root, no folder slicing yet

One root package; no `controller/`, `service/`, `repository/` subdirectories. Future feature changes add packages by feature (e.g., `com.prodready.social.accounts`). This matches "package by feature" enterprise practice and prevents cross-feature coupling.

### Decision 8: Spotless + google-java-format, configured in Gradle, invoked directly by AI on save

Spotless is the source of truth for format rules. CI will run `./gradlew spotlessCheck` (when CI exists). For the inner loop, AI invokes the underlying `google-java-format` binary directly on save (~100-300ms vs ~500ms-2s through Gradle even with the daemon). Both paths read the same google-java-format default rules, so output is identical. This split keeps the inner loop fast while Gradle stays the single enforcement point.

Pick `google-java-format` over Palantir or Eclipse JDT formatter — most-adopted, most-AI-trained-on, no tunables to bikeshed. Apply Spotless via the `com.diffplug.spotless` Gradle plugin.

### Decision 9: Version catalog (`gradle/libs.versions.toml`) from day one

A version catalog declares all dep versions in one TOML file, referenced from `build.gradle.kts` as `libs.spring.boot.starterWeb` etc. Cheap to set up now, painful to retrofit once deps proliferate. Modern Gradle's recommended pattern.

Initializr's generated `build.gradle.kts` declares deps with inline coordinates; migrating those into a catalog is a small, one-time edit.

### Decision 10: `gradle.properties` enables `parallel`, `caching`, `configuration-cache`, `daemon`

```
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=true
org.gradle.daemon=true
```

Initializr-generated `gradle.properties` may not set all of these. This is the direct cash-in on the AI-workflow argument that drove the Gradle decision.

### Decision 11: `docker-compose.yml` at the repo root, single `postgres` service

A repo-root `docker-compose.yml` is consumed by backend (local dev), future e2e (when frontend exists), and any other component needing local Postgres. Owning it at the root prevents per-component drift. Future services (Redis, Kafka, etc.) get added to the same file as they appear.

Alternative — putting it under `backend/` since only the backend uses it today — looks tidier now but misses the point. The DB will be shared with e2e tests within months.

### Decision 12: Document monorepo layout in root `README.md`, no empty placeholder directories

Empty `frontend/`, `e2e/`, `infra/` directories rot — engineers see them as TODOs without context. A root README that names the slots is enough; their respective scaffold changes will create them.

## Risks / Trade-offs

- **Spring Boot 4.0 ecosystem lag** → some 3rd-party deps may have rough edges. Mitigation: our dep set is mainstream and maintained at the cutting edge.
- **Gradle's learning curve** → Acceptable; AI flattens the curve; build-cache speed pays back daily.
- **Smoke test requires Docker** → Same Docker is needed for `docker-compose` anyway. One prerequisite.
- **No CI yet** → Smoke test depends on developers running it locally. Mitigation: CI scaffold is the natural next change after FE scaffold lands.
- **Initializr changes generated files between visits** → Pin `bootVersion` and other params explicitly in the curl command (recorded in tasks.md). The wrapper version is whatever Initializr generates — don't second-guess it.

## Migration Plan

Not applicable — there is no existing backend code to migrate from.

## Open Questions

- **Static analysis (Error Prone, NullAway) — when?** Defer for now per non-goals; revisit once business code exists.
- **Where does shared test infrastructure (e.g., a Testcontainers base class) live in a single-module project?** Place it under `src/test/java/com/prodready/social/support/` for now; revisit if it grows.
- **Pre-commit hooks — when?** Defer; many devs prefer no hooks. Decide once team conventions exist.
