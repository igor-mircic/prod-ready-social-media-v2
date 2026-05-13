package com.prodready.social.posts;

import com.prodready.social.feed.FeedFanoutService;
import com.prodready.social.useraccounts.User;
import com.prodready.social.useraccounts.UserRepository;
import io.micrometer.core.annotation.Timed;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PostService {

  static final int DEFAULT_LIMIT = 20;
  static final int MAX_LIMIT = 50;

  private final PostRepository postRepository;
  private final UserRepository userRepository;
  private final PostCursorCodec cursorCodec;
  private final FeedFanoutService feedFanoutService;

  public PostService(
      PostRepository postRepository,
      UserRepository userRepository,
      PostCursorCodec cursorCodec,
      FeedFanoutService feedFanoutService) {
    this.postRepository = postRepository;
    this.userRepository = userRepository;
    this.cursorCodec = cursorCodec;
    this.feedFanoutService = feedFanoutService;
  }

  @Transactional
  @Timed("posts.create.duration")
  public PostResponse create(UUID callerId, CreatePostRequest request) {
    Post post = new Post(UUID.randomUUID(), callerId, request.body());
    // Flush so the posts row exists before the fanout INSERT references it via FK.
    Post saved = postRepository.saveAndFlush(post);
    feedFanoutService.onPostCreated(saved);
    return assemble(List.of(saved)).get(0);
  }

  @Transactional(readOnly = true)
  public PostResponse getById(UUID id) {
    Post post = postRepository.findActiveById(id).orElseThrow(PostNotFoundException::new);
    return assemble(List.of(post)).get(0);
  }

  @Transactional(readOnly = true)
  public PostListResponse listByAuthor(UUID authorId, String cursor, Integer limit) {
    if (!userRepository.existsById(authorId)) {
      throw new AuthorNotFoundException();
    }
    int effectiveLimit = clampLimit(limit);
    Limit fetchLimit = Limit.of(effectiveLimit + 1);

    List<Post> rows;
    if (cursor == null || cursor.isEmpty()) {
      rows = postRepository.findFirstPageByAuthor(authorId, fetchLimit);
    } else {
      PostCursorCodec.DecodedCursor decoded = cursorCodec.decode(cursor);
      rows =
          postRepository.findPageByAuthorBeforeCursor(
              authorId, decoded.createdAt(), decoded.id(), fetchLimit);
    }

    String nextCursor = null;
    List<Post> kept = rows;
    if (rows.size() > effectiveLimit) {
      kept = rows.subList(0, effectiveLimit);
      Post last = kept.get(kept.size() - 1);
      nextCursor = cursorCodec.encode(last.getCreatedAt(), last.getId());
    }

    List<PostResponse> items = assemble(kept);
    return new PostListResponse(items, nextCursor);
  }

  @Transactional
  public void delete(UUID callerId, UUID postId) {
    Post post = postRepository.findById(postId).orElseThrow(PostNotFoundException::new);
    if (post.getDeletedAt() != null) {
      throw new PostNotFoundException();
    }
    if (!post.getAuthorId().equals(callerId)) {
      // Folded into 404 to avoid leaking existence to non-authors.
      throw new PostNotFoundException();
    }
    post.softDelete(OffsetDateTime.now());
    postRepository.save(post);
    feedFanoutService.onPostDeleted(postId);
  }

  private static int clampLimit(Integer requested) {
    if (requested == null) {
      return DEFAULT_LIMIT;
    }
    if (requested < 1) {
      return 1;
    }
    return Math.min(requested, MAX_LIMIT);
  }

  private List<PostResponse> assemble(List<Post> posts) {
    if (posts.isEmpty()) {
      return List.of();
    }
    List<UUID> authorIds = posts.stream().map(Post::getAuthorId).distinct().toList();
    Map<UUID, User> authors = new LinkedHashMap<>();
    for (User u : userRepository.findAllById(authorIds)) {
      authors.put(u.getId(), u);
    }
    return posts.stream()
        .map(
            p -> {
              User author = authors.get(p.getAuthorId());
              AuthorSummary summary =
                  author != null
                      ? new AuthorSummary(author.getId(), author.getDisplayName())
                      : new AuthorSummary(p.getAuthorId(), "");
              return new PostResponse(p.getId(), summary, p.getBody(), p.getCreatedAt());
            })
        .toList();
  }
}
