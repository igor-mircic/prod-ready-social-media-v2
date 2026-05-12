package com.prodready.social.useraccounts;

import java.util.UUID;

public record UserSummary(UUID id, String displayName) {

  public static UserSummary fromEntity(User user) {
    return new UserSummary(user.getId(), user.getDisplayName());
  }
}
