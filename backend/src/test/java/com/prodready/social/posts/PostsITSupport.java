package com.prodready.social.posts;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

public final class PostsITSupport {

  private PostsITSupport() {}

  public static final ObjectMapper MAPPER = new ObjectMapper();

  public record TestUser(UUID id, String email, String displayName, String accessToken) {}

  public static String signupBody(String email, String password, String displayName) {
    return String.format(
        "{\"email\":\"%s\",\"password\":\"%s\",\"displayName\":\"%s\"}",
        email, password, displayName);
  }

  public static String loginBody(String email, String password) {
    return String.format("{\"email\":\"%s\",\"password\":\"%s\"}", email, password);
  }

  public static TestUser signupAndLogin(
      MockMvc mvc, String email, String password, String displayName) throws Exception {
    MvcResult signupResult =
        mvc.perform(
                post("/api/v1/auth/signup")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(signupBody(email, password, displayName)))
            .andExpect(status().isCreated())
            .andReturn();
    JsonNode signupBody = MAPPER.readTree(signupResult.getResponse().getContentAsString());
    UUID userId = UUID.fromString(signupBody.get("id").asText());

    MvcResult loginResult =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody(email, password)))
            .andExpect(status().isOk())
            .andReturn();
    JsonNode loginBody = MAPPER.readTree(loginResult.getResponse().getContentAsString());
    String accessToken = loginBody.get("accessToken").asText();
    return new TestUser(userId, email, displayName, accessToken);
  }

  public static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
      authedGet(String url, String accessToken) {
    return get(url).header(HttpHeaders.AUTHORIZATION, "Bearer " + accessToken);
  }

  public static String createPostBody(String body) {
    return String.format("{\"body\":%s}", MAPPER.valueToTree(body).toString());
  }
}
