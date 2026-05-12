package com.prodready.social.feed;

import com.prodready.social.posts.PostListResponse;
import com.prodready.social.useraccounts.UserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
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
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
@SecurityRequirement(name = "bearerAuth")
public class FeedController {

  private final FeedService feedService;

  public FeedController(FeedService feedService) {
    this.feedService = feedService;
  }

  @Operation(
      operationId = "getFeed",
      summary = "Authenticated caller's home feed (posts by people they follow + their own)")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Page of feed entries",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = PostListResponse.class))),
    @ApiResponse(
        responseCode = "400",
        description = "Invalid cursor",
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
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @GetMapping("/feed")
  public ResponseEntity<PostListResponse> getFeed(
      @AuthenticationPrincipal UserPrincipal principal,
      @Parameter(description = "Opaque cursor returned in `nextCursor`")
          @RequestParam(name = "cursor", required = false)
          String cursor,
      @Parameter(description = "Page size; default 20, max 50")
          @RequestParam(name = "limit", required = false)
          Integer limit) {
    UUID callerId = requirePrincipal(principal).id();
    return ResponseEntity.ok(feedService.findPage(callerId, cursor, limit));
  }

  private static UserPrincipal requirePrincipal(UserPrincipal principal) {
    if (principal == null) {
      throw new InsufficientAuthenticationException("No principal");
    }
    return principal;
  }
}
