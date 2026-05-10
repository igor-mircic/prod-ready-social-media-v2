package com.prodready.social.useraccounts;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;

@Configuration
public class SecurityConfig {

  static final String[] PERMIT_ALL_POSTS = {
    "/api/v1/auth/signup", "/api/v1/auth/login", "/api/v1/auth/refresh"
  };

  static final String[] PERMIT_ALL_GETS = {
    "/actuator/health", "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui", "/swagger-ui/**", "/favicon.ico"
  };

  static final String REFRESH_PATH = "/api/v1/auth/refresh";

  @Bean
  public SecurityFilterChain securityFilterChain(
      HttpSecurity http,
      AuthTokenService authTokenService,
      UserRepository userRepository,
      SecurityProblemDetailEntryPoint problemDetailHandler)
      throws Exception {
    BearerTokenAuthenticationFilter bearerFilter =
        new BearerTokenAuthenticationFilter(authTokenService, userRepository);
    PathPatternRequestMatcher.Builder mvc = PathPatternRequestMatcher.withDefaults();

    http.csrf(
            csrf ->
                csrf.csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                    .requireCsrfProtectionMatcher(mvc.matcher(HttpMethod.POST, REFRESH_PATH)))
        .cors(AbstractHttpConfigurer::disable)
        .formLogin(AbstractHttpConfigurer::disable)
        .httpBasic(AbstractHttpConfigurer::disable)
        .logout(AbstractHttpConfigurer::disable)
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            authz -> {
              for (String path : PERMIT_ALL_POSTS) {
                authz.requestMatchers(mvc.matcher(HttpMethod.POST, path)).permitAll();
              }
              for (String path : PERMIT_ALL_GETS) {
                authz.requestMatchers(mvc.matcher(HttpMethod.GET, path)).permitAll();
              }
              authz.anyRequest().authenticated();
            })
        .exceptionHandling(
            h ->
                h.authenticationEntryPoint(problemDetailHandler)
                    .accessDeniedHandler(problemDetailHandler))
        .addFilterBefore(bearerFilter, AnonymousAuthenticationFilter.class);

    return http.build();
  }
}
