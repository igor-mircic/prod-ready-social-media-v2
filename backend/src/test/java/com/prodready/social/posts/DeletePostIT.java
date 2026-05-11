package com.prodready.social.posts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
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
class DeletePostIT {

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

  private UUID createPost(PostsITSupport.TestUser user, String body) throws Exception {
    String response =
        mvc.perform(
                post("/api/v1/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + user.accessToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(PostsITSupport.createPostBody(body)))
            .andExpect(status().isCreated())
            .andReturn()
            .getResponse()
            .getContentAsString();
    JsonNode parsed = mapper.readTree(response);
    return UUID.fromString(parsed.get("id").asText());
  }

  @Test
  void delete_authorOwnPost_softDeletesAndReturns204() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");
    UUID id = createPost(alice, "delete me");

    mvc.perform(
            delete("/api/v1/posts/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    Map<String, Object> row =
        jdbc.queryForMap("SELECT body, deleted_at FROM posts WHERE id = ?", id);
    assertThat(row.get("body")).isEqualTo("delete me");
    assertThat(row.get("deleted_at")).isNotNull();
  }

  @Test
  void subsequentRead_softDeletedPost_returns404() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");
    UUID id = createPost(alice, "delete me");

    mvc.perform(
            delete("/api/v1/posts/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    mvc.perform(
            get("/api/v1/posts/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNotFound());
  }

  @Test
  void delete_nonAuthor_returns404AndRowUnchanged() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");
    PostsITSupport.TestUser bob =
        PostsITSupport.signupAndLogin(mvc, "bob@example.com", "correcthorse", "Bob");
    UUID id = createPost(alice, "alice's post");

    mvc.perform(
            delete("/api/v1/posts/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));

    Map<String, Object> row = jdbc.queryForMap("SELECT deleted_at FROM posts WHERE id = ?", id);
    assertThat(row.get("deleted_at")).isNull();
  }

  @Test
  void delete_missingId_returns404() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    mvc.perform(
            delete("/api/v1/posts/" + UUID.randomUUID())
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNotFound());
  }

  @Test
  void delete_alreadySoftDeleted_returns404() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");
    UUID id = createPost(alice, "delete me twice");
    jdbc.update("UPDATE posts SET deleted_at = now() WHERE id = ?", id);

    mvc.perform(
            delete("/api/v1/posts/" + id)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNotFound());
  }

  @Test
  void delete_unauthenticated_returns401() throws Exception {
    mvc.perform(delete("/api/v1/posts/" + UUID.randomUUID()))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }
}
