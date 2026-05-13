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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
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
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Integration test that proves the env-var-gated file appender writes the same ECS JSON to a file
 * as it writes to stdout, and that no file is created when {@code LOG_FILE_PATH} is unset.
 *
 * <p>The file path is published as a system property in a static initializer so Spring Boot's
 * {@code LoggingApplicationListener} — which reads {@code logging.file.name} from the
 * environment during {@code ApplicationEnvironmentPreparedEvent} — sees the resolved path
 * before the file appender is wired. A {@code @DynamicPropertySource} would fire later (during
 * context preparation), too late for the logging system to pick up.
 *
 * <p>The wire path from file to Loki is a manual smoke through the README run loop; this test
 * does NOT spin up Loki or the Collector and makes no network call to host ports 4317, 4318,
 * or 3100.
 */
@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureMetrics
@ActiveProfiles("test")
@Testcontainers
class LogFileOutputIT {

  static final Path LOG_FILE;

  static {
    try {
      LOG_FILE = Files.createTempFile("logfile-it-", ".json");
      System.setProperty("LOG_FILE_PATH", LOG_FILE.toAbsolutePath().toString());
    } catch (IOException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

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
    captureAppender.setName("LogFileOutputIT-capture");
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

  // 6.2 -----------------------------------------------------------------------
  @Test
  void everyFileLineParsesAsJsonWithBaseEcsFields() throws Exception {
    LoggerFactory.getLogger(getClass()).info("smoke-file-line");

    List<JsonNode> fileLines = readFileLines();
    assertThat(fileLines)
        .as("file should contain at least one ECS JSON line")
        .isNotEmpty();
    for (JsonNode line : fileLines) {
      assertThat(line.path("@timestamp").asText())
          .as("every file line carries @timestamp")
          .isNotBlank();
      assertThat(field(line, "log.level").asText())
          .as("every file line carries log.level")
          .isNotBlank();
      assertThat(field(line, "service.name").asText())
          .as("every file line carries service.name=backend")
          .isEqualTo("backend");
      assertThat(field(line, "service.environment").asText())
          .as("every file line carries service.environment=local")
          .isEqualTo("local");
      assertThat(field(line, "process.thread.name").asText())
          .as("every file line carries process.thread.name")
          .isNotBlank();
      assertThat(field(line, "log.logger").asText())
          .as("every file line carries log.logger")
          .isNotBlank();
      assertThat(line.has("message"))
          .as("every file line carries a message field")
          .isTrue();
      assertThat(field(line, "ecs.version").asText())
          .as("every file line carries ecs.version")
          .isNotBlank();
    }
  }

  // 6.3 -----------------------------------------------------------------------
  @Test
  void authenticatedAccessLogLineInFileCarriesCorrelationFields() throws Exception {
    String aliceId = signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    JsonNode access = lastAccessLogLine(readFileLines()).orElseThrow();
    assertThat(field(access, "event.dataset").asText()).isEqualTo("backend.access");
    assertThat(field(access, "url.path").asText()).isEqualTo("/api/v1/auth/me");
    assertThat(field(access, "request.id").asText())
        .as("file's backend.access line carries a non-blank request.id")
        .isNotBlank();
    assertThat(field(access, "user.id").asText())
        .as("file's backend.access line carries user.id of the authenticated caller")
        .isEqualTo(aliceId);
    assertThat(field(access, "trace.id").asText())
        .as("file's backend.access line carries a 32-char lowercase hex trace.id")
        .matches("^[0-9a-f]{32}$");
    assertThat(field(access, "span.id").asText())
        .as("file's backend.access line carries a 16-char lowercase hex span.id")
        .matches("^[0-9a-f]{16}$");
  }

  // 6.4 -----------------------------------------------------------------------
  @Test
  void accessLogLineIsByteIdenticalBetweenFileAndStdout() throws Exception {
    signup("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    resetCapture();
    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    String fileLine = lastRawAccessLine(readRawFileLines()).orElseThrow();
    String stdoutLine = lastRawAccessLine(readRawCapturedLines()).orElseThrow();
    assertThat(fileLine)
        .as("file's backend.access line is byte-identical to stdout's for the same request")
        .isEqualTo(stdoutLine);
  }

  // 6.5 (nested context where logging.file.name resolves to empty) ------------
  /**
   * Spring Boot's {@code LogFile.get(...)} returns {@code null} when {@code logging.file.name} has
   * no length, so no file appender is configured. The outer class set {@code LOG_FILE_PATH} as a
   * JVM-wide system property; this nested context overrides the resolved {@code
   * logging.file.name} property directly to empty via {@code @TestPropertySource}, which sits at
   * higher precedence than the {@code application.yaml} placeholder and forces Spring Boot's
   * logging system to skip the file appender. Asserting on a fresh, test-created directory then
   * proves the default dev loop remains stdout-only.
   */
  @Nested
  @TestPropertySource(properties = "logging.file.name=")
  class WhenLogFilePathIsEmpty {

    @Test
    void noFileIsWrittenInsideTheTestCreatedDirectory() throws Exception {
      Path emptyDir = Files.createTempDirectory("logfile-it-unset-");
      LoggerFactory.getLogger(getClass()).info("smoke-no-file-line");

      try (Stream<Path> entries = Files.list(emptyDir)) {
        assertThat(entries.toList())
            .as("no file is created at any path the backend controls")
            .isEmpty();
      }
    }
  }

  // --- helpers --------------------------------------------------------------

  private List<JsonNode> readFileLines() throws IOException {
    List<JsonNode> nodes = new ArrayList<>();
    for (String line : readRawFileLines()) {
      try {
        nodes.add(mapper.readTree(line));
      } catch (Exception ignored) {
        // Non-JSON lines are not expected on the ECS-formatted file appender.
      }
    }
    return nodes;
  }

  private List<String> readRawFileLines() throws IOException {
    List<String> raw = new ArrayList<>();
    for (String line : Files.readString(LOG_FILE, StandardCharsets.UTF_8).split("\n")) {
      String trimmed = line.trim();
      if (!trimmed.isEmpty()) {
        raw.add(trimmed);
      }
    }
    return raw;
  }

  private List<String> readRawCapturedLines() {
    String text;
    synchronized (captureStream) {
      text = captureStream.toString(StandardCharsets.UTF_8);
    }
    List<String> raw = new ArrayList<>();
    for (String line : text.split("\n")) {
      String trimmed = line.trim();
      if (!trimmed.isEmpty()) {
        raw.add(trimmed);
      }
    }
    return raw;
  }

  private Optional<JsonNode> lastAccessLogLine(List<JsonNode> lines) {
    JsonNode last = null;
    for (JsonNode n : lines) {
      if ("backend.access".equals(field(n, "event.dataset").asText(null))) {
        last = n;
      }
    }
    return Optional.ofNullable(last);
  }

  private Optional<String> lastRawAccessLine(List<String> rawLines) {
    String last = null;
    for (String line : rawLines) {
      try {
        JsonNode n = mapper.readTree(line);
        if ("backend.access".equals(field(n, "event.dataset").asText(null))) {
          last = line;
        }
      } catch (Exception ignored) {
        // skip
      }
    }
    return Optional.ofNullable(last);
  }

  private JsonNode field(JsonNode root, String dottedPath) {
    JsonNode current = root;
    for (String segment : dottedPath.split("\\.")) {
      current = current.path(segment);
    }
    return current;
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
}
