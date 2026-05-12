package com.prodready.social.feed;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Returns row-projection views ({@link FeedItemView}) that already carry the post body and author
 * display name, so a single round trip is enough to build the {@code PostResponse} list (Decision 5
 * in {@code design.md}).
 */
public interface FeedEntryRepository extends JpaRepository<FeedEntry, FeedEntryId> {

  @Query(
      "select fe.id.postId as postId,"
          + " fe.authorId as authorId,"
          + " u.displayName as authorDisplayName,"
          + " p.body as body,"
          + " fe.createdAt as createdAt"
          + " from FeedEntry fe"
          + " join Post p on p.id = fe.id.postId"
          + " join User u on u.id = fe.authorId"
          + " where fe.id.recipientId = :recipientId"
          + " and p.deletedAt is null"
          + " order by fe.createdAt desc, fe.id.postId desc")
  List<FeedItemView> findFirstPage(@Param("recipientId") UUID recipientId, Limit limit);

  @Query(
      "select fe.id.postId as postId,"
          + " fe.authorId as authorId,"
          + " u.displayName as authorDisplayName,"
          + " p.body as body,"
          + " fe.createdAt as createdAt"
          + " from FeedEntry fe"
          + " join Post p on p.id = fe.id.postId"
          + " join User u on u.id = fe.authorId"
          + " where fe.id.recipientId = :recipientId"
          + " and p.deletedAt is null"
          + " and (fe.createdAt < :cursorCreatedAt"
          + "   or (fe.createdAt = :cursorCreatedAt and fe.id.postId < :cursorPostId))"
          + " order by fe.createdAt desc, fe.id.postId desc")
  List<FeedItemView> findPageBeforeCursor(
      @Param("recipientId") UUID recipientId,
      @Param("cursorCreatedAt") OffsetDateTime cursorCreatedAt,
      @Param("cursorPostId") UUID cursorPostId,
      Limit limit);
}
