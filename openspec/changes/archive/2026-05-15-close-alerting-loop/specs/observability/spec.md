## MODIFIED Requirements

### Requirement: Alertmanager is provisioned under the `observability` docker-compose profile and as a Grafana datasource

A single `alertmanager` service runs alongside the existing Prometheus, Tempo, Loki, OTel Collector, Grafana, and (from this slice) webhook-sink containers when (and only when) the `observability` profile is selected. Its HTTP API on port `9093` is the canonical alert store: queryable for active alerts, consumed by Grafana via a provisioned datasource, and the routing entry point for every firing. Alertmanager's configuration MUST declare a severity-based routing tree that delivers `severity=page` alerts to one webhook receiver and `severity=ticket` alerts to another, plus an inhibition rule that suppresses every SLO alert while `BackendDown` is firing. The default `docker-compose up -d postgres` invocation MUST continue to start only Postgres.

#### Scenario: Default invocation still starts only postgres (preserved across slice 8)
- **WHEN** an operator runs `docker-compose up -d postgres` from the repository root
- **THEN** only the `social-postgres` container is started
- **AND** no `social-alertmanager`, `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, `social-loki`, or `social-webhook-sink` container is started

#### Scenario: Observability profile starts alertmanager alongside the other observability services
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** the `social-alertmanager` container is started in addition to `social-prometheus`, `social-grafana`, `social-tempo`, `social-collector`, `social-loki`, and `social-webhook-sink`
- **AND** the `social-alertmanager` container exposes Alertmanager's HTTP API on host port `9093`

#### Scenario: Alertmanager image tag is pinned
- **WHEN** the docker-compose `alertmanager` service definition is read
- **THEN** the `image:` field is `prom/alertmanager:<explicit-version>` (not `latest` and not unpinned)

#### Scenario: Alertmanager configuration declares a severity-based routing tree
- **WHEN** `infra/observability/alertmanager/alertmanager.yml` is loaded by Alertmanager at startup
- **THEN** the top-level `route:` block names a `default` receiver from the `receivers:` list
- **AND** the top-level `route:` declares two child routes: one matching `severity="page"` that targets a `page-webhook` receiver, and one matching `severity="ticket"` that targets a `ticket-webhook` receiver
- **AND** neither child route sets `continue: true` (each firing terminates at the first matching leaf)
- **AND** the existing `group_by: ['alertname', 'slo']`, `group_wait: 10s`, `group_interval: 5m`, and `repeat_interval: 4h` values on the top-level route are preserved

#### Scenario: Alertmanager webhook receivers target the webhook-sink container
- **WHEN** the `receivers:` block in `alertmanager.yml` is loaded
- **THEN** the `page-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink:8080/page` and `send_resolved: true`
- **AND** the `ticket-webhook` receiver declares `webhook_configs:` with `url: http://webhook-sink:8080/ticket` and `send_resolved: true`
- **AND** the `default` receiver exists (Alertmanager requires it) and declares no `webhook_configs:` (unlabelled alerts are dropped silently until they gain a severity label)

#### Scenario: Alertmanager configuration declares the BackendDown inhibition rule
- **WHEN** the `inhibit_rules:` block in `alertmanager.yml` is loaded
- **THEN** there is exactly one inhibition rule whose `source_matchers:` match `alertname="BackendDown"` and whose `target_matchers:` match `slo=~".+"`
- **AND** the rule's `equal:` field is the empty list (a BackendDown anywhere inhibits every SLO alert anywhere — slice 11 has only one backend target)

#### Scenario: Grafana datasource provisioning declares Alertmanager as non-default
- **WHEN** Grafana provisioning is loaded
- **THEN** `infra/observability/grafana/provisioning/datasources/alertmanager.yaml` declares an Alertmanager datasource targeting `http://alertmanager:9093`
- **AND** the datasource is marked `isDefault: false`
- **AND** the datasource implementation is `alertmanager` (so Grafana's built-in Alerting nav reads from it)

### Requirement: `promtool test rules` proves the alerting logic against synthetic series

A test fixture at `infra/observability/prometheus/rules/slo-tests.yml` MUST feed crafted time series into the recording and alerting rules and assert which alerts are in which state at which simulated time, including the value of the `runbook_url` annotation. Every alerting-rule scenario in this spec SHALL correspond to at least one stanza in the fixture. CI MUST invoke `promtool test rules` (via the pinned Prometheus image) and SHALL fail the build on any test failure.

#### Scenario: The fixture lives next to the rule files
- **WHEN** the `infra/observability/prometheus/rules/` directory is listed
- **THEN** it contains `slo-tests.yml` alongside `slo-recording.yml` and `slo-alerting.yml`

#### Scenario: Every spec-level alerting scenario is covered by a test stanza
- **WHEN** the fixture is read
- **THEN** for each of `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, and `BackendDown` there is at least one test that asserts the alert fires under matching synthetic input
- **AND** for `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, and `ApiAvailabilityBudgetBurn` there is at least one test that asserts no firing under steady-state successful traffic

#### Scenario: Fixture asserts the runbook_url annotation on every firing alert
- **WHEN** any alerting-rule test in `slo-tests.yml` or `fe-slo-tests.yml` declares an `exp_alerts:` entry
- **THEN** the matching `exp_annotations:` block contains a `runbook_url` key
- **AND** the `runbook_url` value matches the URL pattern declared in the alert definition (a GitHub blob path under `infra/observability/runbooks/<AlertName>.md`)

### Requirement: README documents the local alerting run loop

The repository README's observability section MUST contain an "Alerting" subsection that names the new surfaces and the commands to inspect alert delivery locally — so an operator who pulls the branch can verify the slice without reading the spec.

#### Scenario: README documents the alerting run loop
- **WHEN** a contributor reads the observability section of the project README
- **THEN** the README names `http://localhost:9093` as the Alertmanager UI and notes that Grafana's Alerting left-nav also surfaces alerts (via the provisioned Alertmanager datasource)
- **AND** the README documents the one-liner that runs `promtool test rules` against the rule files using the pinned `prom/prometheus` image
- **AND** the README mentions that a Prometheus restart is required after editing rule files for changes to take effect
- **AND** the README documents that the local `webhook-sink` container records every routed firing and the commands to inspect it (`docker compose logs webhook-sink` and the `GET /received` endpoint)
- **AND** the README documents that the `runbook_url` annotation on each alert points at a Markdown stub under `infra/observability/runbooks/` and that real incident notes are expected to grow there over time

## ADDED Requirements

### Requirement: Webhook sink service is provisioned under the `observability` docker-compose profile

A single `webhook-sink` service runs under the `observability` docker-compose profile. It is the canonical local-dev destination for routed Alertmanager firings, standing in for a real PagerDuty / Opsgenie / Slack receiver. The container image MUST be built from sources tracked in the repository at `infra/observability/webhook-sink/`, with a multi-stage Dockerfile pinned to a specific base image tag.

#### Scenario: Observability profile starts the webhook sink container
- **WHEN** an operator runs `docker-compose --profile observability up -d`
- **THEN** a `social-webhook-sink` container is started in addition to the other observability containers
- **AND** the container exposes its HTTP server on host port `8081` (mapped to container port `8080`)
- **AND** Alertmanager reaches the sink at `http://webhook-sink:8080` on the shared docker network

#### Scenario: Webhook sink source code lives in the repository
- **WHEN** the `infra/observability/webhook-sink/` directory is listed
- **THEN** it contains a server source file, a `package.json` (or equivalent dependency manifest), a `Dockerfile`, and a short `README.md` describing the container's contract
- **AND** the `Dockerfile` is multi-stage (a build stage followed by a thin runtime stage) and pins its base image to an explicit tag (not `latest`)

#### Scenario: Default invocation does not start the webhook sink
- **WHEN** an operator runs `docker-compose up -d postgres`
- **THEN** the `social-webhook-sink` container is NOT started (the service is gated by the `observability` profile)

### Requirement: Webhook sink exposes severity-keyed delivery endpoints and a queryable received-payload surface

The webhook sink container MUST accept Alertmanager webhook payloads on two severity-keyed paths and expose a query surface that tests can use to assert which payloads were received in what order.

#### Scenario: Page endpoint accepts Alertmanager webhook payloads
- **WHEN** an HTTP `POST` is made to `http://webhook-sink:8080/page` with an Alertmanager webhook JSON body (`receiver`, `status`, `alerts: [...]`)
- **THEN** the sink responds with HTTP `2xx`
- **AND** the payload is appended to the sink's in-memory ring of received payloads, tagged with the receiving path (`page`) and a server-side receive timestamp

#### Scenario: Ticket endpoint accepts Alertmanager webhook payloads
- **WHEN** an HTTP `POST` is made to `http://webhook-sink:8080/ticket` with an Alertmanager webhook JSON body
- **THEN** the sink responds with HTTP `2xx`
- **AND** the payload is appended to the sink's in-memory ring tagged with `ticket`

#### Scenario: Received-payloads endpoint returns a queryable view
- **WHEN** an HTTP `GET` is made to `http://webhook-sink:8080/received`
- **THEN** the sink responds with HTTP `200` and a JSON body containing every payload in the ring, in receive order, each annotated with its receiving path and receive timestamp
- **AND** the response supports an `?after=<unix-millis>` query parameter that filters out payloads received before the given timestamp

#### Scenario: In-memory ring is bounded
- **WHEN** more payloads are received than the configured ring capacity
- **THEN** the oldest payloads are dropped silently
- **AND** the ring capacity is at least 64 (large enough that an interactive session in parallel with an e2e test does not crowd out the test's payloads inside one test run)

### Requirement: Every backend and frontend alert carries a `runbook_url` annotation

Every alerting rule defined under `infra/observability/prometheus/rules/` MUST include a `runbook_url` annotation pointing at a Markdown file under `infra/observability/runbooks/`. This is the contract that an on-call person who gets paged has a triage entry point.

#### Scenario: Backend SLO and liveness alerts declare a runbook_url annotation
- **WHEN** `infra/observability/prometheus/rules/slo-alerting.yml` is loaded
- **THEN** each of the alerts `ApiAvailabilityFastBurn`, `ApiAvailabilitySlowBurn`, `ApiAvailabilityBudgetBurn`, `FeedReadLatencyFastBurn`, `FeedReadLatencySlowBurn`, `PostCreateLatencyFastBurn`, `PostCreateLatencySlowBurn`, and `BackendDown` declares an `annotations.runbook_url:` field
- **AND** the value is a GitHub blob URL whose path component ends in `/infra/observability/runbooks/<AlertName>.md` (matching the alert's `alert:` name exactly)

#### Scenario: Frontend SLO alerts declare a runbook_url annotation
- **WHEN** `infra/observability/prometheus/rules/fe-slo-alerting.yml` is loaded
- **THEN** each of the alerts `LcpSloFastBurn`, `LcpSloSlowBurn`, `InpSloFastBurn`, and `InpSloSlowBurn` declares an `annotations.runbook_url:` field
- **AND** the value is a GitHub blob URL whose path component ends in `/infra/observability/runbooks/<AlertName>.md`

### Requirement: Per-alert runbook stubs live under `infra/observability/runbooks/`

The repository MUST carry one Markdown runbook stub per alert defined in the rule files. Each stub is short (one screen, not a long-form document) and establishes the contract that real incident learnings have a home in the repo.

#### Scenario: Every alert has a runbook stub at the expected path
- **WHEN** the `infra/observability/runbooks/` directory is listed
- **THEN** it contains exactly the files `ApiAvailabilityFastBurn.md`, `ApiAvailabilitySlowBurn.md`, `ApiAvailabilityBudgetBurn.md`, `FeedReadLatencyFastBurn.md`, `FeedReadLatencySlowBurn.md`, `PostCreateLatencyFastBurn.md`, `PostCreateLatencySlowBurn.md`, `BackendDown.md`, `LcpSloFastBurn.md`, `LcpSloSlowBurn.md`, `InpSloFastBurn.md`, and `InpSloSlowBurn.md`

#### Scenario: Each runbook stub declares the canonical sections
- **WHEN** any of the runbook stub files is opened
- **THEN** the file contains H2 (or H1) headings for `Symptoms`, `Impact`, `Triage`, `Mitigation`, and `Escalation` (in that order)
- **AND** every heading has at least one non-empty paragraph or bullet beneath it (no empty section)

### Requirement: End-to-end test proves the routing → webhook delivery → inhibition pipeline

An end-to-end test under `e2e/tests/observability.alerting.spec.ts` MUST prove that a synthetic alert POSTed to Alertmanager's `/api/v2/alerts` endpoint is routed to the correct webhook-sink path according to its `severity` label, that the alert's `runbook_url` annotation is preserved through routing, and that the BackendDown→SLO inhibition rule suppresses SLO alerts when BackendDown is also firing. The spec MUST self-skip when the observability profile is not running.

#### Scenario: Page-severity alert is routed to the page endpoint
- **WHEN** the spec POSTs a synthetic alert with `labels.severity="page"` and `annotations.runbook_url="<some-url>"` to `http://localhost:9093/api/v2/alerts`
- **THEN** the spec observes a matching payload at `GET http://localhost:8081/received?after=<test-start>` on the `/page` path within a 30-second polling budget
- **AND** the payload's `alerts[].annotations.runbook_url` equals the value originally POSTed

#### Scenario: Ticket-severity alert is routed to the ticket endpoint
- **WHEN** the spec POSTs a synthetic alert with `labels.severity="ticket"`
- **THEN** the spec observes a matching payload at `GET http://localhost:8081/received` on the `/ticket` path within the same polling budget
- **AND** no payload is observed on the `/page` path for that alert

#### Scenario: BackendDown inhibits SLO alerts
- **WHEN** the spec POSTs a `BackendDown` alert and an `ApiAvailabilityFastBurn` alert together (both with `severity="page"`) and waits for the polling budget plus Alertmanager's `group_wait` (10s)
- **THEN** the spec observes the `BackendDown` payload at the `/page` path
- **AND** the spec does NOT observe the `ApiAvailabilityFastBurn` payload at either path while the `BackendDown` alert is still active

#### Scenario: Spec self-skips when the observability profile is not running
- **WHEN** the spec's `beforeAll` cannot reach `http://localhost:9093/-/ready` or `http://localhost:8081/healthz` within a short probe timeout
- **THEN** every test in the file is marked skipped (not failed)
- **AND** the skip reason names which surface was unreachable
