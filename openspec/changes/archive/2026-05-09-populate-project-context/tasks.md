## 1. Update openspec/config.yaml

- [x] 1.1 Replace the commented `context:` template block with a populated `context: |` block describing the stack (Java/Spring, React, Playwright, Postgres) and domain (enterprise-grade social media platform).
- [x] 1.2 Add a `Conventions: TBD` line inside the `context:` block.
- [x] 1.3 Confirm the `rules:` block remains as the original commented template (no active rules).

## 2. Verify

- [x] 2.1 Re-read `openspec/config.yaml` and confirm valid YAML (no parser would choke on the block-scalar indentation).
- [x] 2.2 Run `openspec --version` to sanity-check the CLI still loads with the edited config.
- [x] 2.3 Confirm each scenario in `specs/project-context/spec.md` is satisfied by the file's contents.
