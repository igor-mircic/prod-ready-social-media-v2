package com.prodready.social.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureMetrics
@ActiveProfiles("test")
@Testcontainers
class MetricsActuatorIT {

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
  void prometheusEndpoint_unauthenticated_returns200() throws Exception {
    mvc.perform(get("/actuator/prometheus"))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_PLAIN));
  }

  @Test
  void prometheusEndpoint_exposesExpectedMetricFamilies() throws Exception {
    // Drive a fanout, feed read, post create, and follow so all four custom timers
    // have been observed at least once before we scrape — Micrometer Timers are
    // not materialised in the registry until their first observation.
    signupAndLogin("alice@example.com", "correcthorse", "Alice");
    String aliceToken = login("alice@example.com", "correcthorse");
    String aliceId = userId("alice@example.com");
    signupAndLogin("bob@example.com", "correcthorse", "Bob");
    String bobToken = login("bob@example.com", "correcthorse");
    String bobId = userId("bob@example.com");

    mvc.perform(
            post("/api/v1/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + aliceToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"body\":\"hello\"}"))
        .andExpect(status().isCreated());
    mvc.perform(
            post("/api/v1/users/" + aliceId + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bobToken))
        .andExpect(status().isNoContent());
    mvc.perform(get("/api/v1/feed").header(HttpHeaders.AUTHORIZATION, "Bearer " + aliceToken))
        .andExpect(status().isOk());

    String body = scrape();
    assertThat(body).contains("http_server_requests_seconds_count");
    assertThat(body).contains("hikaricp_connections_active");
    assertThat(body).contains("jvm_memory_used_bytes");
    assertThat(body).contains("feed_fanout_duration_seconds_count");
    assertThat(body).contains("feed_read_duration_seconds_count");
    assertThat(body).contains("posts_create_duration_seconds_count");
    assertThat(body).contains("follows_follow_duration_seconds_count");
    // _bucket families must also be emitted so the Grafana p95 panels render.
    assertThat(body).contains("http_server_requests_seconds_bucket");
    assertThat(body).contains("feed_fanout_duration_seconds_bucket");
    assertThat(body).contains("feed_read_duration_seconds_bucket");
    assertThat(body).contains("posts_create_duration_seconds_bucket");
    assertThat(body).contains("follows_follow_duration_seconds_bucket");
    // referenced to silence unused-variable on bobId
    assertThat(bobId).isNotEmpty();
  }

  @Test
  void prometheusEndpoint_emitsCommonTags() throws Exception {
    String body = scrape();
    assertThat(body).contains("application=\"prod-ready-social-media-backend\"");
    assertThat(body).contains("service=\"backend\"");
  }

  @Test
  void actuatorEnv_unauthenticated_returns401() throws Exception {
    mvc.perform(get("/actuator/env"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void httpServerRequestsCounter_incrementsOnControllerCall() throws Exception {
    signupAndLogin("alice@example.com", "correcthorse", "Alice");
    String token = login("alice@example.com", "correcthorse");

    // Warm the counter: hit /me once so the counter line exists in subsequent scrapes.
    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    double before = counterValue(scrape(), "/api/v1/auth/me", "GET", "200");

    mvc.perform(get("/api/v1/auth/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
        .andExpect(status().isOk());

    double after = counterValue(scrape(), "/api/v1/auth/me", "GET", "200");
    assertThat(after).isGreaterThan(before);
  }

  @Test
  void feedFanoutDurationTimer_recordsOnFanout() throws Exception {
    signupAndLogin("alice@example.com", "correcthorse", "Alice");
    String aliceToken = login("alice@example.com", "correcthorse");

    mvc.perform(
            post("/api/v1/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + aliceToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"body\":\"hello\"}"))
        .andExpect(status().isCreated());

    String body = scrape();
    double total = sumCounter(body, "feed_fanout_duration_seconds_count");
    assertThat(total).isGreaterThanOrEqualTo(1.0);
  }

  // --- helpers --------------------------------------------------------------

  private String scrape() throws Exception {
    MvcResult result =
        mvc.perform(get("/actuator/prometheus")).andExpect(status().isOk()).andReturn();
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

  private String userId(String email) {
    return jdbc.queryForObject("SELECT id FROM users WHERE email = ?", String.class, email);
  }

  private static double counterValue(String body, String uri, String method, String status) {
    String prefix = "http_server_requests_seconds_count{";
    for (String line : body.split("\n")) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      if (!line.contains("uri=\"" + uri + "\"")) {
        continue;
      }
      if (!line.contains("method=\"" + method + "\"")) {
        continue;
      }
      if (!line.contains("status=\"" + status + "\"")) {
        continue;
      }
      int space = line.lastIndexOf(' ');
      return Double.parseDouble(line.substring(space + 1));
    }
    return 0.0;
  }

  private static double sumCounter(String body, String metricName) {
    double sum = 0.0;
    String prefix = metricName + "{";
    for (String line : body.split("\n")) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      int space = line.lastIndexOf(' ');
      sum += Double.parseDouble(line.substring(space + 1));
    }
    return sum;
  }
}
