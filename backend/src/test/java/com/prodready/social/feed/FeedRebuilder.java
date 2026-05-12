package com.prodready.social.feed;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Invariant-test infrastructure: NOT a production code path. {@link
 * com.prodready.social.feed.FeedFanoutService} is the only code that mutates {@code feed_entries}
 * in production. This rebuild derives {@code feed_entries} from the canonical sources of truth
 * ({@code posts}, {@code follows}) and the integration test asserts the equality between the
 * helper-maintained state and the rebuild output. See Decision 9 in {@code design.md}.
 */
@Service
public class FeedRebuilder {

  private final JdbcTemplate jdbc;

  public FeedRebuilder(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Transactional
  public void rebuild() {
    jdbc.update("TRUNCATE feed_entries");
    jdbc.update(
        "INSERT INTO feed_entries (recipient_id, post_id, author_id, created_at)"
            + " SELECT f.follower_id, p.id, p.author_id, p.created_at"
            + "   FROM follows f JOIN posts p ON p.author_id = f.followee_id"
            + "  WHERE p.deleted_at IS NULL"
            + " UNION"
            + " SELECT p.author_id, p.id, p.author_id, p.created_at"
            + "   FROM posts p WHERE p.deleted_at IS NULL");
  }
}
