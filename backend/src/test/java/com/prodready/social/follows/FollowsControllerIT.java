package com.prodready.social.follows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
class FollowsControllerIT {

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

  record TestUser(UUID id, String accessToken) {}

  private TestUser signupAndLogin(String email, String displayName) throws Exception {
    String signupBody =
        String.format(
            "{\"email\":\"%s\",\"password\":\"correcthorse\",\"displayName\":\"%s\"}",
            email, displayName);
    MvcResult signupResult =
        mvc.perform(
                post("/api/v1/auth/signup")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(signupBody))
            .andExpect(status().isCreated())
            .andReturn();
    UUID id =
        UUID.fromString(
            mapper.readTree(signupResult.getResponse().getContentAsString()).get("id").asText());

    String loginBody = String.format("{\"email\":\"%s\",\"password\":\"correcthorse\"}", email);
    MvcResult loginResult =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody))
            .andExpect(status().isOk())
            .andReturn();
    String token =
        mapper.readTree(loginResult.getResponse().getContentAsString()).get("accessToken").asText();
    return new TestUser(id, token);
  }

  private long followRowCount(UUID followerId, UUID followeeId) {
    Long n =
        jdbc.queryForObject(
            "SELECT count(*) FROM follows WHERE follower_id = ? AND followee_id = ?",
            Long.class,
            followerId,
            followeeId);
    return n == null ? 0 : n;
  }

  private long followTotal() {
    Long n = jdbc.queryForObject("SELECT count(*) FROM follows", Long.class);
    return n == null ? 0 : n;
  }

  @Test
  void follow_happyPath_returns204AndInsertsRow() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    assertThat(followRowCount(bob.id(), alice.id())).isEqualTo(1);
  }

  @Test
  void follow_repeated_isIdempotent() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    for (int i = 0; i < 2; i++) {
      mvc.perform(
              post("/api/v1/users/" + alice.id() + "/follow")
                  .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
          .andExpect(status().isNoContent());
    }

    assertThat(followRowCount(bob.id(), alice.id())).isEqualTo(1);
  }

  @Test
  void follow_self_returns400() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");

    String body =
        mvc.perform(
                post("/api/v1/users/" + alice.id() + "/follow")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode parsed = mapper.readTree(body);
    assertThat(parsed.get("status").asInt()).isEqualTo(400);
    assertThat(parsed.get("detail").asText().toLowerCase()).contains("follow yourself");
    assertThat(followTotal()).isZero();
  }

  @Test
  void follow_unknownTarget_returns404() throws Exception {
    TestUser bob = signupAndLogin("bob@example.com", "Bob");
    UUID unknown = UUID.randomUUID();

    mvc.perform(
            post("/api/v1/users/" + unknown + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
        .andExpect(jsonPath("$.status").value(404));

    assertThat(followTotal()).isZero();
  }

  @Test
  void follow_unauthenticated_returns401() throws Exception {
    mvc.perform(post("/api/v1/users/" + UUID.randomUUID() + "/follow"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));

    assertThat(followTotal()).isZero();
  }

  @Test
  void unfollow_happyPath_returns204AndRemovesRow() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");
    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    assertThat(followRowCount(bob.id(), alice.id())).isZero();
  }

  @Test
  void unfollow_whenNotFollowing_isIdempotent() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    assertThat(followTotal()).isZero();
  }

  @Test
  void unfollow_self_returns204() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");

    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    assertThat(followTotal()).isZero();
  }

  @Test
  void unfollow_unknownTarget_returns404() throws Exception {
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    mvc.perform(
            delete("/api/v1/users/" + UUID.randomUUID() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void unfollow_unauthenticated_returns401() throws Exception {
    mvc.perform(delete("/api/v1/users/" + UUID.randomUUID() + "/follow"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  private long feedEntryCountForRecipient(UUID recipientId) {
    Long n =
        jdbc.queryForObject(
            "SELECT count(*) FROM feed_entries WHERE recipient_id = ?", Long.class, recipientId);
    return n == null ? 0 : n;
  }

  private UUID createPostViaApi(String token, String body) throws Exception {
    String response =
        mvc.perform(
                post("/api/v1/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"body\":\"" + body + "\"}"))
            .andExpect(status().isCreated())
            .andReturn()
            .getResponse()
            .getContentAsString();
    return UUID.fromString(mapper.readTree(response).get("id").asText());
  }

  @Test
  void follow_backfillsRecipientFeedCapped() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    // Seed 105 of Alice's posts directly (timestamps staggered by 1s).
    java.time.OffsetDateTime base =
        java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).minusDays(1);
    java.util.List<UUID> seeded = new java.util.ArrayList<>(105);
    for (int i = 0; i < 105; i++) {
      UUID pid = UUID.randomUUID();
      seeded.add(pid);
      jdbc.update(
          "INSERT INTO posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)",
          pid,
          alice.id(),
          "seed-" + i,
          base.plusSeconds(i));
    }

    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    assertThat(feedEntryCountForRecipient(bob.id())).isEqualTo(100L);
    // The kept set must be the 100 most-recent posts (indices 5..104 inclusive).
    java.util.List<UUID> kept =
        jdbc.queryForList(
            "SELECT post_id FROM feed_entries WHERE recipient_id = ?", UUID.class, bob.id());
    assertThat(new java.util.HashSet<>(kept))
        .isEqualTo(new java.util.HashSet<>(seeded.subList(5, 105)));
  }

  @Test
  void unfollow_scrubsRecipientFeedForAuthor() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser carol = signupAndLogin("carol@example.com", "Carol");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    UUID a1 = createPostViaApi(alice.accessToken(), "a1");
    UUID c1 = createPostViaApi(carol.accessToken(), "c1");
    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());
    mvc.perform(
            post("/api/v1/users/" + carol.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    // Bob's feed_entries: a1 (from Alice) + c1 (from Carol).
    assertThat(feedEntryCountForRecipient(bob.id())).isEqualTo(2L);

    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    java.util.List<UUID> remaining =
        jdbc.queryForList(
            "SELECT post_id FROM feed_entries WHERE recipient_id = ?", UUID.class, bob.id());
    assertThat(remaining).containsExactly(c1);
    assertThat(remaining).doesNotContain(a1);
  }

  @Test
  void selfUnfollow_doesNotScrubOwnPosts() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    createPostViaApi(alice.accessToken(), "own-1");
    createPostViaApi(alice.accessToken(), "own-2");

    // 2 self-fanout rows present.
    assertThat(feedEntryCountForRecipient(alice.id())).isEqualTo(2L);

    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    // Self-fanout rows survive the self-unfollow.
    assertThat(feedEntryCountForRecipient(alice.id())).isEqualTo(2L);
  }

  @Test
  void stats_happyPath_viewerFollowsTrue() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");
    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());

    mvc.perform(
            get("/api/v1/users/" + alice.id() + "/follow-stats")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.followers").value(1))
        .andExpect(jsonPath("$.following").value(0))
        .andExpect(jsonPath("$.viewerFollows").value(true));
  }

  @Test
  void stats_happyPath_viewerFollowsFalse() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    mvc.perform(
            get("/api/v1/users/" + alice.id() + "/follow-stats")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.followers").value(0))
        .andExpect(jsonPath("$.following").value(0))
        .andExpect(jsonPath("$.viewerFollows").value(false));
  }

  @Test
  void stats_ownProfile_viewerFollowsFalse() throws Exception {
    TestUser alice = signupAndLogin("alice@example.com", "Alice");
    TestUser bob = signupAndLogin("bob@example.com", "Bob");
    TestUser carol = signupAndLogin("carol@example.com", "Carol");
    // Bob follows Alice, Alice follows Carol; Alice has 1 follower, 1 following.
    mvc.perform(
            post("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNoContent());
    mvc.perform(
            post("/api/v1/users/" + carol.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    mvc.perform(
            get("/api/v1/users/" + alice.id() + "/follow-stats")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.followers").value(1))
        .andExpect(jsonPath("$.following").value(1))
        .andExpect(jsonPath("$.viewerFollows").value(false));
  }

  @Test
  void stats_unknownTarget_returns404() throws Exception {
    TestUser bob = signupAndLogin("bob@example.com", "Bob");

    mvc.perform(
            get("/api/v1/users/" + UUID.randomUUID() + "/follow-stats")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bob.accessToken()))
        .andExpect(status().isNotFound())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void stats_unauthenticated_returns401() throws Exception {
    mvc.perform(get("/api/v1/users/" + UUID.randomUUID() + "/follow-stats"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }
}
