# frontend

React + TypeScript single-page app, built with Vite. Talks to the Spring backend
in `../backend/`.

## Prerequisites

- **Node** at the version pinned in [`.nvmrc`](./.nvmrc). With `nvm`:
  ```sh
  nvm install
  nvm use
  ```
- **pnpm** — pinned via the `packageManager` field in `package.json`. With a
  recent Node, `corepack enable` activates the right pnpm version automatically:
  ```sh
  corepack enable
  ```
  Otherwise install it directly: <https://pnpm.io/installation>.

## Commands

All commands run from this directory.

- `pnpm install` — install dependencies (writes/uses `pnpm-lock.yaml`). Triggers
  a `postinstall` step that regenerates the typed API layer in
  `src/api/generated/` from `../openapi/openapi.json` via Orval. The generated
  tree is gitignored.
- `pnpm dev` — start the Vite dev server on <http://localhost:5173>. The dev
  server proxies `/actuator/*` and `/api/v1/*` to `http://localhost:8080` (the
  backend), so the app uses relative API URLs without CORS configuration in dev.
  **The backend must be running on port 8080** for live API calls; without it,
  `/api/v1` calls will fail.
- `pnpm gen:api` — regenerate the API layer on demand (e.g., after the backend
  team updates `openapi/openapi.json`). Equivalent to the `postinstall` step.
- `pnpm test` — run the Vitest suite once. Tests use generated MSW handlers
  rather than a live backend; see `src/test/msw-server.ts`.
- `pnpm build` — type-check (`tsc -b`) and produce a production bundle in
  `dist/`. The typecheck validates the generated TS against the committed
  spec snapshot.
- `pnpm lint` — run ESLint over the project.

## Generated API layer

`src/api/generated/` holds three Orval outputs, all derived from
`../openapi/openapi.json`:

- `queries/` — typed TanStack Query hooks (`useSignup`, …).
- `schemas/` — Zod schemas (`SignupBody`, …) used as `react-hook-form`
  resolvers.
- `msw/` — MSW request handlers used by the vitest suite.

All generated request functions go through the custom mutator at
`src/api/client.ts`, which reads `import.meta.env.VITE_API_BASE_URL`
(defaulting to `/api/v1`) and turns non-2xx responses into a typed `ApiError`.
