package com.prodready.social.useraccounts;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

public record LoginRequest(
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED, format = "email") @NotBlank @Email
        String email,
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED) @NotBlank String password) {}
