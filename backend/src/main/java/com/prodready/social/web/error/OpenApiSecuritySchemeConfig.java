package com.prodready.social.web.error;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiSecuritySchemeConfig {

  static final String BEARER_SCHEME_NAME = "bearerAuth";

  @Bean
  public OpenApiCustomizer bearerAuthSchemeCustomizer() {
    return (OpenAPI openApi) -> {
      Components components = openApi.getComponents();
      if (components == null) {
        components = new Components();
        openApi.setComponents(components);
      }
      if (components.getSecuritySchemes() == null
          || !components.getSecuritySchemes().containsKey(BEARER_SCHEME_NAME)) {
        components.addSecuritySchemes(
            BEARER_SCHEME_NAME,
            new SecurityScheme()
                .type(SecurityScheme.Type.HTTP)
                .scheme("bearer")
                .bearerFormat("Opaque"));
      }
    };
  }
}
