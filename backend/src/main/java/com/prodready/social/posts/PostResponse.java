package com.prodready.social.posts;

import java.time.OffsetDateTime;
import java.util.UUID;

public record PostResponse(UUID id, AuthorSummary author, String body, OffsetDateTime createdAt) {}
