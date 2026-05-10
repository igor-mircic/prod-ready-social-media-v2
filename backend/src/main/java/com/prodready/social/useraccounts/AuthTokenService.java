package com.prodready.social.useraccounts;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthTokenService {

  private static final int TOKEN_BYTES = 32;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final AuthAccessTokenRepository accessTokens;
  private final AuthRefreshTokenRepository refreshTokens;
  private final AuthTokenProperties properties;

  public AuthTokenService(
      AuthAccessTokenRepository accessTokens,
      AuthRefreshTokenRepository refreshTokens,
      AuthTokenProperties properties) {
    this.accessTokens = accessTokens;
    this.refreshTokens = refreshTokens;
    this.properties = properties;
  }

  public record MintedToken(String plaintext, OffsetDateTime expiresAt) {}

  public record RotatedTokens(MintedToken accessToken, MintedToken refreshToken) {}

  @Transactional
  public MintedToken mintAccessToken(UUID userId) {
    String plaintext = generatePlaintext();
    String hash = sha256(plaintext);
    OffsetDateTime expiresAt = OffsetDateTime.now().plus(properties.accessTokenTtl());
    AuthAccessToken row = new AuthAccessToken(UUID.randomUUID(), userId, hash, expiresAt);
    accessTokens.save(row);
    return new MintedToken(plaintext, expiresAt);
  }

  @Transactional
  public MintedToken mintRefreshToken(UUID userId) {
    String plaintext = generatePlaintext();
    String hash = sha256(plaintext);
    OffsetDateTime expiresAt = OffsetDateTime.now().plus(properties.refreshTokenTtl());
    AuthRefreshToken row = new AuthRefreshToken(UUID.randomUUID(), userId, hash, expiresAt);
    refreshTokens.save(row);
    return new MintedToken(plaintext, expiresAt);
  }

  @Transactional(readOnly = true)
  public Optional<AuthAccessToken> findActiveAccessToken(String plaintext) {
    if (plaintext == null || plaintext.isEmpty()) return Optional.empty();
    return accessTokens.findByTokenHash(sha256(plaintext)).filter(this::isActive);
  }

  @Transactional(readOnly = true)
  public Optional<AuthRefreshToken> findActiveRefreshToken(String plaintext) {
    if (plaintext == null || plaintext.isEmpty()) return Optional.empty();
    return refreshTokens.findByTokenHash(sha256(plaintext)).filter(this::isActive);
  }

  @Transactional
  public void revokeAccessToken(String plaintext) {
    if (plaintext == null || plaintext.isEmpty()) return;
    accessTokens
        .findByTokenHash(sha256(plaintext))
        .ifPresent(
            row -> {
              if (row.getRevokedAt() == null) {
                row.revoke(OffsetDateTime.now());
                accessTokens.save(row);
              }
            });
  }

  @Transactional
  public void revokeRefreshToken(String plaintext) {
    if (plaintext == null || plaintext.isEmpty()) return;
    refreshTokens
        .findByTokenHash(sha256(plaintext))
        .ifPresent(
            row -> {
              if (row.getRevokedAt() == null) {
                row.revoke(OffsetDateTime.now());
                refreshTokens.save(row);
              }
            });
  }

  @Transactional
  public RotatedTokens rotateRefreshToken(String plaintext) {
    AuthRefreshToken existing =
        findActiveRefreshToken(plaintext).orElseThrow(InvalidRefreshTokenException::new);

    UUID userId = existing.getUserId();

    String newPlaintext = generatePlaintext();
    String newHash = sha256(newPlaintext);
    OffsetDateTime expiresAt = OffsetDateTime.now().plus(properties.refreshTokenTtl());
    AuthRefreshToken replacement =
        new AuthRefreshToken(UUID.randomUUID(), userId, newHash, expiresAt);
    refreshTokens.save(replacement);

    existing.revokeAndReplace(OffsetDateTime.now(), replacement.getId());
    refreshTokens.save(existing);

    MintedToken access = mintAccessToken(userId);
    return new RotatedTokens(access, new MintedToken(newPlaintext, expiresAt));
  }

  private boolean isActive(AuthAccessToken row) {
    return row.getRevokedAt() == null && row.getExpiresAt().isAfter(OffsetDateTime.now());
  }

  private boolean isActive(AuthRefreshToken row) {
    return row.getRevokedAt() == null && row.getExpiresAt().isAfter(OffsetDateTime.now());
  }

  private static String generatePlaintext() {
    byte[] buf = new byte[TOKEN_BYTES];
    RANDOM.nextBytes(buf);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
  }

  static String sha256(String input) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      byte[] hash = md.digest(input.getBytes(StandardCharsets.UTF_8));
      return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 not available", e);
    }
  }
}
