# backend

Spring Boot 4 service for the social media platform.

## Prerequisites

- **Java 21** — the Gradle toolchain is pinned to Java 21.
- **Docker** — required for the local Postgres (via `docker-compose`) and for the
  Testcontainers-backed integration test.

## Run

From the repo root, start Postgres:

```sh
docker-compose up -d postgres
```

Then from this directory, run the app:

```sh
./gradlew bootRun
```

The default profile points at `jdbc:postgresql://localhost:5432/social` with the
credentials defined in the repo-root `docker-compose.yml`. Override any of these
via the standard Spring `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`,
`SPRING_DATASOURCE_PASSWORD` env vars.

## Test

```sh
./gradlew test
```

This runs `ApplicationContextIT`, which spins up an ephemeral Postgres container
via Testcontainers and asserts that the Spring context loads. Docker must be
running.

## Format

Format enforcement uses Spotless + google-java-format:

```sh
./gradlew spotlessCheck    # verify formatting
./gradlew spotlessApply    # rewrite to match
```

## OpenAPI

Regenerate the OpenAPI spec snapshot at `<repo-root>/openapi/openapi.json`:

```sh
./gradlew generateOpenApiDocs --no-configuration-cache
```

The plugin boots the Spring context with the `codegen` profile (no datasource)
and writes the spec headlessly. CI runs the same command and fails on drift —
see [`../openapi/README.md`](../openapi/README.md) for the full policy.

## Layout

- `src/main/java/com/prodready/social/` — application code; per-feature
  subpackages are added as features land (no `controller/`, `service/`, etc.
  layering).
- `src/main/resources/application.yaml` — runtime config; default profile +
  `test` profile.
- `src/main/resources/db/migration/` — Flyway migrations live here as
  `V1__*.sql`, `V2__*.sql`, ... (currently empty).
- `gradle/libs.versions.toml` — single source of truth for dependency versions.
