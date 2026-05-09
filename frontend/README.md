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

- `pnpm install` — install dependencies (writes/uses `pnpm-lock.yaml`).
- `pnpm dev` — start the Vite dev server on <http://localhost:5173>. The dev
  server proxies `/actuator/*` to `http://localhost:8080` (the backend), so the
  app can call backend health endpoints without CORS configuration in dev.
- `pnpm test` — run the Vitest smoke test once.
- `pnpm build` — type-check (`tsc -b`) and produce a production bundle in
  `dist/`.
- `pnpm lint` — run ESLint over the project.
