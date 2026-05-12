package com.prodready.social.feed;

import com.prodready.social.posts.Post;
import java.util.UUID;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The single helper that mutates {@code feed_entries} in production code paths. Every method
 * declares {@link Propagation#MANDATORY} so a caller that forgot an enclosing
 * {@code @Transactional} fails with {@code IllegalTransactionStateException} at first call instead
 * of producing silently split-transaction data drift.
 *
 * <p>All four maintenance statements are direct SQL through {@link NamedParameterJdbcTemplate} (not
 * entity-by-entity JPA inserts) so each operation is exactly one round trip to the database
 * regardless of follower count or backfill size.
 */
@Service
@Transactional(propagation = Propagation.MANDATORY)
public class FeedFanoutService {

  private final NamedParameterJdbcTemplate jdbc;

  public FeedFanoutService(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public void onPostCreated(Post post) {
    MapSqlParameterSource params =
        new MapSqlParameterSource()
            .addValue("postId", post.getId())
            .addValue("authorId", post.getAuthorId())
            .addValue("createdAt", post.getCreatedAt());
    jdbc.update(
        "INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)"
            + " SELECT follower_id, :postId, :authorId, :createdAt"
            + "   FROM follows WHERE followee_id = :authorId"
            + " UNION ALL"
            + " SELECT :authorId, :postId, :authorId, :createdAt"
            + " ON CONFLICT (recipient_id, post_id) DO NOTHING",
        params);
  }

  public void onPostDeleted(UUID postId) {
    jdbc.update(
        "DELETE FROM feed_entries WHERE post_id = :postId",
        new MapSqlParameterSource("postId", postId));
  }

  public void onFollow(UUID followerId, UUID followeeId) {
    MapSqlParameterSource params =
        new MapSqlParameterSource()
            .addValue("followerId", followerId)
            .addValue("followeeId", followeeId);
    jdbc.update(
        "INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)"
            + " SELECT :followerId, p.id, p.author_id, p.created_at"
            + "   FROM posts p"
            + "  WHERE p.author_id = :followeeId AND p.deleted_at IS NULL"
            + "  ORDER BY p.created_at DESC, p.id DESC"
            + "  LIMIT 100"
            + " ON CONFLICT (recipient_id, post_id) DO NOTHING",
        params);
  }

  public void onUnfollow(UUID followerId, UUID followeeId) {
    // Self-unfollow must NOT scrub the caller's own self-fanout rows: the
    // self-fanout invariant requires (self, *, self, *) rows to remain even
    // after a self-unfollow no-op. See Decision 11 + tasks.md 4.4.
    if (followerId.equals(followeeId)) {
      return;
    }
    MapSqlParameterSource params =
        new MapSqlParameterSource()
            .addValue("followerId", followerId)
            .addValue("followeeId", followeeId);
    jdbc.update(
        "DELETE FROM feed_entries"
            + " WHERE recipient_id = :followerId AND author_id = :followeeId",
        params);
  }
}
