package com.prodready.social.posts;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "posts")
public class Post {

  @Id
  @Column(nullable = false, updatable = false)
  private UUID id;

  @Column(name = "author_id", nullable = false, updatable = false)
  private UUID authorId;

  @Column(nullable = false)
  private String body;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @Column(name = "deleted_at")
  private OffsetDateTime deletedAt;

  protected Post() {
    // JPA
  }

  public Post(UUID id, UUID authorId, String body) {
    this.id = id;
    this.authorId = authorId;
    this.body = body;
  }

  public UUID getId() {
    return id;
  }

  public UUID getAuthorId() {
    return authorId;
  }

  public String getBody() {
    return body;
  }

  public OffsetDateTime getCreatedAt() {
    return createdAt;
  }

  public OffsetDateTime getDeletedAt() {
    return deletedAt;
  }

  public void softDelete(OffsetDateTime when) {
    this.deletedAt = when;
  }

  @PrePersist
  void onCreate() {
    if (createdAt == null) {
      createdAt = OffsetDateTime.now();
    }
  }
}
