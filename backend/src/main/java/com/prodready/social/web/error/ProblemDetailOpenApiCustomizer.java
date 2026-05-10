package com.prodready.social.web.error;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.responses.ApiResponse;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.ProblemDetail;

/**
 * Forces every 4xx/5xx response in the generated OpenAPI document to advertise {@code
 * application/problem+json} with the {@link ProblemDetail} schema, so the generated TypeScript
 * error type is uniform across operations.
 */
@Configuration
public class ProblemDetailOpenApiCustomizer {

  private static final String PROBLEM_JSON = "application/problem+json";
  private static final String PROBLEM_DETAIL_REF = "#/components/schemas/ProblemDetail";

  @Bean
  public OpenApiCustomizer problemDetailErrorResponses() {
    return (OpenAPI openApi) -> {
      if (openApi.getComponents() == null
          || openApi.getComponents().getSchemas() == null
          || !openApi.getComponents().getSchemas().containsKey("ProblemDetail")) {
        // Force-register ProblemDetail in the components schema map so the
        // $ref resolves even when no operation declares it explicitly.
        openApi.schema("ProblemDetail", new Schema<ProblemDetail>().$ref(PROBLEM_DETAIL_REF));
      }
      if (openApi.getPaths() == null) {
        return;
      }
      openApi
          .getPaths()
          .values()
          .forEach(
              path ->
                  path.readOperations()
                      .forEach(
                          operation -> {
                            if (operation.getResponses() == null) {
                              return;
                            }
                            operation
                                .getResponses()
                                .forEach(
                                    (code, response) -> {
                                      if (code.length() == 3
                                          && (code.charAt(0) == '4' || code.charAt(0) == '5')) {
                                        forceProblemJson(response);
                                      }
                                    });
                          }));
    };
  }

  private static void forceProblemJson(ApiResponse response) {
    Content content = response.getContent();
    if (content == null) {
      content = new Content();
      response.setContent(content);
    }
    content.clear();
    Schema<?> schema = new Schema<>().$ref(PROBLEM_DETAIL_REF);
    content.addMediaType(PROBLEM_JSON, new MediaType().schema(schema));
  }
}
