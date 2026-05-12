package com.prodready.social.useraccounts;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
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
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class UsersControllerIT {

  private static final ObjectMapper MAPPER = new ObjectMapper();

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
    jdbc.update("DELETE FROM posts");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void getUser_existingId_returns200WithIdAndDisplayNameOnly() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");
    UUID aliceId =
        UUID.fromString(
            jdbc.queryForObject(
                "SELECT id FROM users WHERE email = 'alice@example.com'", String.class));

    MvcResult result =
        mvc.perform(
                get("/api/v1/users/" + aliceId)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.id").value(aliceId.toString()))
            .andExpect(jsonPath("$.displayName").value("Alice"))
            .andExpect(jsonPath("$.email").doesNotExist())
            .andExpect(jsonPath("$.password").doesNotExist())
            .andExpect(jsonPath("$.passwordHash").doesNotExist())
            .andExpect(jsonPath("$.createdAt").doesNotExist())
            .andReturn();

    JsonNode body = MAPPER.readTree(result.getResponse().getContentAsString());
    java.util.Set<String> keys = new java.util.HashSet<>();
    body.fieldNames().forEachRemaining(keys::add);
    if (!keys.equals(java.util.Set.of("id", "displayName"))) {
      throw new AssertionError("Unexpected response keys: " + keys);
    }
  }

  @Test
  void getUser_unknownId_returns404ProblemDetail() throws Exception {
    AuthITSupport.signup(mvc, "alice@example.com", "correcthorse", "Alice");
    AuthITSupport.LoginTokens login =
        AuthITSupport.loginAndCapture(mvc, "alice@example.com", "correcthorse");
    UUID unknown = UUID.randomUUID();

    mvc.perform(
            get("/api/v1/users/" + unknown)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + login.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
        .andExpect(jsonPath("$.status").value(404));
  }

  @Test
  void getUser_unauthenticated_returns401ProblemDetail() throws Exception {
    UUID someId = UUID.randomUUID();

    mvc.perform(get("/api/v1/users/" + someId))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
        .andExpect(jsonPath("$.status").value(401));
  }
}
