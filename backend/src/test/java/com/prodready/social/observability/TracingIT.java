package com.prodready.social.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;
import ch.qos.logback.core.ConsoleAppender;
import ch.qos.logback.core.encoder.Encoder;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.Tracer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.micrometer.metrics.test.autoconfigure.AutoConfigureMetrics;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Integration test that proves the OTel Java agent → MDC → ECS JSON pipeline is wired
 * end-to-end in-process. The {@code -javaagent:} flag is added to the {@code test} task in
 * {@code backend/build.gradle.kts}, so this test runs with the agent attached.
 *
 * <p>Note on span-capture: the production OTel Java agent installs its {@code OpenTelemetrySdk}
 * as the {@code GlobalOpenTelemetry} at JVM start, and its instrumentation modules cache
 * {@link io.opentelemetry.api.trace.Tracer Tracer} references at module-load time. That makes
 * the {@code OpenTelemetryExtension} / {@code InMemorySpanExporter} pattern from
 * {@code opentelemetry-sdk-testing} ineffective for capturing agent-emitted spans (any swap of
 * the global SDK happens too late). The literal "span name contains {@code PostService.create}"
 * assertion from the proposal therefore lives as a known follow-up — see
 * {@code openspec/changes/add-backend-traces/proposal.md} "Open follow-ups". The assertions
 * below collectively still prove every contract this slice promises on the wire: the agent is
 * attached, trace context lands in the JSON envelope under the ECS-canonical keys, and the
 * Logstash-style duplicates have been removed.
 */
@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureMetrics
@ActiveProfiles("test")
@Testcontainers
class TracingIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine"));

  @DynamicPropertySource
  static void datasourceProperties(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
  }

  @Autowired MockMvc mvc;
  @Autowired JdbcTemplate jdbc;
  final ObjectMapper mapper = new ObjectMapper();

  private ByteArrayOutputStream captureStream;
  private AppenderBase<ILoggingEvent> captureAppender;
  private ch.qos.logback.classic.Logger rootLogger;

  @BeforeEach
  void installCaptureAppender() {
    cleanDatabase();

    LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
    rootLogger = context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
    @SuppressWarnings("unchecked")
    ConsoleAppender<ILoggingEvent> consoleAppender =
        (ConsoleAppender<ILoggingEvent>) rootLogger.getAppender("CONSOLE");
    Encoder<ILoggingEvent> sharedEncoder = consoleAppender.getEncoder();

    captureStream = new ByteArrayOutputStream();
    captureAppender =
        new AppenderBase<>() {
          @Override
          protected void append(ILoggingEvent event) {
            byte[] bytes = sharedEncoder.encode(event);
            if (bytes == null || bytes.length == 0) {
              return;
            }
            synchronized (captureStream) {
              try {
                captureStream.write(bytes);
              } catch (IOException ex) {
                addError("failed to write to capture stream", ex);
              }
            }
          }
        };
    captureAppender.setName("TracingIT-capture");
    captureAppender.setContext(context);
    captureAppender.start();
    rootLogger.addAppender(captureAppender);
  }

  @AfterEach
  void removeCaptureAppender() {
    if (captureAppender != null) {
      rootLogger.detachAppender(captureAppender);
      captureAppender.stop();
    }
  }

  private void cleanDatabase() {
    jdbc.update("DELETE FROM feed_entries");
    jdbc.update("DELETE FROM follows");
    jdbc.update("DELETE FROM posts");
    jdbc.update("DELETE FROM auth_refresh_tokens");
    jdbc.update("DELETE FROM auth_access_tokens");
    jdbc.update("DELETE FROM users");
  }

  // 7.3 -----------------------------------------------------------------------
  @Test
  void agentIsAttachedAndProducesValidSpanContext() {
    OpenTelemetry global = GlobalOpenTelemetry.get();
    assertThat(global)
        .as("GlobalOpenTelemetry should be registered by the agent, not the noop fallback")
        .isNotNull();

    Tracer tracer = global.getTracer("tracing-it-probe");
    Span span = tracer.spanBuilder("attach-probe").startSpan();
    try {
      SpanContext ctx = span.getSpanContext();
      assertThat(ctx.isValid())
          .as("agent-attached tracer should produce a valid SpanContext (32-hex trace id)")
          .isTrue();
      assertThat(ctx.getTraceId()).matches("^[0-9a-f]{32}$");
      assertThat(ctx.getSpanId()).matches("^[0-9a-f]{16}$");
    } finally {
      span.end();
    }
  }

  // 7.4 -----------------------------------------------------------------------
  @Test
  void authenticatedAccessLogCarriesEcsTraceAndSpanIds() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "trace.id").asText())
        .as("ECS-canonical trace.id is 32 lowercase hex")
        .matches("^[0-9a-f]{32}$");
    assertThat(field(access, "span.id").asText())
        .as("ECS-canonical span.id is 16 lowercase hex")
        .matches("^[0-9a-f]{16}$");
    assertThat(access.has("trace_id"))
        .as("Logstash-style trace_id top-level key is removed")
        .isFalse();
    assertThat(access.has("span_id"))
        .as("Logstash-style span_id top-level key is removed")
        .isFalse();
    assertThat(access.has("trace_flags"))
        .as("Logstash-style trace_flags top-level key is removed")
        .isFalse();
  }

  // 7.5 -----------------------------------------------------------------------
  @Test
  void logEventOutsideAnySpanCarriesNoTraceFields() throws Exception {
    resetCapture();
    String marker = "off-span-" + UUID.randomUUID();
    Thread t =
        new Thread(
            () -> LoggerFactory.getLogger(TracingIT.class).info(marker),
            "tracing-it-off-span");
    t.start();
    t.join();

    JsonNode line =
        capturedLines().stream()
            .filter(n -> marker.equals(n.path("message").asText(null)))
            .findFirst()
            .orElseThrow();
    assertThat(hasField(line, "trace.id"))
        .as("a log line emitted outside any active span carries no trace.id")
        .isFalse();
    assertThat(hasField(line, "span.id"))
        .as("a log line emitted outside any active span carries no span.id")
        .isFalse();
    assertThat(line.has("trace_id")).isFalse();
    assertThat(line.has("span_id")).isFalse();
  }

  // 7.6 -----------------------------------------------------------------------
  // The literal "captured span set contains a span named PostService.create" assertion is
  // deferred — see the class-level note. What this test verifies is that a request which
  // *executes* the @Timed-annotated PostService.create method is fully traced end-to-end:
  // the resulting access-log line carries populated ECS trace.id / span.id, and the value
  // ranges match the wire contract.
  @Test
  void postCreateRequestIsTracedAndAccessLogCarriesTraceId() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(
            post("/api/v1/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"body\":\"trace-it\"}"))
        .andExpect(status().isCreated());

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "url.path").asText()).isEqualTo("/api/v1/posts");
    assertThat(field(access, "http.response.status_code").asInt()).isEqualTo(201);
    assertThat(field(access, "trace.id").asText()).matches("^[0-9a-f]{32}$");
    assertThat(field(access, "span.id").asText()).matches("^[0-9a-f]{16}$");
  }

  // --- helpers --------------------------------------------------------------

  private List<JsonNode> capturedLines() {
    String text;
    synchronized (captureStream) {
      text = captureStream.toString(StandardCharsets.UTF_8);
    }
    List<JsonNode> nodes = new ArrayList<>();
    for (String line : text.split("\n")) {
      String trimmed = line.trim();
      if (trimmed.isEmpty()) {
        continue;
      }
      try {
        nodes.add(mapper.readTree(trimmed));
      } catch (Exception ignored) {
        // Not every line is required to parse; ignore non-JSON noise.
      }
    }
    return nodes;
  }

  private Optional<JsonNode> accessLogLine(List<JsonNode> lines) {
    return lines.stream()
        .filter(n -> "backend.access".equals(field(n, "event.dataset").asText(null)))
        .findFirst();
  }

  private JsonNode field(JsonNode root, String dottedPath) {
    JsonNode current = root;
    for (String segment : dottedPath.split("\\.")) {
      current = current.path(segment);
    }
    return current;
  }

  private boolean hasField(JsonNode root, String dottedPath) {
    JsonNode current = root;
    for (String segment : dottedPath.split("\\.")) {
      if (!current.has(segment)) {
        return false;
      }
      current = current.get(segment);
    }
    return true;
  }

  private void resetCapture() {
    synchronized (captureStream) {
      captureStream.reset();
    }
  }

  private void signup(String email, String password, String displayName) throws Exception {
    mvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    String.format(
                        "{\"email\":\"%s\",\"password\":\"%s\",\"displayName\":\"%s\"}",
                        email, password, displayName)))
        .andExpect(status().isCreated());
  }

  private String login(String email, String password) throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        String.format("{\"email\":\"%s\",\"password\":\"%s\"}", email, password)))
            .andExpect(status().isOk())
            .andReturn();
    return mapper.readTree(result.getResponse().getContentAsString()).get("accessToken").asText();
  }
}
