package com.prodready.social.useraccounts;

import static com.prodready.social.useraccounts.AuthITSupport.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.Cookie;
import java.time.OffsetDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
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
class RefreshIT {

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
  void refresh_happyPath_rotatesAndReturnsNewTokens() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");
    String oldAccess = login.accessToken();
    Cookie oldCookie = login.refreshCookie();

    String oldRefreshHash = AuthTokenService.sha256(oldCookie.getValue());

    MvcResult result =
        mvc.perform(post("/api/v1/auth/refresh").cookie(oldCookie).with(csrf()))
            .andExpect(status().isOk())
            .andReturn();

    JsonNode body = MAPPER.readTree(result.getResponse().getContentAsString());
    String newAccess = body.get("accessToken").asText();
    Cookie newCookie = result.getResponse().getCookie(AuthController.REFRESH_COOKIE_NAME);

    assertThat(newAccess).isNotEqualTo(oldAccess);
    assertThat(newCookie).isNotNull();
    assertThat(newCookie.getValue()).isNotEqualTo(oldCookie.getValue());

    OffsetDateTime oldRevokedAt =
        jdbc.queryForObject(
            "SELECT revoked_at FROM auth_refresh_tokens WHERE token_hash = ?",
            OffsetDateTime.class,
            oldRefreshHash);
    assertThat(oldRevokedAt).isNotNull();

    String newRefreshHash = AuthTokenService.sha256(newCookie.getValue());
    String oldReplacedById =
        jdbc.queryForObject(
            "SELECT replaced_by::text FROM auth_refresh_tokens WHERE token_hash = ?",
            String.class,
            oldRefreshHash);
    String newRowId =
        jdbc.queryForObject(
            "SELECT id::text FROM auth_refresh_tokens WHERE token_hash = ?",
            String.class,
            newRefreshHash);
    assertThat(oldReplacedById).isEqualTo(newRowId);

    Integer accessRows =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);
    assertThat(accessRows).isEqualTo(2);
  }

  @Test
  void refresh_missingCookie_returns401() throws Exception {
    mvc.perform(post("/api/v1/auth/refresh").with(csrf()))
        .andExpect(status().isUnauthorized())
        .andExpect(
            org.springframework.test.web.servlet.result.MockMvcResultMatchers.content()
                .contentTypeCompatibleWith(
                    org.springframework.http.MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void refresh_expiredCookie_returns401AndDoesNotMint() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    jdbc.update("UPDATE auth_refresh_tokens SET expires_at = now() - interval '1 minute'");

    int accessRowsBefore =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);

    mvc.perform(post("/api/v1/auth/refresh").cookie(login.refreshCookie()).with(csrf()))
        .andExpect(status().isUnauthorized());

    int accessRowsAfter =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);
    int refreshRowsAfter =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_refresh_tokens", Integer.class);
    assertThat(accessRowsAfter).isEqualTo(accessRowsBefore);
    assertThat(refreshRowsAfter).isEqualTo(1);
  }

  @Test
  void refresh_revokedCookie_returns401AndDoesNotMint() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");

    jdbc.update("UPDATE auth_refresh_tokens SET revoked_at = now()");

    int accessRowsBefore =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);

    mvc.perform(post("/api/v1/auth/refresh").cookie(login.refreshCookie()).with(csrf()))
        .andExpect(status().isUnauthorized());

    int accessRowsAfter =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);
    int refreshRowsAfter =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_refresh_tokens", Integer.class);
    assertThat(accessRowsAfter).isEqualTo(accessRowsBefore);
    assertThat(refreshRowsAfter).isEqualTo(1);
  }
}
