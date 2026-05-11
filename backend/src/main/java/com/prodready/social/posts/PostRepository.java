package com.prodready.social.posts;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface PostRepository extends JpaRepository<Post, UUID> {

  @Query("select p from Post p where p.id = :id and p.deletedAt is null")
  Optional<Post> findActiveById(@Param("id") UUID id);

  @Query(
      "select p from Post p"
          + " where p.authorId = :authorId"
          + " and p.deletedAt is null"
          + " order by p.createdAt desc, p.id desc")
  List<Post> findFirstPageByAuthor(@Param("authorId") UUID authorId, Limit limit);

  @Query(
      "select p from Post p"
          + " where p.authorId = :authorId"
          + " and p.deletedAt is null"
          + " and (p.createdAt < :cursorCreatedAt"
          + "   or (p.createdAt = :cursorCreatedAt and p.id < :cursorId))"
          + " order by p.createdAt desc, p.id desc")
  List<Post> findPageByAuthorBeforeCursor(
      @Param("authorId") UUID authorId,
      @Param("cursorCreatedAt") OffsetDateTime cursorCreatedAt,
      @Param("cursorId") UUID cursorId,
      Limit limit);
}
