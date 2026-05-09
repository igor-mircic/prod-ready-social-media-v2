# project-context Specification

## Purpose
TBD - created by archiving change populate-project-context. Update Purpose after archive.
## Requirements
### Requirement: Project context block populated in config

`openspec/config.yaml` SHALL contain a populated `context:` block describing the project's tech stack, domain, and a placeholder for conventions, so AI-generated OpenSpec artifacts reflect the real project.

#### Scenario: Tech stack is declared
- **WHEN** a reader opens `openspec/config.yaml`
- **THEN** the `context:` block names Java/Spring as the backend stack
- **AND** names React as the frontend stack
- **AND** names Playwright as the e2e test stack
- **AND** names Postgres as the database

#### Scenario: Domain is declared
- **WHEN** a reader opens `openspec/config.yaml`
- **THEN** the `context:` block describes the domain as a social media platform built to enterprise/production standards

#### Scenario: Conventions placeholder is present
- **WHEN** a reader opens `openspec/config.yaml`
- **THEN** the `context:` block contains a clearly marked TBD placeholder for project conventions
- **AND** does not invent conventions that have not been agreed.

### Requirement: Rules block left as commented template

`openspec/config.yaml` SHALL leave the `rules:` block as the original commented template until artifact-specific rules are agreed.

#### Scenario: Rules block is not populated prematurely
- **WHEN** a reader opens `openspec/config.yaml`
- **THEN** the `rules:` block remains commented out
- **AND** contains no active artifact-specific rules.

