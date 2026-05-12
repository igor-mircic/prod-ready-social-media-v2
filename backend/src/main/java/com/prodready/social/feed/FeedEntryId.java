package com.prodready.social.feed;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class FeedEntryId implements Serializable {

  @Column(name = "recipient_id", nullable = false, updatable = false)
  private UUID recipientId;

  @Column(name = "post_id", nullable = false, updatable = false)
  private UUID postId;

  protected FeedEntryId() {
    // JPA
  }

  public FeedEntryId(UUID recipientId, UUID postId) {
    this.recipientId = recipientId;
    this.postId = postId;
  }

  public UUID getRecipientId() {
    return recipientId;
  }

  public UUID getPostId() {
    return postId;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (!(o instanceof FeedEntryId other)) {
      return false;
    }
    return Objects.equals(recipientId, other.recipientId) && Objects.equals(postId, other.postId);
  }

  @Override
  public int hashCode() {
    return Objects.hash(recipientId, postId);
  }
}
