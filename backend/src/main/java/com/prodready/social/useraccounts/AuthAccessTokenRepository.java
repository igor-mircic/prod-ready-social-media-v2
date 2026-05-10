package com.prodready.social.useraccounts;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuthAccessTokenRepository extends JpaRepository<AuthAccessToken, UUID> {
  Optional<AuthAccessToken> findByTokenHash(String tokenHash);
}
