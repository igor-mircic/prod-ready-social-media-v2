package com.prodready.social.posts;

public class AuthorNotFoundException extends RuntimeException {
  public AuthorNotFoundException() {
    super("Author not found");
  }
}
