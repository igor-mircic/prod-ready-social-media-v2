package com.prodready.social.feed;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.prodready.social.posts.PostsITSupport;
import com.prodready.social.posts.PostsITSupport.TestUser;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.List;
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
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.IllegalTransactionStateException;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class FeedControllerIT {

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
  @Autowired FeedFanoutService feedFanoutService;
  @Autowired FeedRebuilder feedRebuilder;

  @BeforeEach
  void cleanDatabase() {
    jdbc.update("DELETE FROM feed_entries");
    jdbc.update("DELETE FROM follows");
    jdbc.update("DELETE FROM posts");
    jdbc.update("DELETE FROM auth_refresh_tokens");
    jdbc.update("DELETE FROM auth_access_tokens");
    jdbc.update("DELETE FROM users");
  }

  // ---------- helpers ----------

  private TestUser signup(String label) throws Exception {
    return PostsITSupport.signupAndLogin(
        mvc, label.toLowerCase() + "@example.com", "correcthorse", label);
  }

  private UUID apiCreatePost(TestUser user, String body) throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/posts")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + user.accessToken())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(PostsITSupport.createPostBody(body)))
            .andExpect(status().isCreated())
            .andReturn();
    JsonNode parsed = PostsITSupport.MAPPER.readTree(result.getResponse().getContentAsString());
    // Small spacer so consecutive posts get distinct millisecond timestamps. Postgres
    // TIMESTAMPTZ has microsecond precision but @PrePersist sets OffsetDateTime.now()
    // which collapses to the JVM clock granularity (often ~1ms on macOS).
    try {
      Thread.sleep(2);
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
    }
    return UUID.fromString(parsed.get("id").asText());
  }

  private void apiFollow(TestUser caller, UUID targetId) throws Exception {
    mvc.perform(
            post("/api/v1/users/" + targetId + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + caller.accessToken()))
        .andExpect(status().isNoContent());
  }

  private void apiUnfollow(TestUser caller, UUID targetId) throws Exception {
    mvc.perform(
            delete("/api/v1/users/" + targetId + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + caller.accessToken()))
        .andExpect(status().isNoContent());
  }

  private void apiSoftDeletePost(TestUser user, UUID postId) throws Exception {
    mvc.perform(
            delete("/api/v1/posts/" + postId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + user.accessToken()))
        .andExpect(status().isNoContent());
  }

  /** Inserts {@code count} posts for {@code authorId} directly via SQL (no fanout). */
  private List<UUID> seedPostsDirect(UUID authorId, int count, OffsetDateTime baseCreatedAt) {
    List<UUID> ids = new java.util.ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      UUID postId = UUID.randomUUID();
      ids.add(postId);
      jdbc.update(
          "INSERT INTO posts (id, author_id, body, created_at)" + " VALUES (?, ?, ?, ?)",
          postId,
          authorId,
          "seed-" + i,
          baseCreatedAt.plusSeconds(i));
    }
    return ids;
  }

  private long feedEntryCount(UUID recipientId) {
    Long n =
        jdbc.queryForObject(
            "SELECT count(*) FROM feed_entries WHERE recipient_id = ?", Long.class, recipientId);
    return n == null ? 0 : n;
  }

  private long feedEntryCountForPost(UUID postId) {
    Long n =
        jdbc.queryForObject(
            "SELECT count(*) FROM feed_entries WHERE post_id = ?", Long.class, postId);
    return n == null ? 0 : n;
  }

  private Set<UUID> feedEntryPostIds(UUID recipientId) {
    List<UUID> rows =
        jdbc.queryForList(
            "SELECT post_id FROM feed_entries WHERE recipient_id = ? ORDER BY created_at DESC,"
                + " post_id DESC",
            UUID.class,
            recipientId);
    return new HashSet<>(rows);
  }

  private record FeedRow(UUID recipientId, UUID postId, UUID authorId, OffsetDateTime createdAt) {}

  private Set<FeedRow> feedEntryRows() {
    return new HashSet<>(
        jdbc.query(
            "SELECT recipient_id, post_id, author_id, created_at FROM feed_entries",
            (rs, n) ->
                new FeedRow(
                    rs.getObject("recipient_id", UUID.class),
                    rs.getObject("post_id", UUID.class),
                    rs.getObject("author_id", UUID.class),
                    rs.getObject("created_at", OffsetDateTime.class))));
  }

  private MvcResult getFeed(TestUser user, String queryString) throws Exception {
    return mvc.perform(
            get("/api/v1/feed" + (queryString == null ? "" : "?" + queryString))
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + user.accessToken()))
        .andReturn();
  }

  // ---------- read path ----------

  @Test
  void getFeed_brandNewUser_returnsEmpty() throws Exception {
    TestUser alice = signup("Alice");

    MvcResult res = getFeed(alice, null);
    assertThat(res.getResponse().getStatus()).isEqualTo(200);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isZero();
    assertThat(body.get("nextCursor").isNull()).isTrue();
  }

  @Test
  void getFeed_selfFanout_returnsOwnPostsEvenWithNoFollows() throws Exception {
    TestUser alice = signup("Alice");
    UUID p1 = apiCreatePost(alice, "p1");
    UUID p2 = apiCreatePost(alice, "p2");

    MvcResult res = getFeed(alice, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isEqualTo(2);
    // newest first
    assertThat(UUID.fromString(body.get("items").get(0).get("id").asText())).isEqualTo(p2);
    assertThat(UUID.fromString(body.get("items").get(1).get("id").asText())).isEqualTo(p1);
    assertThat(body.get("nextCursor").isNull()).isTrue();
  }

  @Test
  void getFeed_followThenAuthor_returnsBackfilledPosts() throws Exception {
    TestUser alice = signup("Alice");
    UUID a1 = apiCreatePost(alice, "a1");
    UUID a2 = apiCreatePost(alice, "a2");
    UUID a3 = apiCreatePost(alice, "a3");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());

    MvcResult res = getFeed(bob, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isEqualTo(3);
    assertThat(UUID.fromString(body.get("items").get(0).get("id").asText())).isEqualTo(a3);
    assertThat(UUID.fromString(body.get("items").get(1).get("id").asText())).isEqualTo(a2);
    assertThat(UUID.fromString(body.get("items").get(2).get("id").asText())).isEqualTo(a1);
  }

  @Test
  void getFeed_forwardFanoutAfterFollow() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());
    UUID a1 = apiCreatePost(alice, "after-follow");

    MvcResult res = getFeed(bob, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isEqualTo(1);
    assertThat(UUID.fromString(body.get("items").get(0).get("id").asText())).isEqualTo(a1);
    assertThat(body.get("items").get(0).get("body").asText()).isEqualTo("after-follow");
  }

  @Test
  void getFeed_excludesSoftDeleted() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());
    UUID p1 = apiCreatePost(alice, "p1");
    UUID p2 = apiCreatePost(alice, "p2");
    apiSoftDeletePost(alice, p1);

    MvcResult res = getFeed(bob, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isEqualTo(1);
    assertThat(UUID.fromString(body.get("items").get(0).get("id").asText())).isEqualTo(p2);
  }

  @Test
  void getFeed_unfollowScrubs() throws Exception {
    TestUser alice = signup("Alice");
    apiCreatePost(alice, "a1");
    apiCreatePost(alice, "a2");
    apiCreatePost(alice, "a3");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());
    apiUnfollow(bob, alice.id());

    MvcResult res = getFeed(bob, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isZero();
  }

  @Test
  void getFeed_selfUnfollowDoesNotScrubOwnPosts() throws Exception {
    TestUser alice = signup("Alice");
    apiCreatePost(alice, "own-1");
    apiCreatePost(alice, "own-2");

    // Self-unfollow is the existing 204 no-op contract.
    mvc.perform(
            delete("/api/v1/users/" + alice.id() + "/follow")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isNoContent());

    MvcResult res = getFeed(alice, null);
    JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
    assertThat(body.get("items").size()).isEqualTo(2);
  }

  @Test
  void getFeed_cursorPagination_walksMultiAuthor() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());

    // Alice posts 11 (forward-fanout to Bob).
    for (int i = 0; i < 11; i++) {
      apiCreatePost(alice, "alice-" + i);
    }
    // Bob posts 10 (self-fanout only; he doesn't follow himself).
    for (int i = 0; i < 10; i++) {
      apiCreatePost(bob, "bob-" + i);
    }
    assertThat(feedEntryCount(bob.id())).isEqualTo(21);

    // Page 1, limit=10
    MvcResult page1 = getFeed(bob, "limit=10");
    JsonNode body1 = PostsITSupport.MAPPER.readTree(page1.getResponse().getContentAsString());
    assertThat(body1.get("items").size()).isEqualTo(10);
    String nextCursor1 = body1.get("nextCursor").asText();
    assertThat(nextCursor1).isNotEmpty();

    // Page 2, limit=10
    MvcResult page2 = getFeed(bob, "limit=10&cursor=" + nextCursor1);
    JsonNode body2 = PostsITSupport.MAPPER.readTree(page2.getResponse().getContentAsString());
    assertThat(body2.get("items").size()).isEqualTo(10);
    String nextCursor2 = body2.get("nextCursor").asText();
    assertThat(nextCursor2).isNotEmpty();

    // Page 3, limit=10 — last page
    MvcResult page3 = getFeed(bob, "limit=10&cursor=" + nextCursor2);
    JsonNode body3 = PostsITSupport.MAPPER.readTree(page3.getResponse().getContentAsString());
    assertThat(body3.get("items").size()).isEqualTo(1);
    assertThat(body3.get("nextCursor").isNull()).isTrue();

    // Across the three pages: 21 distinct posts in (createdAt DESC, postId DESC) order.
    Set<UUID> seen = new HashSet<>();
    OffsetDateTime prevCreated = null;
    UUID prevId = null;
    for (JsonNode page : List.of(body1, body2, body3)) {
      for (JsonNode item : page.get("items")) {
        OffsetDateTime created = OffsetDateTime.parse(item.get("createdAt").asText());
        UUID id = UUID.fromString(item.get("id").asText());
        seen.add(id);
        if (prevCreated != null) {
          int cmp = created.compareTo(prevCreated);
          assertThat(cmp <= 0).isTrue();
          if (cmp == 0) {
            assertThat(id.compareTo(prevId) < 0).isTrue();
          }
        }
        prevCreated = created;
        prevId = id;
      }
    }
    assertThat(seen).hasSize(21);
  }

  @Test
  void getFeed_backfillCap_respected() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");

    // Seed 105 of Alice's posts directly so we don't fan out 105 times via the API.
    OffsetDateTime base = OffsetDateTime.now(ZoneOffset.UTC).minusDays(1);
    List<UUID> seeded = seedPostsDirect(alice.id(), 105, base);

    apiFollow(bob, alice.id());

    // Walk all feed pages and assert exactly 100 unique items from Alice's
    // 100 most-recent seeded posts.
    Set<UUID> seenIds = new HashSet<>();
    String cursor = null;
    while (true) {
      MvcResult res = getFeed(bob, "limit=50" + (cursor == null ? "" : "&cursor=" + cursor));
      JsonNode body = PostsITSupport.MAPPER.readTree(res.getResponse().getContentAsString());
      for (JsonNode item : body.get("items")) {
        seenIds.add(UUID.fromString(item.get("id").asText()));
      }
      if (body.get("nextCursor").isNull()) {
        break;
      }
      cursor = body.get("nextCursor").asText();
    }

    Set<UUID> expected = new HashSet<>(seeded.subList(5, 105));
    assertThat(seenIds).isEqualTo(expected);
  }

  @Test
  void getFeed_refollowIdempotent() throws Exception {
    TestUser alice = signup("Alice");
    apiCreatePost(alice, "a1");
    apiCreatePost(alice, "a2");
    apiCreatePost(alice, "a3");
    TestUser bob = signup("Bob");

    apiFollow(bob, alice.id());
    Set<FeedRow> afterFirstFollow = feedEntryRows();

    apiUnfollow(bob, alice.id());
    apiFollow(bob, alice.id());
    Set<FeedRow> afterSecondFollow = feedEntryRows();

    assertThat(afterSecondFollow).isEqualTo(afterFirstFollow);
  }

  @Test
  void getFeed_malformedCursor_returns400() throws Exception {
    TestUser alice = signup("Alice");

    mvc.perform(
            get("/api/v1/feed?cursor=not-base64url-something")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + alice.accessToken()))
        .andExpect(status().isBadRequest())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
        .andExpect(jsonPath("$.status").value(400));
  }

  @Test
  void getFeed_unauthenticated_returns401() throws Exception {
    mvc.perform(get("/api/v1/feed"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  // ---------- write-path invariants (read feed_entries directly) ----------

  @Test
  void onPostCreated_fansOutToFollowersAndSelf() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());

    UUID p1 = apiCreatePost(alice, "alice-post");

    // Two rows: (bob, p1, alice, ...) and (alice, p1, alice, ...).
    assertThat(feedEntryCountForPost(p1)).isEqualTo(2);
    Long bobRows =
        jdbc.queryForObject(
            "SELECT count(*) FROM feed_entries WHERE recipient_id = ? AND post_id = ?",
            Long.class,
            bob.id(),
            p1);
    Long aliceRows =
        jdbc.queryForObject(
            "SELECT count(*) FROM feed_entries WHERE recipient_id = ? AND post_id = ?",
            Long.class,
            alice.id(),
            p1);
    assertThat(bobRows).isEqualTo(1L);
    assertThat(aliceRows).isEqualTo(1L);
  }

  @Test
  void onPostDeleted_scrubsAllRecipients() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    apiFollow(bob, alice.id());
    UUID p1 = apiCreatePost(alice, "scrub-me");
    assertThat(feedEntryCountForPost(p1)).isEqualTo(2);

    apiSoftDeletePost(alice, p1);

    assertThat(feedEntryCountForPost(p1)).isZero();
  }

  @Test
  void onFollow_backfillsBoundedAt100() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    OffsetDateTime base = OffsetDateTime.now(ZoneOffset.UTC).minusDays(1);
    List<UUID> seeded = seedPostsDirect(alice.id(), 105, base);

    apiFollow(bob, alice.id());

    assertThat(feedEntryCount(bob.id())).isEqualTo(100);
    Set<UUID> expected = new HashSet<>(seeded.subList(5, 105));
    assertThat(feedEntryPostIds(bob.id())).isEqualTo(expected);
  }

  @Test
  void onUnfollow_scrubsRecipientByAuthor() throws Exception {
    TestUser alice = signup("Alice");
    TestUser carol = signup("Carol");
    TestUser bob = signup("Bob");

    UUID a1 = apiCreatePost(alice, "a1");
    UUID a2 = apiCreatePost(alice, "a2");
    UUID c1 = apiCreatePost(carol, "c1");
    UUID b1 = apiCreatePost(bob, "b1");
    apiFollow(bob, alice.id());
    apiFollow(bob, carol.id());

    // Sanity: Bob's feed now has b1 (self) + a1, a2 (alice) + c1 (carol) = 4 rows.
    assertThat(feedEntryCount(bob.id())).isEqualTo(4);

    apiUnfollow(bob, alice.id());

    Set<UUID> remaining = feedEntryPostIds(bob.id());
    assertThat(remaining).containsExactlyInAnyOrder(b1, c1);
    assertThat(remaining).doesNotContain(a1, a2);
  }

  // ---------- invariant: feed_entries equals canonical rebuild ----------

  @Test
  void feedEntries_equalsRebuild_acrossOperations() throws Exception {
    TestUser alice = signup("Alice");
    TestUser bob = signup("Bob");
    TestUser carol = signup("Carol");

    UUID a1 = apiCreatePost(alice, "a1");
    UUID a2 = apiCreatePost(alice, "a2");
    UUID a3 = apiCreatePost(alice, "a3");
    apiSoftDeletePost(alice, a2);

    apiFollow(bob, alice.id());
    apiFollow(bob, carol.id());

    UUID c1 = apiCreatePost(carol, "c1");
    UUID c2 = apiCreatePost(carol, "c2");

    apiUnfollow(bob, carol.id());

    apiCreatePost(alice, "a4");

    Set<FeedRow> beforeRebuild = feedEntryRows();
    feedRebuilder.rebuild();
    Set<FeedRow> afterRebuild = feedEntryRows();

    assertThat(beforeRebuild).isEqualTo(afterRebuild);
  }

  // ---------- outside-transaction guardrail ----------

  @Test
  void feedFanoutService_outsideTransaction_throws() {
    org.junit.jupiter.api.Assertions.assertThrows(
        IllegalTransactionStateException.class,
        () -> feedFanoutService.onPostDeleted(UUID.randomUUID()));
  }
}
