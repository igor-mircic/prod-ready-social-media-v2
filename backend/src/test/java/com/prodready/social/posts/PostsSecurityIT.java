package com.prodready.social.posts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.prodready.social.useraccounts.SecurityConfig;
import java.lang.reflect.Field;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class PostsSecurityIT {

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
  void createPost_noAuthHeader_returns401Problem() throws Exception {
    mvc.perform(post("/api/v1/posts").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void readPost_noAuthHeader_returns401Problem() throws Exception {
    mvc.perform(get("/api/v1/posts/" + UUID.randomUUID()))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void listPosts_noAuthHeader_returns401Problem() throws Exception {
    mvc.perform(get("/api/v1/users/" + UUID.randomUUID() + "/posts"))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void deletePost_noAuthHeader_returns401Problem() throws Exception {
    mvc.perform(delete("/api/v1/posts/" + UUID.randomUUID()))
        .andExpect(status().isUnauthorized())
        .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON));
  }

  @Test
  void securityAllowlist_doesNotEnumerateAnyPostsPath() throws Exception {
    String[] permitPosts = readStringArrayField("PERMIT_ALL_POSTS");
    String[] permitGets = readStringArrayField("PERMIT_ALL_GETS");
    for (String path : permitPosts) {
      assertThat(path.contains("/posts")).isFalse();
    }
    for (String path : permitGets) {
      assertThat(path.contains("/posts")).isFalse();
    }
    // Sanity: we actually inspected the constants
    assertThat(permitPosts.length).isGreaterThan(0);
  }

  private static String[] readStringArrayField(String name) throws Exception {
    Field f = SecurityConfig.class.getDeclaredField(name);
    f.setAccessible(true);
    return (String[]) f.get(null);
  }
}
