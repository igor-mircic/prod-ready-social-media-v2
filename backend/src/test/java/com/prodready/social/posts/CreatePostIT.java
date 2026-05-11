package com.prodready.social.posts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
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
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class CreatePostIT {

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
    jdbc.update("DELETE FROM posts");
    jdbc.update("DELETE FROM auth_refresh_tokens");
    jdbc.update("DELETE FROM auth_access_tokens");
    jdbc.update("DELETE FROM users");
  }

  @Test
  void create_happyPath_returns201AndPersists() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    String response =
        mvc.perform(
                post("/api/v1/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(PostsITSupport.createPostBody("hello, world")))
            .andExpect(status().isCreated())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.body").value("hello, world"))
            .andExpect(jsonPath("$.id").exists())
            .andExpect(jsonPath("$.createdAt").exists())
            .andExpect(jsonPath("$.author.id").value(alice.id().toString()))
            .andExpect(jsonPath("$.author.displayName").value("Alice"))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode parsed = mapper.readTree(response);
    UUID postId = UUID.fromString(parsed.get("id").asText());

    Map<String, Object> row =
        jdbc.queryForMap("SELECT author_id, body, deleted_at FROM posts WHERE id = ?", postId);
    assertThat(row.get("author_id").toString()).isEqualTo(alice.id().toString());
    assertThat(row.get("body")).isEqualTo("hello, world");
    assertThat(row.get("deleted_at")).isNull();
  }

  @Test
  void create_unauthenticated_returns401() throws Exception {
    mvc.perform(
            post("/api/v1/posts")
                .contentType(MediaType.APPLICATION_JSON)
                .content(PostsITSupport.createPostBody("hello")))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));

    Integer count = jdbc.queryForObject("SELECT count(*) FROM posts", Integer.class);
    assertThat(count).isEqualTo(0);
  }

  @Test
  void create_emptyBody_returns400() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    String response =
        mvc.perform(
                post("/api/v1/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(PostsITSupport.createPostBody("")))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode body = mapper.readTree(response);
    assertThat(body.get("fields").has("body")).isTrue();

    Integer count = jdbc.queryForObject("SELECT count(*) FROM posts", Integer.class);
    assertThat(count).isEqualTo(0);
  }

  @Test
  void create_whitespaceOnlyBody_returns400() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    mvc.perform(
            post("/api/v1/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken())
                .contentType(MediaType.APPLICATION_JSON)
                .content(PostsITSupport.createPostBody("   \t  ")))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));

    Integer count = jdbc.queryForObject("SELECT count(*) FROM posts", Integer.class);
    assertThat(count).isEqualTo(0);
  }

  @Test
  void create_overLengthBody_returns400() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    String tooLong = "a".repeat(501);
    mvc.perform(
            post("/api/v1/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken())
                .contentType(MediaType.APPLICATION_JSON)
                .content(PostsITSupport.createPostBody(tooLong)))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));

    Integer count = jdbc.queryForObject("SELECT count(*) FROM posts", Integer.class);
    assertThat(count).isEqualTo(0);
  }
}
