# monorepo-layout Specification

## Purpose
TBD - created by syncing change scaffold-spring-backend. Update Purpose after archive.

## Requirements
### Requirement: Root README declares the monorepo layout

The repo root SHALL contain a `README.md` that names every top-level directory the monorepo will eventually hold and describes its purpose, so future scaffold changes have an unambiguous home.

#### Scenario: Layout is documented
- **WHEN** a reader opens `README.md`
- **THEN** the file lists `backend/` (Java/Spring), `frontend/` (React), `e2e/` (Playwright), and `infra/` (IaC)
- **AND** notes which directories already exist and which are reserved for future scaffold changes.

#### Scenario: No empty placeholder directories
- **WHEN** the repo is inspected
- **THEN** only directories that contain real content exist at the top level
- **AND** no empty `frontend/`, `e2e/`, or `infra/` directory has been pre-created.

### Requirement: Repo-wide editor and VCS hygiene files exist

The repo root SHALL contain `.gitignore`, `.gitattributes`, and `.editorconfig` so that build artifacts stay out of git, line endings normalize across platforms, and editors produce consistent indentation/charset/final-newline behavior.

#### Scenario: gitignore excludes JVM and Node build outputs
- **WHEN** a reader opens `.gitignore`
- **THEN** the file ignores Gradle build output (`build/`, `.gradle/`)
- **AND** ignores common IDE files (`.idea/`, `.vscode/`)
- **AND** ignores Node artifacts (`node_modules/`, `dist/`) in anticipation of frontend/e2e
- **AND** ignores OS junk files (`.DS_Store`, `Thumbs.db`).

#### Scenario: gitattributes normalizes line endings
- **WHEN** a reader opens `.gitattributes`
- **THEN** the file declares `* text=auto eol=lf`
- **AND** marks Gradle wrapper jar and other binaries appropriately.

#### Scenario: editorconfig sets baseline editor behavior
- **WHEN** a reader opens `.editorconfig`
- **THEN** the file declares UTF-8 charset, LF line endings, final newline insertion, and trailing-whitespace trimming for all text files.

### Requirement: Repo root provides a docker-compose for local dependencies

The repo root SHALL contain a `docker-compose.yml` that brings up the dependencies a developer needs to run any component of the monorepo locally. Initially this means a single Postgres service consumed by the backend; the file is the shared point of extension as future components need additional local services.

#### Scenario: Postgres service is defined
- **WHEN** a developer runs `docker-compose up -d postgres` from the repo root
- **THEN** a Postgres container starts on `localhost:5432`
- **AND** the container exposes credentials usable by the backend's default profile.

#### Scenario: Service definitions live at the repo root, not under backend/
- **WHEN** the repo is inspected
- **THEN** `docker-compose.yml` is at the repo root, not under `backend/`
- **AND** the file is structured so future components (frontend dev tooling, e2e, additional services) can extend it without per-component duplication.
