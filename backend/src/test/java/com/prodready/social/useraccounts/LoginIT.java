package com.prodready.social.useraccounts;

import static com.prodready.social.useraccounts.AuthITSupport.MAPPER;
import static com.prodready.social.useraccounts.AuthITSupport.loginBody;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
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
@ActiveProfiles("test")
@Testcontainers
class LoginIT {

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
  void login_happyPath_returnsAccessTokenAndSetsRefreshCookie() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");

    MvcResult result =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody("alice@example.com", "correcthorse")))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.accessToken").isString())
            .andExpect(jsonPath("$.expiresIn").isNumber())
            .andReturn();

    Cookie cookie = result.getResponse().getCookie(AuthController.REFRESH_COOKIE_NAME);
    assertThat(cookie).isNotNull();
    assertThat(cookie.isHttpOnly()).isTrue();
    assertThat(cookie.getSecure()).isTrue();
    assertThat(cookie.getPath()).isEqualTo("/api/v1/auth/refresh");
    assertThat(cookie.getMaxAge()).isGreaterThan(0);
    String setCookieHeader = result.getResponse().getHeader("Set-Cookie");
    assertThat(setCookieHeader).contains("SameSite=Lax");

    Integer accessRows =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_access_tokens", Integer.class);
    Integer refreshRows =
        jdbc.queryForObject("SELECT COUNT(*) FROM auth_refresh_tokens", Integer.class);
    assertThat(accessRows).isEqualTo(1);
    assertThat(refreshRows).isEqualTo(1);

    JsonNode body = MAPPER.readTree(result.getResponse().getContentAsString());
    String returnedAccessHash = sha256Base64Url(body.get("accessToken").asText());
    String returnedRefreshHash = sha256Base64Url(cookie.getValue());
    String storedAccessHash =
        jdbc.queryForObject("SELECT token_hash FROM auth_access_tokens", String.class);
    String storedRefreshHash =
        jdbc.queryForObject("SELECT token_hash FROM auth_refresh_tokens", String.class);
    assertThat(storedAccessHash).isEqualTo(returnedAccessHash);
    assertThat(storedRefreshHash).isEqualTo(returnedRefreshHash);
    assertThat(storedAccessHash).isNotEqualTo(body.get("accessToken").asText());
  }

  @Test
  void login_wrongPassword_returns401Generic() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");

    MvcResult wrong =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody("alice@example.com", "wrongpassword")))
            .andExpect(status().isUnauthorized())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn();
    JsonNode wrongBody = MAPPER.readTree(wrong.getResponse().getContentAsString());
    assertThat(wrongBody.get("status").asInt()).isEqualTo(401);
    assertThat(wrongBody.get("detail").asText()).isEqualTo("Invalid email or password");
  }

  @Test
  void login_unknownEmail_returnsSameDetailAsWrongPassword() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");

    MvcResult wrong =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody("alice@example.com", "wrongpassword")))
            .andExpect(status().isUnauthorized())
            .andReturn();
    MvcResult unknown =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody("nobody@example.com", "anything")))
            .andExpect(status().isUnauthorized())
            .andReturn();

    JsonNode wrongBody = MAPPER.readTree(wrong.getResponse().getContentAsString());
    JsonNode unknownBody = MAPPER.readTree(unknown.getResponse().getContentAsString());
    assertThat(unknownBody.get("detail").asText()).isEqualTo(wrongBody.get("detail").asText());
    assertThat(unknownBody.get("title").asText()).isEqualTo(wrongBody.get("title").asText());
  }

  @Test
  void login_malformedBody_returns400() throws Exception {
    mvc.perform(
            post("/api/v1/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"\",\"password\":\"\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  private static String sha256Base64Url(String input) {
    return AuthTokenService.sha256(input);
  }
}
