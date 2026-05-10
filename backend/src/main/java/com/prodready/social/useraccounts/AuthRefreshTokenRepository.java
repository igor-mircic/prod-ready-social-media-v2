package com.prodready.social.useraccounts;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuthRefreshTokenRepository extends JpaRepository<AuthRefreshToken, UUID> {
  Optional<AuthRefreshToken> findByTokenHash(String tokenHash);
}
