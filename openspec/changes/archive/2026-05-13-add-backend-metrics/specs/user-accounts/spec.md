## MODIFIED Requirements

### Requirement: Security filter chain is deny-by-default with an explicit allowlist

The backend SHALL configure a `SecurityFilterChain` that requires authentication for every request except an explicit allowlist consisting of `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `GET /actuator/health`, `GET /actuator/info`, `GET /actuator/prometheus`, `GET /v3/api-docs/**`, `GET /swagger-ui/**`, and `GET /favicon.ico`. Any other endpoint SHALL return `401 ProblemDetail` when no authenticated principal is present.

#### Scenario: An unprotected endpoint reaches the controller

- **WHEN** a client calls `POST /api/v1/auth/signup` with no `Authorization` header
- **THEN** the request reaches the signup controller (returns the signup outcome, not 401).

#### Scenario: An unallowlisted endpoint requires authentication

- **WHEN** a client calls any endpoint that is not in the allowlist with no `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail`.

#### Scenario: Allowlist is explicit, not derived

- **WHEN** a reader inspects the security configuration class
- **THEN** the allowlist is enumerated as a literal list (not derived from annotations) so it can be reviewed in one place.

#### Scenario: Actuator metrics scrape endpoint is reachable unauthenticated

- **WHEN** a client calls `GET /actuator/prometheus` with no `Authorization` header
- **THEN** the response status is 200
- **AND** the response body is Prometheus text-exposition format (the metrics scrape).

#### Scenario: Other Actuator endpoints stay closed

- **WHEN** a client calls `GET /actuator/env`, `GET /actuator/beans`, `GET /actuator/loggers`, or any other Actuator endpoint NOT in the allowlist with no `Authorization` header
- **THEN** the response status is 401
- **AND** the response body is a `ProblemDetail` with `status` 401.
