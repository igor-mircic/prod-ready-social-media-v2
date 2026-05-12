package com.prodready.social.follows;

public class SelfFollowException extends RuntimeException {
  public SelfFollowException() {
    super("You cannot follow yourself");
  }
}
