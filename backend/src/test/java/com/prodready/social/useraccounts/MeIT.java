package com.prodready.social.useraccounts;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class MeIT {

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

  @BeforeEach
  void cleanDatabase() {
    jdbc.update("DELETE FROM auth_refresh_tokens");
    jdbc.update("DELETE FROM auth_access_tokens");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void me_validToken_returnsUser() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    mvc.perform(
            get("/api/v1/auth/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
        .andExpect(status().isOk())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
        .andExpect(jsonPath("$.email").value("alice@example.com"))
        .andExpect(jsonPath("$.displayName").value("Alice"))
        .andExpect(jsonPath("$.id").exists())
        .andExpect(jsonPath("$.createdAt").exists());
  }

  @Test
  void me_noToken_returns401() throws Exception {
    mvc.perform(get("/api/v1/auth/me"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void me_expiredToken_returns401() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    jdbc.update("UPDATE auth_access_tokens SET expires_at = now() - interval '1 minute'");

    mvc.perform(
            get("/api/v1/auth/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void me_revokedToken_returns401() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    jdbc.update("UPDATE auth_access_tokens SET revoked_at = now()");

    mvc.perform(
            get("/api/v1/auth/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
        .andExpect(status().isUnauthorized());
  }
}
