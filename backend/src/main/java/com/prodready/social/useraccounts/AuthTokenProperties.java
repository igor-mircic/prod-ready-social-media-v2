package com.prodready.social.useraccounts;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.auth")
public record AuthTokenProperties(Duration accessTokenTtl, Duration refreshTokenTtl) {

  public AuthTokenProperties {
    if (accessTokenTtl == null) {
      accessTokenTtl = Duration.ofMinutes(15);
    }
    if (refreshTokenTtl == null) {
      refreshTokenTtl = Duration.ofDays(30);
    }
  }
}
