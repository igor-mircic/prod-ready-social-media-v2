package com.prodready.social.useraccounts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
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
@ActiveProfiles("test")
@Testcontainers
class LogoutIT {

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
  void logout_revokesBothTokens_andClearsCookie_andSubsequentCallsReturn401() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    String accessHash = AuthTokenService.sha256(login.accessToken());
    String refreshHash = AuthTokenService.sha256(login.refreshCookie().getValue());

    MvcResult logoutResult =
        mvc.perform(
                post("/api/v1/auth/logout")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken())
                    .cookie(login.refreshCookie())
                    .with(csrf()))
            .andExpect(status().isNoContent())
            .andReturn();

    Cookie cleared = logoutResult.getResponse().getCookie(AuthController.REFRESH_COOKIE_NAME);
    assertThat(cleared).isNotNull();
    assertThat(cleared.getMaxAge()).isZero();

    Object accessRevoked =
        jdbc.queryForObject(
            "SELECT revoked_at FROM auth_access_tokens WHERE token_hash = ?",
            Object.class,
            accessHash);
    Object refreshRevoked =
        jdbc.queryForObject(
            "SELECT revoked_at FROM auth_refresh_tokens WHERE token_hash = ?",
            Object.class,
            refreshHash);
    assertThat(accessRevoked).isNotNull();
    assertThat(refreshRevoked).isNotNull();

    mvc.perform(
            get("/api/v1/auth/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
        .andExpect(status().isUnauthorized());

    mvc.perform(post("/api/v1/auth/refresh").cookie(login.refreshCookie()).with(csrf()))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void logout_withoutAuthorization_returns401() throws Exception {
    mvc.perform(post("/api/v1/auth/logout").with(csrf())).andExpect(status().isUnauthorized());
  }
}
