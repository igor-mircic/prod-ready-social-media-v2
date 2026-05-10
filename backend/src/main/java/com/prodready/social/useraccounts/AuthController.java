package com.prodready.social.useraccounts;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Duration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

  static final String REFRESH_COOKIE_NAME = "refresh_token";
  static final String REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

  private final SignupService signupService;
  private final LoginService loginService;
  private final AuthTokenService authTokenService;
  private final UserRepository userRepository;
  private final AuthTokenProperties tokenProperties;

  public AuthController(
      SignupService signupService,
      LoginService loginService,
      AuthTokenService authTokenService,
      UserRepository userRepository,
      AuthTokenProperties tokenProperties) {
    this.signupService = signupService;
    this.loginService = loginService;
    this.authTokenService = authTokenService;
    this.userRepository = userRepository;
    this.tokenProperties = tokenProperties;
  }

  @Operation(summary = "Register a new user account")
  @ApiResponses({
    @ApiResponse(
        responseCode = "201",
        description = "Account created",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = UserResponse.class))),
    @ApiResponse(
        responseCode = "400",
        description = "Validation failed",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "409",
        description = "Email already registered",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @PostMapping("/signup")
  public ResponseEntity<UserResponse> signup(@Valid @RequestBody SignupRequest request) {
    UserResponse body = signupService.signup(request);
    return ResponseEntity.status(HttpStatus.CREATED).body(body);
  }

  @Operation(summary = "Log in with email and password")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Logged in",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = LoginResponse.class))),
    @ApiResponse(
        responseCode = "400",
        description = "Validation failed",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Invalid credentials",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @PostMapping("/login")
  public ResponseEntity<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
    LoginService.LoginResult result = loginService.login(request.email(), request.password());
    ResponseCookie cookie = buildRefreshCookie(result.refreshTokenPlaintext());
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, cookie.toString())
        .body(new LoginResponse(result.accessTokenPlaintext(), result.accessTokenExpiresInSeconds()));
  }

  @Operation(summary = "Rotate the refresh token and mint a new access token")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Refreshed",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = LoginResponse.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Invalid refresh token",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @PostMapping("/refresh")
  public ResponseEntity<LoginResponse> refresh(
      @CookieValue(name = REFRESH_COOKIE_NAME, required = false) String refreshCookie) {
    if (refreshCookie == null || refreshCookie.isEmpty()) {
      throw new InvalidRefreshTokenException();
    }
    AuthTokenService.RotatedTokens rotated = authTokenService.rotateRefreshToken(refreshCookie);
    long expiresIn =
        Math.max(
            0,
            Duration.between(java.time.OffsetDateTime.now(), rotated.accessToken().expiresAt())
                .toSeconds());
    ResponseCookie cookie = buildRefreshCookie(rotated.refreshToken().plaintext());
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, cookie.toString())
        .body(new LoginResponse(rotated.accessToken().plaintext(), expiresIn));
  }

  @Operation(summary = "Revoke the caller's tokens and clear the refresh cookie")
  @ApiResponses({
    @ApiResponse(responseCode = "204", description = "Logged out"),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @SecurityRequirement(name = "bearerAuth")
  @PostMapping("/logout")
  public ResponseEntity<Void> logout(
      HttpServletRequest request,
      @CookieValue(name = REFRESH_COOKIE_NAME, required = false) String refreshCookie) {
    BearerTokenAuthenticationFilter.extractBearerToken(request)
        .ifPresent(authTokenService::revokeAccessToken);
    if (refreshCookie != null && !refreshCookie.isEmpty()) {
      authTokenService.revokeRefreshToken(refreshCookie);
    }
    ResponseCookie clearing = buildClearingRefreshCookie();
    return ResponseEntity.status(HttpStatus.NO_CONTENT)
        .header(HttpHeaders.SET_COOKIE, clearing.toString())
        .build();
  }

  @Operation(summary = "Return the authenticated user")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Current user",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = UserResponse.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @SecurityRequirement(name = "bearerAuth")
  @GetMapping("/me")
  public ResponseEntity<UserResponse> me(@AuthenticationPrincipal UserPrincipal principal, Authentication authentication) {
    UserPrincipal effective =
        principal != null
            ? principal
            : (authentication != null && authentication.getPrincipal() instanceof UserPrincipal up
                ? up
                : null);
    if (effective == null) {
      throw new org.springframework.security.authentication.InsufficientAuthenticationException(
          "No principal");
    }
    User user =
        userRepository
            .findById(effective.id())
            .orElseThrow(
                () ->
                    new org.springframework.security.authentication.InsufficientAuthenticationException(
                        "User no longer exists"));
    return ResponseEntity.ok(UserResponse.fromEntity(user));
  }

  private ResponseCookie buildRefreshCookie(String plaintext) {
    return ResponseCookie.from(REFRESH_COOKIE_NAME, plaintext)
        .httpOnly(true)
        .secure(true)
        .sameSite("Lax")
        .path(REFRESH_COOKIE_PATH)
        .maxAge(tokenProperties.refreshTokenTtl())
        .build();
  }

  private ResponseCookie buildClearingRefreshCookie() {
    return ResponseCookie.from(REFRESH_COOKIE_NAME, "")
        .httpOnly(true)
        .secure(true)
        .sameSite("Lax")
        .path(REFRESH_COOKIE_PATH)
        .maxAge(0)
        .build();
  }
}
