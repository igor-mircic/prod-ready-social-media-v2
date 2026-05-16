## MODIFIED Requirements

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
