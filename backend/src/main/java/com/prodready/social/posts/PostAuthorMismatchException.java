package com.prodready.social.posts;

public class PostAuthorMismatchException extends RuntimeException {
  public PostAuthorMismatchException() {
    super("Post not authored by caller");
  }
}
