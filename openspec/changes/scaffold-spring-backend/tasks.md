## 1. Repo-root files (monorepo-layout capability)

- [ ] 1.1 Add `README.md` at the repo root documenting the flat monorepo layout (`backend/`, `frontend/`, `e2e/`, `infra/`), noting which already exist and which are reserved.
- [ ] 1.2 Add `.gitignore` at the repo root covering Gradle output (`build/`, `.gradle/`), IDE files (`.idea/`, `.vscode/`), Node artifacts (`node_modules/`, `dist/`), Docker volumes, OS junk (`.DS_Store`, `Thumbs.db`).
- [ ] 1.3 Add `.gitattributes` at the repo root with `* text=auto eol=lf` and binary markers for jar/zip/wrapper files.
- [ ] 1.4 Add `.editorconfig` at the repo root setting UTF-8 charset, LF line endings, final-newline insertion, trailing-whitespace trimming, and reasonable indentation defaults (4-space Java, 2-space YAML/JSON).
- [ ] 1.5 Add `docker-compose.yml` at the repo root with a single `postgres` service exposing port 5432 with documented credentials.

## 2. Generate backend skeleton via Spring Initializr

- [ ] 2.1 Run `curl https://start.spring.io/starter.zip -d type=gradle-project-kotlin -d language=java -d bootVersion=4.0.6 -d baseDir=backend -d groupId=com.prodready.social -d artifactId=backend -d name=backend -d packageName=com.prodready.social -d javaVersion=21 -d packaging=jar -d dependencies=web,data-jpa,validation,actuator,postgresql,flyway,testcontainers -o /tmp/backend.zip`. Confirm the bootVersion against `start.spring.io` before running; bump if a newer 4.0.x patch is GA.
- [ ] 2.2 Unzip `/tmp/backend.zip` at the repo root so it produces `backend/`, then delete `/tmp/backend.zip`.
- [ ] 2.3 Confirm Initializr generated `backend/build.gradle.kts`, `backend/settings.gradle.kts`, `backend/gradlew`, `backend/gradlew.bat`, `backend/gradle/wrapper/`, `backend/src/main/java/com/prodready/social/Application.java`, and a default test class.
- [ ] 2.4 Run `cd backend && ./gradlew --version` to confirm the wrapper executes against the Initializr-pinned Gradle version.

## 3. Backend deltas (backend-scaffold capability)

- [ ] 3.1 Edit `backend/gradle.properties` (or create if missing) to enable `org.gradle.parallel=true`, `org.gradle.caching=true`, `org.gradle.configuration-cache=true`, `org.gradle.daemon=true`. Preserve any flags Initializr set.
- [ ] 3.2 Create `backend/gradle/libs.versions.toml` with `[versions]`, `[libraries]`, `[plugins]` sections covering every dep Initializr generated (Spring Boot starters, Postgres driver, Flyway, Testcontainers).
- [ ] 3.3 Edit `backend/build.gradle.kts` to reference the catalog via `libs.<name>` accessors instead of inline coordinates.
- [ ] 3.4 Add the Spotless plugin (`com.diffplug.spotless`) to `backend/build.gradle.kts` and configure it with `java { googleJavaFormat() }`. Add a corresponding entry in `libs.versions.toml`.
- [ ] 3.5 Replace Initializr's default `application.properties` with `application.yaml`. Define the default profile pointing at `jdbc:postgresql://localhost:5432/social` (overridable via `SPRING_DATASOURCE_*` env vars), and a `test` profile that omits the JDBC URL. Configure actuator to expose only `health` and `info`.
- [ ] 3.6 Create `backend/src/main/resources/db/migration/` (empty directory; commit a `.gitkeep` if needed to track it).
- [ ] 3.7 Replace Initializr's default test class with `backend/src/test/java/com/prodready/social/ApplicationContextIT.java` that uses `@SpringBootTest`, `@Testcontainers`, a `@Container PostgreSQLContainer`, and `@DynamicPropertySource` to wire `spring.datasource.*`. Test asserts the context loads.
- [ ] 3.8 Add `backend/README.md` documenting Java 21 + Docker prerequisites, the run path (`docker-compose up -d postgres` then `./gradlew bootRun`), and the test path (`./gradlew test`).

## 4. Verify

- [ ] 4.1 From the repo root, run `docker-compose up -d postgres` and confirm a Postgres container is healthy on port 5432.
- [ ] 4.2 From `backend/`, run `./gradlew spotlessCheck` and confirm it passes on the freshly generated code (run `spotlessApply` first if Initializr's output is misformatted by google-java-format's rules).
- [ ] 4.3 From `backend/`, run `./gradlew test` and confirm `ApplicationContextIT` starts a Testcontainers Postgres and the Spring context loads.
- [ ] 4.4 From `backend/`, run `./gradlew bootRun &`, hit `curl localhost:8080/actuator/health` and confirm HTTP 200, then stop the app. Hit `curl localhost:8080/actuator/metrics` and confirm 404 (or unreachable).
- [ ] 4.5 Re-read each scenario in `specs/monorepo-layout/spec.md` and `specs/backend-scaffold/spec.md` and confirm the file contents satisfy them.
- [ ] 4.6 Run `git status` and confirm no Gradle build output (`build/`, `.gradle/`) is tracked — `.gitignore` should be excluding it.
