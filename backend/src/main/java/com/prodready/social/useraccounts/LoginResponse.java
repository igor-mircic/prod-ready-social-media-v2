package com.prodready.social.useraccounts;

import io.swagger.v3.oas.annotations.media.Schema;

public record LoginResponse(
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED) String accessToken,
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED) long expiresIn) {}
