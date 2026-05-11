package com.prodready.social.posts;

import com.prodready.social.useraccounts.UserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
@SecurityRequirement(name = "bearerAuth")
public class PostsController {

  private final PostService postService;

  public PostsController(PostService postService) {
    this.postService = postService;
  }

  @Operation(operationId = "createPost", summary = "Create a new post")
  @ApiResponses({
    @ApiResponse(
        responseCode = "201",
        description = "Post created",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = PostResponse.class))),
    @ApiResponse(
        responseCode = "400",
        description = "Validation failed",
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
  @PostMapping("/posts")
  public ResponseEntity<PostResponse> createPost(
      @AuthenticationPrincipal UserPrincipal principal,
      @Valid @RequestBody CreatePostRequest request) {
    UUID callerId = requirePrincipal(principal).id();
    PostResponse body = postService.create(callerId, request);
    return ResponseEntity.status(HttpStatus.CREATED).body(body);
  }

  @Operation(operationId = "getPostById", summary = "Read a post by id")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Post",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_JSON_VALUE,
                schema = @Schema(implementation = PostResponse.class))),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "Post not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @GetMapping("/posts/{id}")
  public ResponseEntity<PostResponse> getPostById(@PathVariable("id") UUID id) {
    return ResponseEntity.ok(postService.getById(id));
  }

  @Operation(operationId = "listPostsByAuthor", summary = "List posts authored by a user")
  @ApiResponses({
    @ApiResponse(
        responseCode = "200",
        description = "Page of posts",
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
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "Author not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @GetMapping("/users/{userId}/posts")
  public ResponseEntity<PostListResponse> listPostsByAuthor(
      @PathVariable("userId") UUID userId,
      @Parameter(description = "Opaque cursor returned in `nextCursor`")
          @RequestParam(name = "cursor", required = false)
          String cursor,
      @Parameter(description = "Page size; default 20, max 50")
          @RequestParam(name = "limit", required = false)
          Integer limit) {
    return ResponseEntity.ok(postService.listByAuthor(userId, cursor, limit));
  }

  @Operation(operationId = "deletePost", summary = "Soft-delete the caller's own post")
  @ApiResponses({
    @ApiResponse(responseCode = "204", description = "Post soft-deleted"),
    @ApiResponse(
        responseCode = "401",
        description = "Authentication required",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(
        responseCode = "404",
        description = "Post not found",
        content =
            @Content(
                mediaType = MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                schema = @Schema(implementation = ProblemDetail.class)))
  })
  @DeleteMapping("/posts/{id}")
  public ResponseEntity<Void> deletePost(
      @AuthenticationPrincipal UserPrincipal principal, @PathVariable("id") UUID id) {
    UUID callerId = requirePrincipal(principal).id();
    postService.delete(callerId, id);
    return ResponseEntity.noContent().build();
  }

  private static UserPrincipal requirePrincipal(UserPrincipal principal) {
    if (principal == null) {
      throw new InsufficientAuthenticationException("No principal");
    }
    return principal;
  }
}
