package com.prodready.social.useraccounts;

public class InvalidRefreshTokenException extends RuntimeException {
  public InvalidRefreshTokenException() {
    super("Invalid refresh token");
  }
}
