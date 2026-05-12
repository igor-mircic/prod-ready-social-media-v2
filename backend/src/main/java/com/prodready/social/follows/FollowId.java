package com.prodready.social.follows;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class FollowId implements Serializable {

  @Column(name = "follower_id", nullable = false, updatable = false)
  private UUID followerId;

  @Column(name = "followee_id", nullable = false, updatable = false)
  private UUID followeeId;

  protected FollowId() {
    // JPA
  }

  public FollowId(UUID followerId, UUID followeeId) {
    this.followerId = followerId;
    this.followeeId = followeeId;
  }

  public UUID getFollowerId() {
    return followerId;
  }

  public UUID getFolloweeId() {
    return followeeId;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) {
      return true;
    }
    if (!(o instanceof FollowId other)) {
      return false;
    }
    return Objects.equals(followerId, other.followerId)
        && Objects.equals(followeeId, other.followeeId);
  }

  @Override
  public int hashCode() {
    return Objects.hash(followerId, followeeId);
  }
}
