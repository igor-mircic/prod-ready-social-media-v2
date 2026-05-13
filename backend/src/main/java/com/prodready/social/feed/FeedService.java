package com.prodready.social.feed;

import com.prodready.social.posts.AuthorSummary;
import com.prodready.social.posts.PostCursorCodec;
import com.prodready.social.posts.PostListResponse;
import com.prodready.social.posts.PostResponse;
import io.micrometer.core.annotation.Timed;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class FeedService {

  static final int DEFAULT_LIMIT = 20;
  static final int MAX_LIMIT = 50;

  private final FeedEntryRepository feedEntryRepository;
  private final PostCursorCodec cursorCodec;

  public FeedService(FeedEntryRepository feedEntryRepository, PostCursorCodec cursorCodec) {
    this.feedEntryRepository = feedEntryRepository;
    this.cursorCodec = cursorCodec;
  }

  @Timed("feed.read.duration")
  public PostListResponse findPage(UUID callerId, String cursor, Integer limit) {
    int effectiveLimit = clampLimit(limit);
    Limit fetchLimit = Limit.of(effectiveLimit + 1);

    List<FeedItemView> rows;
    if (cursor == null || cursor.isEmpty()) {
      rows = feedEntryRepository.findFirstPage(callerId, fetchLimit);
    } else {
      PostCursorCodec.DecodedCursor decoded = cursorCodec.decode(cursor);
      rows =
          feedEntryRepository.findPageBeforeCursor(
              callerId, decoded.createdAt(), decoded.id(), fetchLimit);
    }

    String nextCursor = null;
    List<FeedItemView> kept = rows;
    if (rows.size() > effectiveLimit) {
      kept = rows.subList(0, effectiveLimit);
      FeedItemView last = kept.get(kept.size() - 1);
      nextCursor = cursorCodec.encode(last.getCreatedAt(), last.getPostId());
    }

    List<PostResponse> items = new ArrayList<>(kept.size());
    for (FeedItemView v : kept) {
      items.add(
          new PostResponse(
              v.getPostId(),
              new AuthorSummary(v.getAuthorId(), v.getAuthorDisplayName()),
              v.getBody(),
              v.getCreatedAt()));
    }
    return new PostListResponse(items, nextCursor);
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
}
