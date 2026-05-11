package com.prodready.social.posts;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;

public record PostListResponse(
    List<PostResponse> items, @Schema(nullable = true) String nextCursor) {}
