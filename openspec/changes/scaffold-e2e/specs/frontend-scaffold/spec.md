## ADDED Requirements

### Requirement: Vite preview server proxies actuator and API calls to the backend

The `frontend/vite.config.ts` SHALL declare a `preview.proxy` block that mirrors the existing `server.proxy` block, so the production build served by `vite preview` (used by the e2e harness) can reach `/actuator/*` and `/api/v1/*` on the backend without CORS configuration. Both the dev server's `server.proxy` and the preview server's `preview.proxy` SHALL forward `/actuator` and `/api/v1` to `http://localhost:8080`.

#### Scenario: preview.proxy is declared

- **WHEN** a reader opens `frontend/vite.config.ts`
- **THEN** the Vite config's `preview.proxy` block contains an entry mapping `/actuator` to `http://localhost:8080`
- **AND** an entry mapping `/api/v1` to `http://localhost:8080` (with `changeOrigin: true`).

#### Scenario: preview.proxy mirrors server.proxy

- **WHEN** a reader compares `server.proxy` and `preview.proxy` in `frontend/vite.config.ts`
- **THEN** both blocks declare entries for `/actuator` and `/api/v1`
- **AND** both blocks point at the same backend origin (`http://localhost:8080`).

#### Scenario: vite preview can reach the backend during e2e

- **WHEN** the e2e harness runs `vite preview` against `frontend/dist/` and the backend is running on `localhost:8080`
- **THEN** an in-browser request to `/api/v1/auth/signup` from the previewed SPA reaches the backend
- **AND** an in-browser request to `/actuator/health` from the previewed SPA reaches the backend.
