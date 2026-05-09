## Why

The repo has no application code yet. Before any social-media capability (accounts, posts, feed, etc.) can land, we need a runnable Spring Boot backend wired to Postgres, with the conventional enterprise plumbing already in place (Actuator, Flyway, JPA, validation, Testcontainers) and the dev-loop infrastructure (build caching, format enforcement, local Postgres) that an AI-heavy workflow leans on heavily.

Doing this scaffold once, deliberately, prevents the first feature change from quietly absorbing infrastructure decisions under deadline pressure. This change also commits the repo to a top-level monorepo layout so future frontend, e2e, and infra changes have an obvious home.

## What Changes

**Top-level (declares monorepo structure and shared dev ergonomics):**
- Add `README.md` declaring the flat monorepo layout: `backend/`, `frontend/`, `e2e/`, `infra/`. Only `backend/` is created in this change; the rest are created by their own scaffold changes.
- Add `.gitignore` covering JVM build output, IDE files (IntelliJ `.idea/`, VS Code `.vscode/`), Node artifacts (anticipating frontend/e2e), Docker volumes, OS junk.
- Add `.gitattributes` normalizing line endings (LF in repo, native checkout) and marking binaries.
- Add `.editorconfig` setting indentation, charset, and final-newline rules for the whole repo.
- Add `docker-compose.yml` at the repo root with a single Postgres service for local development. Backend, future e2e, and any other component that needs the DB locally point at this.

**Backend module (`backend/`, Gradle + Kotlin DSL):**
- Spring Boot 3.x application targeting Java 21, single-module Gradle project.
- Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/`) pinned to a specific Gradle version.
- `gradle.properties` enabling parallel execution, build cache, and configuration cache — the AI-workflow ergonomics argument that drove the Gradle decision.
- Version catalog at `backend/gradle/libs.versions.toml` declaring all dependency versions in one place.
- Baseline dependencies (in catalog, applied in `build.gradle.kts`):
  - `spring-boot-starter-web`, `spring-boot-starter-data-jpa`, `spring-boot-starter-validation`, `spring-boot-starter-actuator`
  - `org.postgresql:postgresql`
  - `org.flywaydb:flyway-core`, `flyway-database-postgresql`
  - Test scope: `spring-boot-starter-test`, `org.testcontainers:postgresql`, `org.testcontainers:junit-jupiter`
- Spotless plugin configured with `google-java-format`, applied to all Java sources. CI will enforce via `./gradlew spotlessCheck`; AI invokes the formatter binary directly on save.
- `application.yaml` with two profiles: a default profile pointing at the docker-compose Postgres (env-overridable), and a `test` profile that defers DB config to Testcontainers.
- Empty `backend/src/main/resources/db/migration/` so the first feature change just adds `V1__*.sql`.
- Smoke test (`ApplicationContextIT`) that boots the Spring context against a Testcontainers Postgres and asserts the context loads.
- Actuator: `/actuator/health` and `/actuator/info` exposed; other endpoints stay disabled by default.
- `backend/README.md` documenting prerequisites (Java 21, Docker), how to run (`docker-compose up -d postgres`, `./gradlew bootRun`), and how to test (`./gradlew test`).

## Capabilities

### New Capabilities
- `monorepo-layout`: The top-level structure of the repo, plus shared developer ergonomics that aren't backend-specific (root README, `.gitignore`, `.gitattributes`, `.editorconfig`, local-dev `docker-compose.yml`). Future scaffold changes (frontend, e2e, infra) land in the directories named here and may extend `docker-compose.yml`.
- `backend-scaffold`: The runnable Spring Boot backend project — Gradle build, dependency baseline, configuration profiles, format enforcement, and smoke-level boot test. Future product capabilities (accounts, posts, feed) build on top of this.

### Modified Capabilities
None.

## Impact

- New top-level files: `README.md`, `.gitignore`, `.gitattributes`, `.editorconfig`, `docker-compose.yml`.
- New backend tree:
  - `backend/build.gradle.kts`, `backend/settings.gradle.kts`, `backend/gradle.properties`
  - `backend/gradle/libs.versions.toml`, `backend/gradle/wrapper/...`, `backend/gradlew`, `backend/gradlew.bat`
  - `backend/src/main/java/com/prodready/social/Application.java`
  - `backend/src/main/resources/application.yaml`
  - `backend/src/main/resources/db/migration/` (empty)
  - `backend/src/test/java/com/prodready/social/ApplicationContextIT.java`
  - `backend/README.md`
- No effect on `openspec/`.
- New hard dev prerequisites: Java 21 and Docker. Documented in both READMEs.
- No CI, deploy artifacts, or production observability in this change — those are separate scaffolds.
