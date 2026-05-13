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
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
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

@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureMetrics
@ActiveProfiles("test")
@Testcontainers
class StructuredLoggingIT {

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

  // We attach a programmatic appender to the root logger that shares the same encoder
  // as Spring Boot's wired CONSOLE appender (StructuredLogEncoder configured for ECS).
  // This captures the actual JSON bytes the application emits, deterministically and
  // without depending on System.out redirection (which Logback's ConsoleAppender does
  // not pick up after start()).
  private ByteArrayOutputStream captureStream;
  private AppenderBase<ILoggingEvent> captureAppender;
  private ch.qos.logback.classic.Logger rootLogger;

  @BeforeEach
  void installCaptureAppender() {
    cleanDatabase();

    LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
    rootLogger = context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
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
    captureAppender.setName("StructuredLoggingIT-capture");
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
        // Not every line is required to parse; ignore non-JSON noise if any sneaks in.
      }
    }
    return nodes;
  }

  private Optional<JsonNode> accessLogLine(List<JsonNode> lines) {
    return lines.stream()
        .filter(n -> "backend.access".equals(field(n, "event.dataset").asText(null)))
        .findFirst();
  }

  /**
   * Walks a dotted path against the captured ECS JSON, which nests keys (e.g. MDC {@code
   * "request.id"} becomes {@code "request":{"id":"..."}}). Returns a missing node when any segment
   * is absent.
   */
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

  private String signup(String email, String password, String displayName) throws Exception {
    mvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    String.format(
                        "{\"email\":\"%s\",\"password\":\"%s\",\"displayName\":\"%s\"}",
                        email, password, displayName)))
        .andExpect(status().isCreated());
    return jdbc.queryForObject("SELECT id FROM users WHERE email = ?", String.class, email);
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

  // 7.3 -----------------------------------------------------------------------
  @Test
  void everyLineIsJsonWithBaseEcsFields() throws Exception {
    resetCapture();
    LoggerFactory.getLogger(getClass()).info("smoke");

    List<JsonNode> lines = capturedLines();
    Optional<JsonNode> smoke =
        lines.stream().filter(n -> "smoke".equals(n.path("message").asText(null))).findFirst();
    assertThat(smoke).as("smoke line in captured stdout").isPresent();
    JsonNode line = smoke.orElseThrow();
    assertThat(line.path("@timestamp").asText()).isNotBlank();
    assertThat(field(line, "log.level").asText()).isEqualTo("INFO");
    assertThat(field(line, "service.name").asText()).isEqualTo("backend");
    assertThat(field(line, "service.environment").asText()).isEqualTo("local");
    assertThat(field(line, "process.thread.name").asText()).isNotBlank();
    assertThat(field(line, "log.logger").asText()).isNotBlank();
    assertThat(field(line, "ecs.version").asText()).isNotBlank();
  }

  // 7.4 -----------------------------------------------------------------------
  @Test
  void authenticatedControllerCallEmitsAccessLogLine() throws Exception {
    String aliceId = signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "http.request.method").asText()).isEqualTo("GET");
    assertThat(field(access, "url.path").asText()).isEqualTo("/api/v1/auth/me");
    assertThat(field(access, "http.response.status_code").asInt()).isEqualTo(200);
    assertThat(field(access, "event.duration").asLong()).isPositive();
    assertThat(access.path("duration_ms").isNumber()).isTrue();
    assertThat(access.path("duration_ms").asLong()).isGreaterThanOrEqualTo(0L);
    assertThat(field(access, "user.id").asText()).isEqualTo(aliceId);
    assertThat(field(access, "request.id").asText()).isNotBlank();
  }

  // 7.5 -----------------------------------------------------------------------
  @Test
  void urlPathFieldIsRouteTemplateNotResolvedPath() throws Exception {
    String aliceId = signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(
            post("/api/v1/users/" + aliceId + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().is4xxClientError()); // self-follow → 4xx; status is incidental.

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "url.path").asText()).isEqualTo("/api/v1/users/{userId}/follow");
    assertThat(field(access, "url.path").asText()).doesNotContain(aliceId);
  }

  // 7.6 -----------------------------------------------------------------------
  @Test
  void anonymousProtectedRouteEmits401WithoutUserId() throws Exception {
    resetCapture();
    mvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized());

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "http.response.status_code").asInt()).isEqualTo(401);
    assertThat(field(access, "request.id").asText()).isNotBlank();
    assertThat(hasField(access, "user.id")).isFalse();
  }

  // 7.7 -----------------------------------------------------------------------
  @Test
  void actuatorPrometheusIsNotAccessLogged() throws Exception {
    resetCapture();
    mvc.perform(get("/actuator/prometheus")).andExpect(status().isOk());

    assertThat(accessLogLine(capturedLines())).isEmpty();
  }

  // 7.8 -----------------------------------------------------------------------
  @Test
  void responseHeaderMatchesRequestIdField() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    MvcResult result =
        mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
            .andExpect(status().isOk())
            .andReturn();
    String header = result.getResponse().getHeader(AccessLogMarkers.HEADER_REQUEST_ID);
    assertThat(header).isNotBlank();

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "request.id").asText()).isEqualTo(header);
  }

  // 7.9 -----------------------------------------------------------------------
  @Test
  void inboundRequestIdHeaderIsHonoured() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");
    String supplied = "client-supplied-abc";

    resetCapture();
    MvcResult result =
        mvc.perform(
                get("/api/v1/auth/me")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                    .header(AccessLogMarkers.HEADER_REQUEST_ID, supplied))
            .andExpect(status().isOk())
            .andReturn();
    assertThat(result.getResponse().getHeader(AccessLogMarkers.HEADER_REQUEST_ID))
        .isEqualTo(supplied);

    JsonNode access = accessLogLine(capturedLines()).orElseThrow();
    assertThat(field(access, "request.id").asText()).isEqualTo(supplied);
  }

  // 7.10 ----------------------------------------------------------------------
  @Test
  void mdcIsClearedBetweenRequests() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    // Log directly from the JUnit test thread (not a Tomcat worker). After the request,
    // MDC on this thread should carry no request.id or user.id leakage.
    Logger testLogger = LoggerFactory.getLogger(getClass());
    testLogger.info("between");

    JsonNode between =
        capturedLines().stream()
            .filter(n -> "between".equals(n.path("message").asText(null)))
            .findFirst()
            .orElseThrow();
    assertThat(hasField(between, "request.id")).isFalse();
    assertThat(hasField(between, "user.id")).isFalse();
  }
}
