package com.prodready.social.useraccounts;

public class EmailAlreadyRegisteredException extends RuntimeException {
  public EmailAlreadyRegisteredException(String email) {
    super("Email already registered: " + email);
  }
}
