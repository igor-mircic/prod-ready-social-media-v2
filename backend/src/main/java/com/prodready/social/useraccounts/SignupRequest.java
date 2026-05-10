package com.prodready.social.useraccounts;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record SignupRequest(
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED, format = "email") @NotBlank @Email
        String email,
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED) @NotBlank @Size(min = 8) String password,
    @Schema(requiredMode = Schema.RequiredMode.REQUIRED) @NotBlank @Size(max = 80)
        String displayName) {}
