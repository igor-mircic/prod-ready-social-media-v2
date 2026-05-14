## Context

The backend's observability stack populates two application-managed MDC keys on every HTTP request:

- `request.id` (set by `RequestIdFilter`, mirrored to the `X-Request-Id` response header)
- `user.id` (set by `UserContextLogFilter` after authentication resolves)

These keys ride on the request thread via SLF4J's MDC, which is backed by a `ThreadLocal`. Every log line emitted on that thread carries them.

A separate concern — `trace.id` / `span.id` — is populated by the OpenTelemetry java agent's Logback instrumentation. Because the agent also instruments thread boundaries (executors, `CompletableFuture`, Kafka clients, JDBC, etc.) to carry the OTel `Context`, trace IDs survive thread hops. Application MDC keys do not: anything written via `MDC.put` is invisible to that propagation machinery.

There is no `@Async`, no `Executor`, no `CompletableFuture.*Async`, and no Spring task scheduling in `backend/src/main` today. The gap is latent. The realistic near-future trigger is moving feed fanout-on-write off the request thread, at which point the first worker-thread `log.info(...)` will produce a line with `trace.id` and `span.id` but no `request.id` or `user.id`, silently degrading log correlation in exactly the queries operators run most often.

## Goals / Non-Goals

**Goals:**

- Land a reusable, minimal building block (a Spring `TaskDecorator`) that propagates the caller's MDC snapshot onto a worker thread for the duration of a submitted task and cleans up after.
- Prove the building block works end-to-end with a smoke test that exercises a real `ThreadPoolTaskExecutor` and captures worker-thread log output via the existing in-memory Logback appender pattern used in `StructuredLoggingIT`.
- Document the constraint at code level so the first contributor to introduce an executor encounters the expectation in the same package they're working in.

**Non-Goals:**

- Pre-wiring any executor or `@EnableAsync` configuration. No async feature exists yet; speculatively registering executors invites premature design choices on pool sizing, queue policy, rejection handling.
- Enforcing decorator usage via static analysis (ArchUnit or similar). See *Decision 3*.
- Switching `request.id` / `user.id` to OpenTelemetry Baggage. See *Decision 2*.
- Deprecating `request.id` in favour of `trace.id`. They serve different audiences: `X-Request-Id` is client-facing (echoed in response headers, surfaced in error responses for bug reports); `trace.id` is operator-facing (correlated to spans in the tracing backend).

## Decisions

### Decision 1: `TaskDecorator` with snapshot-and-clear semantics

**What:** Implement Spring's `org.springframework.core.task.TaskDecorator`. On submit, capture `MDC.getCopyOfContextMap()` (a defensive copy from the caller thread). On worker, install the snapshot via `MDC.setContextMap(snapshot)` if non-null, run the wrapped `Runnable`, then call `MDC.clear()` in `finally`.

**Why `clear()` instead of save-the-previous-and-restore:** A pool worker thread, by the invariant Spring's `TaskExecutor` model imposes, has no business carrying MDC state between unrelated submitted tasks — workers don't own standalone MDC outside the lifetime of a submit/run cycle. Clearing is therefore equivalent to restoring "the previous (empty) map" in the cases that actually occur, with less code and no risk of carrying stale state if a previous task forgot to clean up. The implementation MUST carry a one-line comment explaining this invariant so a future reader doesn't second-guess and "improve" it to a save/restore pattern that subtly leaks state.

**Alternatives considered:**

- *Save-and-restore the previous MDC.* Strictly more general; correct for cases where a worker thread holds standalone MDC outside the submit/run cycle. Not applicable here. Adds two extra lines and a `Map` allocation per task for no observable benefit.
- *Don't clear, trust the next task to overwrite.* Wrong: if the next task is submitted by a caller whose MDC is empty (e.g. a `@Scheduled` job thread, a non-HTTP entry point), the snapshot is `null`, the decorator skips `setContextMap`, and the worker would inherit the previous task's MDC — exactly the leakage this change exists to prevent.

### Decision 2: Stay on MDC, do not move to OpenTelemetry Baggage

**What:** Keep `request.id` and `user.id` set via `MDC.put` in servlet filters. Do not migrate to `Baggage.current().toBuilder().put(...)`.

**Why:** OTel Baggage rides with the OTel `Context` that the java agent already propagates across thread boundaries, which would solve the cross-thread problem "for free" — but baggage also propagates over the wire by default (W3C `baggage` header on outbound HTTP). That means `user.id` would be sent to every upstream service the backend calls, including third parties. Mitigating that requires either an allowlist on the baggage propagator or marking entries non-propagating via `BaggageEntryMetadata`. Both are workable but add design surface and a new failure mode (an entry tagged non-propagating today might be retagged later by a contributor who doesn't realize the original intent).

For a *preventative* change against a latent problem, the smaller, in-process-only solution (TaskDecorator) is the right call. If a future change brings cross-service `user.id` propagation as an actual requirement, baggage can be revisited then with that requirement front-and-center.

**Alternatives considered:**

- *Hybrid: keep MDC, also publish to baggage for future cross-thread cases.* Doubles the source of truth, doubles the chance of drift (filter updates MDC but not baggage, or vice versa). Rejected.

### Decision 3: No ArchUnit (or other static) enforcement

**What:** Do not add a static-analysis rule that fails the build when an `Executor`, `TaskExecutor`, `@Async`, or `CompletableFuture.*Async` appears without going through this decorator.

**Why:** The project has no ArchUnit dependency today, no other static-architecture rule, and one file plus one inline note will not get past code review on the PR that introduces the first executor — that's a high-attention diff. Adding a static rule for one expected future PR is more weight than the problem. The class-level Javadoc note in the observability package surfaces the expectation at the point a contributor is most likely to read it (the same package as `RequestIdFilter` and `UserContextLogFilter`).

**Alternatives considered:**

- *Add ArchUnit and a rule banning raw executor types outside a sanctioned factory.* Justifiable in a larger codebase or with more contributors. Re-evaluate if the project grows.
- *Test-only fitness function (e.g. classpath scan for `@Async` annotations and verify their associated `TaskExecutor` bean has the decorator wired).* Hard to write correctly; couples the test to bean-wiring conventions that don't yet exist. Defer.

### Decision 4: Test wires a real `ThreadPoolTaskExecutor`, not a synchronous stub

**What:** The smoke test instantiates a `ThreadPoolTaskExecutor`, sets the decorator on it, populates MDC on the test (caller) thread, submits a task that emits a log statement, awaits completion, and asserts on the captured log output via the same in-memory Logback appender pattern that `StructuredLoggingIT` already uses.

**Why:** A synchronous stub that just invokes `runnable.run()` on the caller thread would not exercise the actual cross-thread mechanic. Using a real pooled executor ensures the test fails the day someone subtly breaks the `getCopyOfContextMap` → `setContextMap` round-trip (e.g. accidentally passing the original map by reference and mutating it, or skipping the null check and NPE-ing on a caller with an empty MDC).

**Alternatives considered:**

- *Integration test via `@SpringBootTest` with a registered executor bean.* Heavier; we deliberately do not register an executor bean in production, so a Spring-context-aware test would be unrepresentative.
- *Inspect MDC state on the worker via the worker's own callback rather than the rendered log line.* Less faithful: the value of the change is that *log lines* carry the keys. The test should assert against the actual rendered output. (We can additionally assert programmatic MDC state on the worker before the task returns — cheap, and catches at least one failure mode the log-line check would not.)

### Decision 5: Note location — `package-info.java` vs existing-class Javadoc

**What:** The note for future contributors lands as either a small `package-info.java` in `com.prodready.social.observability` or as a paragraph appended to the class-level Javadoc of `RequestIdFilter` (which already documents how `request.id` MDC is populated and cleared). Either is acceptable; implementer chooses, but the chosen location MUST be where a developer reading the observability package's source will encounter it. The note text MUST mention both the rule ("wire the decorator on any new executor") and the consequence ("or request-scoped MDC keys disappear from worker-thread logs").

**Why:** The note exists to short-circuit a specific moment — a contributor is about to add `@EnableAsync` or `new ThreadPoolTaskExecutor()` and hasn't thought about MDC. The note is most useful when it's already in their field of view, hence the same package. We do not bake it into a README, where it would be invisible during the change that needs it.

## Risks / Trade-offs

- *A future contributor introduces an executor and forgets to wire the decorator.* → Mitigations: (a) class-level note in the same package, (b) PR review (the diff that introduces an executor is high-attention by nature), (c) revisit static enforcement if the codebase grows enough that PR review is no longer reliable.
- *A future contributor wires the decorator onto an executor that legitimately maintains standalone MDC on its worker threads.* This is essentially never the case for Spring's `TaskExecutor` usages but is theoretically possible (e.g. a custom executor whose worker threads also do other work outside submitted tasks). → Mitigation: the inline comment explaining the pool-thread invariant flags this for the reader; if the assumption ever doesn't hold, switching to save-and-restore is a one-line change.
- *Baggage decision ages poorly.* If cross-service `user.id` propagation later becomes a real requirement, the team will revisit this. → Mitigation: this design document captures the rationale so a future change can argue against it concretely rather than re-derive the trade-offs from scratch.
- *Test relies on the existing in-memory Logback appender pattern, which is `StructuredLoggingIT`-specific glue.* If that test class is restructured later, the new test's helpers may need to follow. → Mitigation: factor only what's needed inline; do not extract a shared helper module as part of this change (premature abstraction).

## Migration Plan

No production wiring changes, no public API changes, no data migration, no rollback concern. The change is additive: a new class plus a new test plus a one-paragraph note. Merging it has zero runtime effect on the deployed application until a separate future change wires the decorator onto an actual executor.

## Open Questions

- Should the smoke test additionally cover `MDC.getCopyOfContextMap()` returning `null` (the documented behaviour when the caller thread has no MDC)? Adding a sub-scenario for "caller has empty MDC → worker sees empty MDC, no NPE" is low cost and would prevent a regression in the null-handling branch. Implementer should include this scenario unless it bloats the test materially.
- Should `MdcTaskDecorator` be `public` or package-private? It's a building block other packages will import when they introduce an executor. Default to `public`. Implementer may keep it package-private if that's more consistent with surrounding observability classes; revisit when the first non-observability package wants to use it.
