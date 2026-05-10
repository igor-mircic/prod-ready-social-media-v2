package com.prodready.social.web.error;

import com.prodready.social.useraccounts.EmailAlreadyRegisteredException;
import com.prodready.social.useraccounts.InvalidRefreshTokenException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

  @Override
  protected ResponseEntity<Object> handleMethodArgumentNotValid(
      MethodArgumentNotValidException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    Map<String, List<String>> fields = new LinkedHashMap<>();
    for (FieldError fe : ex.getBindingResult().getFieldErrors()) {
      fields
          .computeIfAbsent(fe.getField(), k -> new java.util.ArrayList<>())
          .add(fe.getDefaultMessage() == null ? "invalid" : fe.getDefaultMessage());
    }
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
    body.setTitle("Validation failed");
    body.setDetail("One or more fields failed validation");
    body.setProperty("fields", fields);
    return ResponseEntity.status(HttpStatus.BAD_REQUEST)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  static final String INVALID_CREDENTIALS_DETAIL = "Invalid email or password";

  @ExceptionHandler(EmailAlreadyRegisteredException.class)
  ResponseEntity<ProblemDetail> handleEmailAlreadyRegistered(EmailAlreadyRegisteredException ex) {
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.CONFLICT);
    body.setTitle("Email already registered");
    body.setDetail(ex.getMessage());
    return ResponseEntity.status(HttpStatus.CONFLICT)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  @ExceptionHandler(BadCredentialsException.class)
  ResponseEntity<ProblemDetail> handleBadCredentials(BadCredentialsException ex) {
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.UNAUTHORIZED);
    body.setTitle("Unauthorized");
    body.setDetail(INVALID_CREDENTIALS_DETAIL);
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  @ExceptionHandler(InvalidRefreshTokenException.class)
  ResponseEntity<ProblemDetail> handleInvalidRefresh(InvalidRefreshTokenException ex) {
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.UNAUTHORIZED);
    body.setTitle("Unauthorized");
    body.setDetail("Invalid refresh token");
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  @ExceptionHandler(AuthenticationException.class)
  ResponseEntity<ProblemDetail> handleAuthentication(AuthenticationException ex) {
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.UNAUTHORIZED);
    body.setTitle("Unauthorized");
    body.setDetail("Authentication required");
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  @ExceptionHandler(AccessDeniedException.class)
  ResponseEntity<ProblemDetail> handleAccessDenied(AccessDeniedException ex) {
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.FORBIDDEN);
    body.setTitle("Forbidden");
    body.setDetail("Access denied");
    return ResponseEntity.status(HttpStatus.FORBIDDEN)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }

  @ExceptionHandler(ResponseStatusException.class)
  ResponseEntity<ProblemDetail> handleResponseStatus(ResponseStatusException ex) {
    HttpStatusCode status = ex.getStatusCode();
    ProblemDetail body = ProblemDetail.forStatus(status);
    body.setTitle(HttpStatus.valueOf(status.value()).getReasonPhrase());
    if (ex.getReason() != null) {
      body.setDetail(ex.getReason());
    }
    return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(body);
  }

  @ExceptionHandler(Throwable.class)
  ResponseEntity<ProblemDetail> handleUnexpected(Throwable ex) {
    // Intentionally do not include stack traces or messages from the throwable
    // in the body — those can leak internal details to clients.
    ProblemDetail body = ProblemDetail.forStatus(HttpStatus.INTERNAL_SERVER_ERROR);
    body.setTitle("Internal server error");
    body.setDetail("An unexpected error occurred");
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(body);
  }
}
