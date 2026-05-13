package com.prodready.social.observability;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

public class RequestLoggingFilter extends OncePerRequestFilter {

  private static final Logger ACCESS_LOG = LoggerFactory.getLogger("backend.access");

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String uri = request.getRequestURI();
    if ("/actuator/health".equals(uri) || "/actuator/prometheus".equals(uri)) {
      chain.doFilter(request, response);
      return;
    }
    long startNanos = System.nanoTime();
    boolean userIdRestored = false;
    try {
      chain.doFilter(request, response);
    } finally {
      long durationNanos = System.nanoTime() - startNanos;
      Object matchedPattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
      String urlPath = matchedPattern != null ? matchedPattern.toString() : uri;
      // UserContextLogFilter runs *inside* the Spring Security chain (order 0) and
      // clears its MDC entry in its own `finally`. Because this filter runs outside
      // the security chain — so a 401 from `ExceptionTranslationFilter` still produces
      // an access-log line — MDC's `user.id` has already been cleared by the time we
      // get here. The filter mirrors the value into a request attribute; restore it
      // into MDC for the duration of this single log call so the ECS encoder lifts it
      // into the JSON envelope as documented.
      Object userIdAttr = request.getAttribute(AccessLogMarkers.REQUEST_ATTR_USER_ID);
      if (userIdAttr instanceof String userId && MDC.get(AccessLogMarkers.MDC_USER_ID) == null) {
        MDC.put(AccessLogMarkers.MDC_USER_ID, userId);
        userIdRestored = true;
      }
      try {
        ACCESS_LOG
            .atInfo()
            .addKeyValue(
                AccessLogMarkers.ECS_EVENT_DATASET, AccessLogMarkers.EVENT_DATASET_BACKEND_ACCESS)
            .addKeyValue(AccessLogMarkers.ECS_HTTP_METHOD, request.getMethod())
            .addKeyValue(AccessLogMarkers.ECS_URL_PATH, urlPath)
            .addKeyValue(AccessLogMarkers.ECS_HTTP_STATUS, response.getStatus())
            .addKeyValue(AccessLogMarkers.ECS_EVENT_DURATION, durationNanos)
            .addKeyValue(AccessLogMarkers.FIELD_DURATION_MS, durationNanos / 1_000_000L)
            .log("");
      } finally {
        if (userIdRestored) {
          MDC.remove(AccessLogMarkers.MDC_USER_ID);
        }
      }
    }
  }
}
