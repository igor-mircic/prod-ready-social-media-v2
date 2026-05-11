package com.prodready.social.posts;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreatePostRequest(
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED, maxLength = 500)
        @NotBlank
        @Size(max = 500)
        String body) {}
