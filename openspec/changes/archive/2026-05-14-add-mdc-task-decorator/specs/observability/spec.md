## ADDED Requirements

### Requirement: A reusable `TaskDecorator` propagates MDC across thread boundaries

The backend SHALL provide a Spring `TaskDecorator` implementation in the `com.prodready.social.observability` package that, when wired onto an `Executor` / `TaskExecutor`, copies the caller thread's MDC snapshot onto each worker thread for the duration of the submitted task and clears the worker's MDC afterwards so no state leaks to the next task that pool thread runs.

The decorator MUST be a plain building block: it MUST NOT be auto-registered on any executor, and the change MUST NOT introduce a new executor bean. Any future async-capable feature is responsible for wiring the decorator on the executor it owns.

A code-level note SHALL be placed in the observability package (either a `package-info.java` or a paragraph added to an existing class's class-level Javadoc) instructing future contributors that any new `Executor`, `TaskExecutor`, or `@Async` configuration must wire this decorator or request-scoped MDC keys will disappear from worker-thread log lines.

#### Scenario: Decorator carries caller MDC onto the worker thread

- **GIVEN** the caller thread has populated MDC with `request.id` and `user.id`
- **WHEN** the caller submits a task to a `ThreadPoolTaskExecutor` whose `taskDecorator` is the new decorator
- **THEN** during task execution the worker thread's MDC contains the same `request.id` and `user.id` values as the caller
- **AND** a log statement emitted from the worker thread carries those values in its rendered ECS JSON output

#### Scenario: Worker thread MDC is empty after the task completes

- **GIVEN** a `ThreadPoolTaskExecutor` wired with the decorator has executed a task with non-empty MDC propagated from the caller
- **WHEN** the task completes (normally or by throwing)
- **THEN** the worker thread's MDC is empty
- **AND** a subsequent task submitted to the same worker thread observes an empty MDC at start unless its own caller had MDC populated at submit time

#### Scenario: Caller thread MDC is unaffected by submission

- **GIVEN** the caller thread has populated MDC with `request.id` and `user.id`
- **WHEN** the caller submits one or more tasks via an executor wired with the decorator
- **THEN** the caller thread's MDC values remain unchanged before, during, and after submission, including after the worker tasks complete

#### Scenario: Decorator is a building block, not an active bean

- **WHEN** the application context starts at the time this change lands
- **THEN** no production `Executor`, `TaskExecutor`, or `@EnableAsync` configuration is introduced or modified by this change
- **AND** the decorator class exists in the observability package available for future features to wire when they introduce an executor

#### Scenario: Package-level note documents the requirement

- **WHEN** a contributor reads the observability package's class-level documentation (either `package-info.java` or the Javadoc of a chosen existing class in that package)
- **THEN** they encounter a note stating that any new `Executor` / `TaskExecutor` / `@Async` configuration must wire the MDC decorator
- **AND** the note explains the consequence (request-scoped MDC keys disappear from worker-thread logs)
