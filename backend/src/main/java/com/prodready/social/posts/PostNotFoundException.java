package com.prodready.social.posts;

public class PostNotFoundException extends RuntimeException {
  public PostNotFoundException() {
    super("Post not found");
  }
}
