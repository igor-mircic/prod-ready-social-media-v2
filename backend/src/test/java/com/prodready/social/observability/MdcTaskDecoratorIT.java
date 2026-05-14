package com.prodready.social.observability;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

class MdcTaskDecoratorIT {

  private static final Logger LOG = LoggerFactory.getLogger(MdcTaskDecoratorIT.class);

  // Programmatic appender attached to the root logger that captures the raw
  // ILoggingEvent at emit time. This is the in-memory-appender pattern from
  // StructuredLoggingIT, factored inline (per task 3.2). We assert on
  // ILoggingEvent.getMDCPropertyMap() — the map the ECS structured-log
  // encoder reads from to render request.id / user.id as nested ECS
  // members. Encoder behaviour itself is covered by StructuredLoggingIT.
  private List<ILoggingEvent> capturedEvents;
  private AppenderBase<ILoggingEvent> captureAppender;
  private ch.qos.logback.classic.Logger rootLogger;

  @BeforeEach
  void installCaptureAppender() {
    LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
    rootLogger = context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
    capturedEvents = Collections.synchronizedList(new ArrayList<>());
    captureAppender =
        new AppenderBase<>() {
          @Override
          protected void append(ILoggingEvent event) {
            capturedEvents.add(event);
          }
        };
    captureAppender.setName("MdcTaskDecoratorIT-capture");
    captureAppender.setContext(context);
    captureAppender.start();
    rootLogger.addAppender(captureAppender);
    MDC.clear();
  }

  @AfterEach
  void removeCaptureAppender() {
    if (captureAppender != null) {
      rootLogger.detachAppender(captureAppender);
      captureAppender.stop();
    }
    MDC.clear();
  }

  private ThreadPoolTaskExecutor newDecoratedExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(1);
    executor.setMaxPoolSize(1);
    executor.setQueueCapacity(10);
    executor.setTaskDecorator(new MdcTaskDecorator());
    executor.initialize();
    return executor;
  }

  @Test
  void carriesCallerMdcOntoWorkerThread() throws Exception {
    ThreadPoolTaskExecutor executor = newDecoratedExecutor();
    try {
      MDC.put(AccessLogMarkers.MDC_REQUEST_ID, "req-abc");
      MDC.put(AccessLogMarkers.MDC_USER_ID, "user-42");

      AtomicReference<Map<String, String>> workerSnapshot = new AtomicReference<>();
      CountDownLatch done = new CountDownLatch(1);
      executor.submit(
          () -> {
            // Capture programmatic MDC state at log-emit time. Guards against
            // future regressions that change MDC programmatic state without
            // affecting rendered output (task 3.5).
            Map<String, String> seen = MDC.getCopyOfContextMap();
            workerSnapshot.set(seen != null ? new HashMap<>(seen) : new HashMap<>());
            LOG.info("worker-emitted");
            done.countDown();
          });
      assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();

      ILoggingEvent event = findEvent("worker-emitted");
      Map<String, String> eventMdc = event.getMDCPropertyMap();
      assertThat(eventMdc).containsEntry(AccessLogMarkers.MDC_REQUEST_ID, "req-abc");
      assertThat(eventMdc).containsEntry(AccessLogMarkers.MDC_USER_ID, "user-42");

      Map<String, String> expectedCallerSnapshot =
          Map.of(
              AccessLogMarkers.MDC_REQUEST_ID, "req-abc",
              AccessLogMarkers.MDC_USER_ID, "user-42");
      assertThat(workerSnapshot.get()).isEqualTo(expectedCallerSnapshot);

      // Caller thread MDC is unaffected by submission (task 3.7).
      assertThat(MDC.get(AccessLogMarkers.MDC_REQUEST_ID)).isEqualTo("req-abc");
      assertThat(MDC.get(AccessLogMarkers.MDC_USER_ID)).isEqualTo("user-42");
    } finally {
      executor.shutdown();
    }
  }

  @Test
  void workerMdcIsEmptyOnNextTaskWhenCallerMdcIsEmpty() throws Exception {
    ThreadPoolTaskExecutor executor = newDecoratedExecutor();
    try {
      // First task: caller has MDC populated.
      MDC.put(AccessLogMarkers.MDC_REQUEST_ID, "req-first");
      MDC.put(AccessLogMarkers.MDC_USER_ID, "user-first");
      CountDownLatch first = new CountDownLatch(1);
      executor.submit(
          () -> {
            LOG.info("first-task");
            first.countDown();
          });
      assertThat(first.await(5, TimeUnit.SECONDS)).isTrue();

      // Second task: caller MDC cleared. Same single-thread executor, so the
      // worker thread is the same one that ran the first task. The decorator's
      // finally clause must have cleared MDC after task 1 — and because task 2's
      // snapshot is empty/null (caller MDC cleared), setContextMap is skipped,
      // so the worker observes empty MDC at start (task 3.6).
      MDC.clear();
      AtomicReference<Map<String, String>> workerSnapshot = new AtomicReference<>();
      CountDownLatch second = new CountDownLatch(1);
      executor.submit(
          () -> {
            Map<String, String> seen = MDC.getCopyOfContextMap();
            workerSnapshot.set(seen != null ? new HashMap<>(seen) : new HashMap<>());
            LOG.info("second-task");
            second.countDown();
          });
      assertThat(second.await(5, TimeUnit.SECONDS)).isTrue();

      assertThat(workerSnapshot.get()).isEmpty();
      ILoggingEvent secondEvent = findEvent("second-task");
      assertThat(secondEvent.getMDCPropertyMap())
          .doesNotContainKey(AccessLogMarkers.MDC_REQUEST_ID)
          .doesNotContainKey(AccessLogMarkers.MDC_USER_ID);
    } finally {
      executor.shutdown();
    }
  }

  @Test
  void emptyCallerMdcProducesEmptyWorkerMdcAndNoNpe() throws Exception {
    ThreadPoolTaskExecutor executor = newDecoratedExecutor();
    try {
      MDC.clear();

      AtomicReference<Map<String, String>> workerSnapshot = new AtomicReference<>();
      AtomicReference<Throwable> workerError = new AtomicReference<>();
      CountDownLatch done = new CountDownLatch(1);
      executor.submit(
          () -> {
            try {
              Map<String, String> seen = MDC.getCopyOfContextMap();
              workerSnapshot.set(seen != null ? new HashMap<>(seen) : new HashMap<>());
            } catch (Throwable t) {
              workerError.set(t);
            } finally {
              done.countDown();
            }
          });
      assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();

      assertThat(workerError.get()).isNull();
      assertThat(workerSnapshot.get()).isEmpty();
    } finally {
      executor.shutdown();
    }
  }

  private ILoggingEvent findEvent(String message) {
    synchronized (capturedEvents) {
      return capturedEvents.stream()
          .filter(e -> message.equals(e.getFormattedMessage()))
          .findFirst()
          .orElseThrow(() -> new AssertionError("no captured event with message: " + message));
    }
  }
}
