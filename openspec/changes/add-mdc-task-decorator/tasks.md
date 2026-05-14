## 1. Decorator

- [x] 1.1 Create `backend/src/main/java/com/prodready/social/observability/MdcTaskDecorator.java` implementing `org.springframework.core.task.TaskDecorator`. On submit, capture `MDC.getCopyOfContextMap()` (defensive copy from caller). Return a `Runnable` that, on the worker, calls `MDC.setContextMap(snapshot)` if non-null, runs the wrapped task, then calls `MDC.clear()` in `finally`.
- [x] 1.2 Add a one-line comment in the decorator explaining why `clear()` is correct here (pool-thread invariant: workers don't own standalone MDC between submit/run cycles; a future "save-and-restore the previous map" rewrite would silently re-enable leakage when consecutive callers have empty MDC).
- [x] 1.3 Decide `public` vs package-private for `MdcTaskDecorator` (design.md *Open Questions* — default `public`).
- [x] 1.4 Match existing observability-package code style (Spring Boot 4, `com.prodready.social.observability` package, formatter as used by surrounding classes — see `RequestIdFilter.java`, `UserContextLogFilter.java`, `EcsTraceFieldsCustomizer.java`).

## 2. Package-level note for future contributors

- [x] 2.1 Place a note in the observability package — either a new `package-info.java` in `com.prodready.social.observability` or a paragraph appended to the class-level Javadoc of `RequestIdFilter`. Implementer chooses; pick the location that puts the note in a developer's field of view when they're editing this package.
- [x] 2.2 Note text must state both the rule ("any new `Executor` / `TaskExecutor` / `@Async` bean must wire `MdcTaskDecorator`") and the consequence ("request-scoped MDC keys — `request.id`, `user.id` — disappear from worker-thread log lines because they are not propagated by the OpenTelemetry java agent the way `trace.id` / `span.id` are").

## 3. Smoke test

- [x] 3.1 Create `backend/src/test/java/com/prodready/social/observability/MdcTaskDecoratorTest.java` (or `MdcTaskDecoratorIT.java` to match the `*IT.java` naming used by other observability tests — pick the name consistent with the rest of the package).
- [x] 3.2 Reuse the in-memory Logback appender pattern from `StructuredLoggingIT` to capture log lines emitted from the worker thread (factor inline; do not extract a shared helper as part of this change).
- [x] 3.3 Instantiate a real `ThreadPoolTaskExecutor`, call `setTaskDecorator(new MdcTaskDecorator())`, initialize it. Do not register it as a Spring bean — the production code does not register an executor and the test should not either.
- [x] 3.4 Scenario *Decorator carries caller MDC onto the worker thread*: populate MDC on the test (caller) thread with `request.id` and `user.id`, submit a task that calls `log.info(...)`, await completion, assert the captured log line carries both values as ECS fields.
- [x] 3.5 In the same task, also capture the worker thread's `MDC.getCopyOfContextMap()` at log-emit time and assert it equals the caller's snapshot — guards against future regressions that affect MDC programmatic state without affecting rendered output.
- [x] 3.6 Scenario *Worker thread MDC is empty after the task completes*: after the first task completes, submit a second task on the same executor with the caller's MDC cleared. The second task captures the worker's MDC at start; assert it is empty (proves cleanup in `finally`, and proves the worker did not retain the first task's MDC across the gap).
- [x] 3.7 Scenario *Caller thread MDC is unaffected by submission*: after submitting and awaiting the first task, assert the test (caller) thread's MDC still contains the original `request.id` and `user.id`.
- [x] 3.8 Optional but recommended (design.md *Open Questions*): a sub-scenario where the caller submits with an empty MDC; assert the worker observes an empty MDC and no NPE is thrown.

## 4. Verify and check in

- [x] 4.1 Confirm no production wiring change: no new `@EnableAsync`, no new `Executor` / `TaskExecutor` bean, no change to any existing `@Configuration` class.
- [x] 4.2 Build and run the backend test suite locally (`./gradlew :backend:test` or the project's standard invocation) and confirm the new test passes and no existing tests regress.
- [x] 4.3 Run `openspec validate add-mdc-task-decorator --strict` and resolve any findings.
- [ ] 4.4 Commit on a branch named after the change ID (`add-mdc-task-decorator`); push and open PR per project workflow.
- [ ] 4.5 After archive, update memory note `project_async_mdc_gap.md` to reflect that the gap is now closed for executors that wire this decorator (the latent gap is no longer latent — it is gated by per-executor wiring discipline).
