package com.prodready.social.feed;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "feed_entries")
public class FeedEntry {

  @EmbeddedId private FeedEntryId id;

  @Column(name = "author_id", nullable = false)
  private UUID authorId;

  @Column(name = "created_at", nullable = false)
  private OffsetDateTime createdAt;

  protected FeedEntry() {
    // JPA
  }

  public FeedEntry(FeedEntryId id, UUID authorId, OffsetDateTime createdAt) {
    this.id = id;
    this.authorId = authorId;
    this.createdAt = createdAt;
  }

  public FeedEntryId getId() {
    return id;
  }

  public UUID getAuthorId() {
    return authorId;
  }

  public OffsetDateTime getCreatedAt() {
    return createdAt;
  }
}
