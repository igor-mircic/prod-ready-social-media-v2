## MODIFIED Requirements

### Requirement: Root README declares the monorepo layout

The repo root SHALL contain a `README.md` that names every top-level directory the monorepo will eventually hold and describes its purpose, so future scaffold changes have an unambiguous home.

#### Scenario: Layout is documented
- **WHEN** a reader opens `README.md`
- **THEN** the file lists `backend/` (Java/Spring), `frontend/` (React), `e2e/` (Playwright), and `infra/` (IaC)
- **AND** notes which directories already exist and which are reserved for future scaffold changes.

#### Scenario: No empty placeholder directories
- **WHEN** the repo is inspected
- **THEN** only directories that contain real content exist at the top level
- **AND** no empty `e2e/` or `infra/` directory has been pre-created.
