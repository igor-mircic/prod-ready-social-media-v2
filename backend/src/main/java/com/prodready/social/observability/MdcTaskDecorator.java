package com.prodready.social.observability;

import java.util.Map;
import org.slf4j.MDC;
import org.springframework.core.task.TaskDecorator;

/**
 * Carries the caller thread's SLF4J MDC snapshot onto the worker thread for the duration of a
 * submitted task, then clears the worker's MDC in a {@code finally} block.
 *
 * <p>Wire this onto any {@code Executor} / {@code TaskExecutor} / {@code @Async} bean that should
 * preserve request-scoped MDC keys (notably {@code request.id} and {@code user.id}) on worker-
 * thread log lines. The OpenTelemetry java agent propagates {@code trace.id} / {@code span.id}
 * across thread hops; application MDC keys are not part of that propagation and disappear from
 * worker-thread logs without this decorator.
 *
 * <p>This is a building block: it is intentionally not auto-registered on any executor and the
 * codebase intentionally does not register an executor at all today. The first feature to introduce
 * an executor is responsible for wiring this decorator.
 */
public class MdcTaskDecorator implements TaskDecorator {

  @Override
  public Runnable decorate(Runnable runnable) {
    Map<String, String> snapshot = MDC.getCopyOfContextMap();
    return () -> {
      if (snapshot != null) {
        MDC.setContextMap(snapshot);
      }
      try {
        runnable.run();
      } finally {
        // clear() (not save-and-restore the previous map): Spring's TaskExecutor invariant is
        // that pool workers do not own standalone MDC between submit/run cycles; a future
        // "save-and-restore" rewrite would silently re-enable leakage whenever the next caller
        // submits with an empty MDC (snapshot == null → setContextMap skipped → worker inherits
        // the previous task's MDC).
        MDC.clear();
      }
    };
  }
}
