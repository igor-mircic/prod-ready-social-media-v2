# monorepo-layout Specification

## Purpose
TBD - created by syncing change scaffold-spring-backend. Update Purpose after archive.
## Requirements
### Requirement: Root README declares the monorepo layout

The repo root SHALL contain a `README.md` that names every top-level directory the monorepo will eventually hold and describes its purpose, so future scaffold changes have an unambiguous home.

#### Scenario: Layout is documented
- **WHEN** a reader opens `README.md`
- **THEN** the file lists `backend/` (Java/Spring), `frontend/` (React), `e2e/` (Playwright), and `infra/` (IaC)
- **AND** notes `e2e/` as an existing directory containing the Playwright end-to-end harness
- **AND** notes which other directories already exist and which are reserved for future scaffold changes.

#### Scenario: No empty placeholder directories
- **WHEN** the repo is inspected
- **THEN** only directories that contain real content exist at the top level
- **AND** no empty `infra/` directory has been pre-created.

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

### Requirement: `infra/k8s/base/` hosts one component subdirectory per workload

The `infra/k8s/base/` tree SHALL hold one subdirectory per workload that lives in the cluster, with each subdirectory self-contained (its own `kustomization.yaml` and the resources that compose the workload). The `infra/k8s/base/kustomization.yaml` file SHALL be the single index — adding a new workload means creating a sibling subdirectory and appending its path to the index's `resources:` block. Plain-resource components (e.g. the backend and frontend, where the workload is hand-written YAML) and `helmCharts:`-based components (e.g. postgres, where a Bitnami chart is wrapped) SHALL coexist as sibling subdirectories without further structure.

#### Scenario: Each workload lives in its own base subdirectory
- **WHEN** a reader lists `infra/k8s/base/`
- **THEN** the directory contains a `kustomization.yaml` and one subdirectory per workload (at minimum `postgres/`, `backend/`, and `frontend/`)
- **AND** every subdirectory contains a `kustomization.yaml` that the parent `infra/k8s/base/kustomization.yaml` references via its `resources:` block

#### Scenario: Plain-resource and helm-chart workloads coexist as siblings
- **WHEN** a reader inspects the three subdirectories `infra/k8s/base/postgres/`, `infra/k8s/base/backend/`, and `infra/k8s/base/frontend/`
- **THEN** the postgres subdirectory's `kustomization.yaml` uses a `helmCharts:` block (chart-driven)
- **AND** the backend and frontend subdirectories' `kustomization.yaml` files list plain `resources:` (manifest-driven)
- **AND** all three subdirectories are listed as siblings in `infra/k8s/base/kustomization.yaml`'s `resources:` block

#### Scenario: New workloads are added by creating a subdirectory and one index edit
- **WHEN** a contributor adds a new workload to the cluster
- **THEN** the contributor creates a new sibling subdirectory under `infra/k8s/base/`
- **AND** appends a single `./<workload>` entry to `infra/k8s/base/kustomization.yaml`
- **AND** does not need to edit any other index file (the overlays inherit the base)

