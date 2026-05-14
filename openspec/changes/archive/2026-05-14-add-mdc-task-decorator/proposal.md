## Why

The backend populates `request.id` and `user.id` into SLF4J MDC via servlet filters so every log line on the request thread carries those correlation fields. MDC is thread-local: the day work hops to a worker thread (async fanout, `@Async`, `CompletableFuture.*Async`, `Executor.submit`), those keys silently disappear from worker-thread log lines. Only `trace.id` / `span.id` survive, because the OpenTelemetry java agent propagates the OTel context across thread boundaries; the application's MDC keys are not part of that propagation.

There is no async code in `backend/src/main` today, so the gap is latent. Async feed fanout is the likely future trigger (moving fanout-on-write off the request thread). This change lands the propagation pattern preventatively, as a reusable building block plus a regression test, so the first contributor to introduce an executor doesn't silently break log correlation. We are not pre-wiring any executor and not adding static enforcement; the file sits on the shelf until needed.

## What Changes

- Add `MdcTaskDecorator` in `com.prodready.social.observability` implementing Spring's `TaskDecorator`. Snapshots the caller's MDC on submit; restores it on the worker thread for the duration of the task; clears MDC on the worker in `finally` so no state leaks to the next task that pool thread runs.
- Add a smoke integration test that wires the decorator onto a `ThreadPoolTaskExecutor`, populates MDC on the caller, submits a task, and proves via the existing Logback in-memory appender pattern (see `StructuredLoggingIT`) that the worker-thread log line carries `request.id` and `user.id`. Also asserts worker-thread MDC is empty after the task completes.
- Add a brief code-level note in the observability package (alongside existing MDC filters) telling future readers: any new `Executor` / `TaskExecutor` / `@Async` bean must wire this decorator or request-scoped MDC keys will disappear from worker-thread logs.

Not in this change (documented in design.md):
- Pre-wiring any executor — no async feature exists yet. The decorator is a building block, not a registered bean.
- ArchUnit / static-analysis rule to enforce decorator usage on every executor. Project has no ArchUnit dependency; adding it just for this is heavier than the problem at current codebase size.
- Migrating `request.id` / `user.id` from MDC to OpenTelemetry Baggage. Baggage propagates over the wire by default, which would leak `user.id` to upstream services; the design surface is more than this preventative change warrants.
- Deprecating `request.id` in favour of `trace.id`. They serve different audiences (`X-Request-Id` is client/user-facing; `trace.id` is operator-facing).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `observability`: adds a new requirement that the codebase ships a Spring `TaskDecorator` capable of carrying MDC across thread boundaries, with a test that proves it works. Existing MDC filter requirements are unchanged.

## Impact

- New file: `backend/src/main/java/com/prodready/social/observability/MdcTaskDecorator.java` (~30 lines).
- New test: `backend/src/test/java/com/prodready/social/observability/MdcTaskDecoratorTest.java` (or `MdcTaskDecoratorIT.java`, matching the existing observability test naming).
- Small textual note in the observability package — either a one-paragraph addition to an existing class's docstring (e.g. `RequestIdFilter`) or a `package-info.java`.
- No production wiring changes. No new dependencies. No public API changes. No DB or infra changes.
- Memory follow-up after archive: `project_async_mdc_gap.md` should be updated to note that the decorator now exists; the gap is closed only for executors that wire it.
