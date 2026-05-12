package com.prodready.social.follows;

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface FollowRepository extends JpaRepository<Follow, FollowId> {

  long countByIdFollowerId(UUID followerId);

  long countByIdFolloweeId(UUID followeeId);
}
