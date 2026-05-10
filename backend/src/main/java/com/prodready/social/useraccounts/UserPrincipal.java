package com.prodready.social.useraccounts;

import java.util.UUID;

public record UserPrincipal(UUID id, String email, String displayName) {

  public static UserPrincipal fromUser(User user) {
    return new UserPrincipal(user.getId(), user.getEmail(), user.getDisplayName());
  }
}
