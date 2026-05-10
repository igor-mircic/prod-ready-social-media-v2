package com.prodready.social.useraccounts;

import java.time.OffsetDateTime;
import java.util.UUID;

public record UserResponse(UUID id, String email, String displayName, OffsetDateTime createdAt) {

  public static UserResponse fromEntity(User user) {
    return new UserResponse(
        user.getId(), user.getEmail(), user.getDisplayName(), user.getCreatedAt());
  }
}
