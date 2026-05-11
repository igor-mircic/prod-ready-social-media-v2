package com.prodready.social.posts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
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
class ListPostsIT {

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

  private void seedPost(UUID authorId, String body, OffsetDateTime createdAt) {
    jdbc.update(
        "INSERT INTO posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)",
        UUID.randomUUID(),
        authorId,
        body,
        createdAt);
  }

  @Test
  void firstPage_returnsMostRecentLimit_andAdvancesByCursor() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    OffsetDateTime base = OffsetDateTime.of(2026, 1, 1, 12, 0, 0, 0, ZoneOffset.UTC);
    for (int i = 0; i < 7; i++) {
      seedPost(alice.id(), "post-" + i, base.plusMinutes(i));
    }

    String firstPage =
        mvc.perform(
                get("/api/v1/users/" + alice.id() + "/posts?limit=3")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(3))
            .andExpect(jsonPath("$.nextCursor").isNotEmpty())
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode page1 = mapper.readTree(firstPage);
    Set<String> idsSeen = new LinkedHashSet<>();
    for (int i = 0; i < page1.get("items").size(); i++) {
      idsSeen.add(page1.get("items").get(i).get("id").asText());
    }
    // Newest-first ordering: post-6, post-5, post-4
    assertThat(page1.get("items").get(0).get("body").asText()).isEqualTo("post-6");
    assertThat(page1.get("items").get(1).get("body").asText()).isEqualTo("post-5");
    assertThat(page1.get("items").get(2).get("body").asText()).isEqualTo("post-4");

    String cursor = page1.get("nextCursor").asText();

    String secondPage =
        mvc.perform(
                get("/api/v1/users/" + alice.id() + "/posts?limit=3&cursor=" + cursor)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(3))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode page2 = mapper.readTree(secondPage);
    Set<String> page2Ids = new HashSet<>();
    for (int i = 0; i < page2.get("items").size(); i++) {
      page2Ids.add(page2.get("items").get(i).get("id").asText());
    }
    // No overlap with page 1.
    for (String id : page2Ids) {
      assertThat(idsSeen).doesNotContain(id);
    }
    // Strictly older — post-3, post-2, post-1
    assertThat(page2.get("items").get(0).get("body").asText()).isEqualTo("post-3");
    assertThat(page2.get("items").get(2).get("body").asText()).isEqualTo("post-1");
  }

  @Test
  void list_excludesSoftDeletedPosts() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    OffsetDateTime base = OffsetDateTime.of(2026, 1, 1, 12, 0, 0, 0, ZoneOffset.UTC);
    seedPost(alice.id(), "alive-1", base);
    seedPost(alice.id(), "alive-2", base.plusMinutes(1));
    UUID deletedId = UUID.randomUUID();
    jdbc.update(
        "INSERT INTO posts (id, author_id, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
        deletedId,
        alice.id(),
        "deleted",
        base.plusMinutes(2),
        base.plusMinutes(3));

    String response =
        mvc.perform(
                get("/api/v1/users/" + alice.id() + "/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode body = mapper.readTree(response);
    assertThat(body.get("items").size()).isEqualTo(2);
    for (int i = 0; i < body.get("items").size(); i++) {
      assertThat(body.get("items").get(i).get("id").asText()).isNotEqualTo(deletedId.toString());
    }
    assertThat(body.get("nextCursor").isNull()).isTrue();
  }

  @Test
  void limit_clampedTo50WhenExceeded() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    OffsetDateTime base = OffsetDateTime.of(2026, 1, 1, 12, 0, 0, 0, ZoneOffset.UTC);
    for (int i = 0; i < 60; i++) {
      seedPost(alice.id(), "post-" + i, base.plusMinutes(i));
    }

    String response =
        mvc.perform(
                get("/api/v1/users/" + alice.id() + "/posts?limit=999")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(50))
            .andExpect(jsonPath("$.nextCursor").isNotEmpty())
            .andReturn()
            .getResponse()
            .getContentAsString();
    assertThat(response).isNotBlank();
  }

  @Test
  void defaultLimit_is20() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    OffsetDateTime base = OffsetDateTime.of(2026, 1, 1, 12, 0, 0, 0, ZoneOffset.UTC);
    for (int i = 0; i < 25; i++) {
      seedPost(alice.id(), "post-" + i, base.plusMinutes(i));
    }

    mvc.perform(
            get("/api/v1/users/" + alice.id() + "/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.items.length()").value(20))
        .andExpect(jsonPath("$.nextCursor").isNotEmpty());
  }

  @Test
  void unknownUserId_returns404() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    mvc.perform(
            get("/api/v1/users/" + UUID.randomUUID() + "/posts")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void list_unauthenticated_returns401() throws Exception {
    mvc.perform(get("/api/v1/users/" + UUID.randomUUID() + "/posts"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void malformedCursor_returns400WithCursorInFields() throws Exception {
    PostsITSupport.TestUser alice =
        PostsITSupport.signupAndLogin(mvc, "alice@example.com", "correcthorse", "Alice");

    String response =
        mvc.perform(
                get("/api/v1/users/" + alice.id() + "/posts?cursor=not-a-valid-cursor")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode body = mapper.readTree(response);
    assertThat(body.get("status").asInt()).isEqualTo(400);
    assertThat(body.get("fields").has("cursor")).isTrue();
  }
}
