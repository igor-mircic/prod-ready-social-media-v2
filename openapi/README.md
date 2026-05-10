# openapi

`openapi.json` is the canonical contract between the Spring backend and the
React frontend. It is generated from the backend (controller + DTO + validation
annotations) by [springdoc-openapi][springdoc] and consumed by the frontend's
[Orval][orval] codegen pipeline.

The file IS committed. CI runs the generator on every push and fails when the
committed snapshot does not match what the backend would produce — see the
"Drift check" section below.

## Regenerate locally

From the repo root:

```sh
cd backend
./gradlew generateOpenApiDocs --no-configuration-cache
```

The plugin boots the Spring context with the `codegen` profile (no datasource,
no Flyway), hits `/v3/api-docs`, writes `<repo-root>/openapi/openapi.json`,
and exits.

The `--no-configuration-cache` flag is required: the plugin's forked-`bootRun`
machinery is not compatible with Gradle's configuration cache. Run output is
unaffected.

## Drift check

CI runs:

```sh
./gradlew generateOpenApiDocs --no-configuration-cache
git diff --exit-code openapi/openapi.json
```

If the diff is non-empty, the build fails. The fix is always: regenerate
locally, commit the updated `openapi.json`, and push.

## Frontend regeneration

The frontend regenerates its TanStack Query hooks, Zod schemas, and MSW
handlers from this file via Orval. The generated TypeScript is gitignored
(`frontend/src/api/generated/`) and is rebuilt on `pnpm install` (postinstall
script) or on demand:

```sh
cd frontend
pnpm gen:api
```

[springdoc]: https://springdoc.org/
[orval]: https://orval.dev/
