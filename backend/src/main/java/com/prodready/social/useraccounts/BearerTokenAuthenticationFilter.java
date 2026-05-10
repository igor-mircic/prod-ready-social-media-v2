package com.prodready.social.useraccounts;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

public class BearerTokenAuthenticationFilter extends OncePerRequestFilter {

  private static final String BEARER_PREFIX = "Bearer ";

  private final AuthTokenService authTokenService;
  private final UserRepository userRepository;

  public BearerTokenAuthenticationFilter(
      AuthTokenService authTokenService, UserRepository userRepository) {
    this.authTokenService = authTokenService;
    this.userRepository = userRepository;
  }

  public static Optional<String> extractBearerToken(HttpServletRequest request) {
    String header = request.getHeader(HttpHeaders.AUTHORIZATION);
    if (header == null || !header.startsWith(BEARER_PREFIX)) {
      return Optional.empty();
    }
    String token = header.substring(BEARER_PREFIX.length()).trim();
    return token.isEmpty() ? Optional.empty() : Optional.of(token);
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    if (SecurityContextHolder.getContext().getAuthentication() == null) {
      extractBearerToken(request)
          .flatMap(authTokenService::findActiveAccessToken)
          .flatMap(token -> userRepository.findById(token.getUserId()))
          .ifPresent(
              user -> {
                UserPrincipal principal = UserPrincipal.fromUser(user);
                UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(principal, null, List.of());
                SecurityContextHolder.getContext().setAuthentication(authentication);
              });
    }
    chain.doFilter(request, response);
  }
}
