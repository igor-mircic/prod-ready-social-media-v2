package com.prodready.social.follows;

import com.prodready.social.feed.FeedFanoutService;
import com.prodready.social.useraccounts.UserRepository;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class FollowService {

  private final FollowRepository followRepository;
  private final UserRepository userRepository;
  private final FeedFanoutService feedFanoutService;

  public FollowService(
      FollowRepository followRepository,
      UserRepository userRepository,
      FeedFanoutService feedFanoutService) {
    this.followRepository = followRepository;
    this.userRepository = userRepository;
    this.feedFanoutService = feedFanoutService;
  }

  @Transactional
  public void follow(UUID callerId, UUID targetId) {
    if (callerId.equals(targetId)) {
      throw new SelfFollowException();
    }
    requireUserExists(targetId);
    FollowId id = new FollowId(callerId, targetId);
    if (!followRepository.existsById(id)) {
      followRepository.save(new Follow(id));
    }
    // Idempotent path: re-follow backfill is harmless thanks to ON CONFLICT in the helper.
    feedFanoutService.onFollow(callerId, targetId);
  }

  @Transactional
  public void unfollow(UUID callerId, UUID targetId) {
    requireUserExists(targetId);
    FollowId id = new FollowId(callerId, targetId);
    try {
      followRepository.deleteById(id);
    } catch (EmptyResultDataAccessException ignored) {
      // Idempotent: a missing row is a no-op.
    }
    feedFanoutService.onUnfollow(callerId, targetId);
  }

  @Transactional(readOnly = true)
  public FollowStatsResponse stats(UUID callerId, UUID targetId) {
    requireUserExists(targetId);
    long followers = followRepository.countByIdFolloweeId(targetId);
    long following = followRepository.countByIdFollowerId(targetId);
    boolean viewerFollows =
        !callerId.equals(targetId) && followRepository.existsById(new FollowId(callerId, targetId));
    return new FollowStatsResponse(followers, following, viewerFollows);
  }

  private void requireUserExists(UUID userId) {
    if (!userRepository.existsById(userId)) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found");
    }
  }
}
