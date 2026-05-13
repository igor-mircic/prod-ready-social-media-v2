package com.prodready.social.observability;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

public class RequestIdFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String inbound = request.getHeader(AccessLogMarkers.HEADER_REQUEST_ID);
    String requestId =
        (inbound != null && !inbound.isBlank()) ? inbound : UUID.randomUUID().toString();
    MDC.put(AccessLogMarkers.MDC_REQUEST_ID, requestId);
    response.setHeader(AccessLogMarkers.HEADER_REQUEST_ID, requestId);
    try {
      chain.doFilter(request, response);
    } finally {
      MDC.remove(AccessLogMarkers.MDC_REQUEST_ID);
    }
  }
}
