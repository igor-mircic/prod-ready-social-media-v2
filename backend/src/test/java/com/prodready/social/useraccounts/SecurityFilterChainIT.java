package com.prodready.social.useraccounts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class SecurityFilterChainIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine"));

  @DynamicPropertySource
  static void datasourceProperties(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
  }

  @Autowired MockMvc mvc;

  @Test
  void protectedEndpointWithoutHeader_returns401ProblemDetail() throws Exception {
    mvc.perform(get("/api/v1/auth/me"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void allowlistedSignupReachesController() throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andReturn();
    int status = result.getResponse().getStatus();
    assertThat(status).as("/signup must reach controller, not be 401").isNotEqualTo(401);
    assertThat(status).isEqualTo(400);
  }

  @Test
  void allowlistedLoginReachesController() throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andReturn();
    int status = result.getResponse().getStatus();
    assertThat(status).as("/login must reach controller, not be 401").isNotEqualTo(401);
    assertThat(status).isEqualTo(400);
  }

  @Test
  void allowlistedRefreshReachesController() throws Exception {
    MvcResult result = mvc.perform(post("/api/v1/auth/refresh").with(csrf())).andReturn();
    int status = result.getResponse().getStatus();
    assertThat(status)
        .as("/refresh must reach controller (will throw 401 from controller)")
        .isEqualTo(401);
    String body = result.getResponse().getContentAsString();
    assertThat(body).contains("Invalid refresh token");
  }

  @Test
  void allowlistedHealthIsPublic() throws Exception {
    mvc.perform(get("/actuator/health")).andExpect(status().isOk());
  }

  @Test
  void allowlistedApiDocsIsPublic() throws Exception {
    mvc.perform(get("/v3/api-docs")).andExpect(status().isOk());
  }
}
