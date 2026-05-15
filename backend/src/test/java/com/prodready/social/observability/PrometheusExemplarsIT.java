package com.prodready.social.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
 * Asserts that the Spring Boot Actuator's `/actuator/prometheus` endpoint emits OpenMetrics
 * exemplar lines on `http_server_requests_seconds_bucket` when an OTel span is active during
 * the recording. The wiring under test is the `ExemplarsConfig` bean plus the
 * `prometheus-metrics-tracer-otel-agent` library: with the bean on the context, Spring Boot's
 * `PrometheusMetricsExportAutoConfiguration` injects the `SpanContext` into
 * `PrometheusMeterRegistry`, which queries it on every observation and attaches an exemplar
 * line when the agent reports an active span.
 *
 * <p>The OTel Java agent is attached to the test JVM via `-javaagent:` (see
 * `backend/build.gradle.kts`), so `GlobalOpenTelemetry.get()` returns the agent's SDK and the
 * `OpenTelemetryAgentSpanContext` (shaded against the agent's bootstrap OTel API) reads the
 * same span we make current here.
 */
@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureMetrics
@ActiveProfiles("test")
@Testcontainers
class PrometheusExemplarsIT {

  // Pattern for an OpenMetrics exemplar line: a histogram bucket sample followed by a
  // `# {trace_id="<32-hex>"...} <value> [<timestamp>]` exemplar suffix. The leading `#` after
  // the bucket value is OpenMetrics-specific and absent in plain Prometheus exposition.
  private static final Pattern EXEMPLAR_LINE =
      Pattern.compile(
          "^http_server_requests_seconds_bucket\\{[^}]*\\}\\s+\\S+\\s+#\\s+\\{[^}]*trace_id=\"([0-9a-f]{32})\"",
          Pattern.MULTILINE);

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

  @BeforeEach
  void cleanDatabase() {
    jdbc.update("DELETE FROM feed_entries");
    jdbc.update("DELETE FROM follows");
    jdbc.update("DELETE FROM posts");
    jdbc.update("DELETE FROM auth_refresh_tokens");
    jdbc.update("DELETE FROM auth_access_tokens");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void openMetricsScrape_emitsExemplarOnHistogramBucket() throws Exception {
    // Drive one HTTP request under an explicit synthetic span. The agent's
    // micrometer-observation instrumentation creates its own request span on top, but we
    // wrap the call in our own scope so the trace id is deterministic and we can assert an
    // exact exemplar match below.
    Tracer tracer = GlobalOpenTelemetry.get().getTracer("prometheus-exemplars-it");
    Span span = tracer.spanBuilder("synthetic-exemplar-driver").startSpan();
    String expectedTraceId = span.getSpanContext().getTraceId();
    assertThat(expectedTraceId).matches("^[0-9a-f]{32}$");

    signupAndLogin("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    try (Scope ignored = span.makeCurrent()) {
      // The agent's micrometer-observation module starts a child span around the
      // http.server.requests Observation. The exemplar emitted on the histogram carries that
      // child's trace id, which equals our parent's trace id (same trace).
      mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
          .andExpect(status().isOk());
    } finally {
      span.end();
    }

    String body = scrapeOpenMetrics();
    Matcher m = EXEMPLAR_LINE.matcher(body);
    assertThat(m.find())
        .as(
            "OpenMetrics scrape SHOULD include an exemplar line on at least one"
                + " http_server_requests_seconds_bucket — body was:\n%s",
            body)
        .isTrue();
    String observedTraceId = m.group(1);
    assertThat(observedTraceId)
        .as("exemplar trace_id should match the synthetic span we made current")
        .isEqualTo(expectedTraceId);
  }

  // --- helpers --------------------------------------------------------------

  private String scrapeOpenMetrics() throws Exception {
    MvcResult result =
        mvc.perform(
                get("/actuator/prometheus")
                    .header(HttpHeaders.ACCEPT, "application/openmetrics-text;version=1.0.0"))
            .andExpect(status().isOk())
            .andReturn();
    return result.getResponse().getContentAsString();
  }

  private void signupAndLogin(String email, String password, String displayName) throws Exception {
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
    JsonNode body = mapper.readTree(result.getResponse().getContentAsString());
    return body.get("accessToken").asText();
  }
}
