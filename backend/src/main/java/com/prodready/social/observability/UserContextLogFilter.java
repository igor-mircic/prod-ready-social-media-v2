package com.prodready.social.observability;

import com.prodready.social.useraccounts.UserPrincipal;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.MDC;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

public class UserContextLogFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication instanceof UsernamePasswordAuthenticationToken
        && authentication.isAuthenticated()
        && authentication.getPrincipal() instanceof UserPrincipal principal) {
      String userId = principal.id().toString();
      MDC.put(AccessLogMarkers.MDC_USER_ID, userId);
      request.setAttribute(AccessLogMarkers.REQUEST_ATTR_USER_ID, userId);
    }
    try {
      chain.doFilter(request, response);
    } finally {
      MDC.remove(AccessLogMarkers.MDC_USER_ID);
    }
  }
}
