package com.prodready.social.useraccounts;

import java.time.Duration;
import java.time.OffsetDateTime;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class LoginService {

  private final UserRepository userRepository;
  private final PasswordEncoder passwordEncoder;
  private final AuthTokenService tokenService;

  public LoginService(
      UserRepository userRepository,
      PasswordEncoder passwordEncoder,
      AuthTokenService tokenService) {
    this.userRepository = userRepository;
    this.passwordEncoder = passwordEncoder;
    this.tokenService = tokenService;
  }

  public record LoginResult(
      String accessTokenPlaintext,
      long accessTokenExpiresInSeconds,
      String refreshTokenPlaintext) {}

  @Transactional
  public LoginResult login(String email, String password) {
    User user =
        userRepository
            .findByEmail(email)
            .orElseThrow(() -> new BadCredentialsException("Invalid email or password"));
    if (!passwordEncoder.matches(password, user.getPasswordHash())) {
      throw new BadCredentialsException("Invalid email or password");
    }
    AuthTokenService.MintedToken access = tokenService.mintAccessToken(user.getId());
    AuthTokenService.MintedToken refresh = tokenService.mintRefreshToken(user.getId());
    long expiresIn =
        Math.max(0, Duration.between(OffsetDateTime.now(), access.expiresAt()).toSeconds());
    return new LoginResult(access.plaintext(), expiresIn, refresh.plaintext());
  }
}
