package com.prodready.social.feed;

import java.time.OffsetDateTime;
import java.util.UUID;

public interface FeedItemView {

  UUID getPostId();

  UUID getAuthorId();

  String getAuthorDisplayName();

  String getBody();

  OffsetDateTime getCreatedAt();
}
