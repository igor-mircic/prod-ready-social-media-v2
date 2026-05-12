package com.prodready.social.follows;

import com.prodready.social.useraccounts.UserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
@SecurityRequirement(name = "bearerAuth")
public class FollowsController {

  private final FollowService followService;

  public FollowsController(FollowService followService) {
    this.followService = followService;
  }

  @Operation(operationId = "followUser", summary = "Follow a user")
  @ApiResponses({
    @ApiResponse(responseCode = "204", description = "Follow recorded"),
    @ApiResponse(
        responseCode = "400",
        description = "Self-follow is not allowed",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "User not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @PostMapping("/users/{userId}/follow")
  public ResponseEntity<Void> followUser(
      @AuthenticationPrincipal UserPrincipal principal, @PathVariable("userId") UUID userId) {
    UUID callerId = requirePrincipal(principal).id();
    followService.follow(callerId, userId);
    return ResponseEntity.noContent().build();
  }

  @Operation(operationId = "unfollowUser", summary = "Unfollow a user")
  @ApiResponses({
    @ApiResponse(responseCode = "204", description = "Follow removed"),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "User not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @DeleteMapping("/users/{userId}/follow")
  public ResponseEntity<Void> unfollowUser(
      @AuthenticationPrincipal UserPrincipal principal, @PathVariable("userId") UUID userId) {
    UUID callerId = requirePrincipal(principal).id();
    followService.unfollow(callerId, userId);
    return ResponseEntity.noContent().build();
  }

  @Operation(
      operationId = "getFollowStats",
      summary = "Follow stats for a user (counts + viewer relationship)")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Follow stats",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = FollowStatsResponse.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "User not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @GetMapping("/users/{userId}/follow-stats")
  public ResponseEntity<FollowStatsResponse> getFollowStats(
      @AuthenticationPrincipal UserPrincipal principal, @PathVariable("userId") UUID userId) {
    UUID callerId = requirePrincipal(principal).id();
    return ResponseEntity.ok(followService.stats(callerId, userId));
  }

  private static UserPrincipal requirePrincipal(UserPrincipal principal) {
    if (principal == null) {
      throw new InsufficientAuthenticationException("No principal");
    }
    return principal;
  }
}
