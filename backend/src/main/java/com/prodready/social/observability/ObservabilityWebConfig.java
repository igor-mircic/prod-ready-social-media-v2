package com.prodready.social.observability;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers the three observability servlet filters with explicit ordering. Spring Security's
 * filter chain runs at the default order {@code -100}.
 *
 * <p>Ordering (deviates from the original design.md Decisions 3/5 numbers — see below):
 *
 * <pre>
 *  order  filter                       responsibility
 *  ────── ───────────────────────────  ─────────────────────────────────────────────
 *   -200  RequestIdFilter              MDC request.id; X-Request-Id header round-trip
 *   -150  RequestLoggingFilter         timer + backend.access line (outside security)
 *   -100  springSecurityFilterChain    [Spring Security default]
 *      0  UserContextLogFilter         MDC user.id post-auth (inside security)
 * </pre>
 *
 * <p>RequestLoggingFilter sits at {@code -150} (not {@code 100} as the original design suggested)
 * because Spring Security's {@code ExceptionTranslationFilter} consumes the 401/403 exception and
 * does not call the outer servlet chain — a filter at order {@code 100} therefore never runs for an
 * unauthenticated request to a protected route, and we lose the access-log line for every 4xx that
 * originates inside the security chain. Placing the filter outside the security chain wraps both
 * happy- and sad-path requests in a single timer. {@code user.id} is mirrored from MDC into a
 * request attribute by {@link UserContextLogFilter} so it survives the inner filter's MDC clear
 * (Decision 5's "read MDC at exit" intent is preserved by restoring the value to MDC for the single
 * access-log call).
 */
@Configuration
public class ObservabilityWebConfig {

  @Bean
  public FilterRegistrationBean<RequestIdFilter> requestIdFilterRegistration() {
    FilterRegistrationBean<RequestIdFilter> reg =
        new FilterRegistrationBean<>(new RequestIdFilter());
    reg.setOrder(-200);
    reg.addUrlPatterns("/*");
    return reg;
  }

  @Bean
  public FilterRegistrationBean<RequestLoggingFilter> requestLoggingFilterRegistration() {
    FilterRegistrationBean<RequestLoggingFilter> reg =
        new FilterRegistrationBean<>(new RequestLoggingFilter());
    reg.setOrder(-150);
    reg.addUrlPatterns("/*");
    return reg;
  }

  @Bean
  public FilterRegistrationBean<UserContextLogFilter> userContextLogFilterRegistration() {
    FilterRegistrationBean<UserContextLogFilter> reg =
        new FilterRegistrationBean<>(new UserContextLogFilter());
    reg.setOrder(0);
    reg.addUrlPatterns("/*");
    return reg;
  }
}
