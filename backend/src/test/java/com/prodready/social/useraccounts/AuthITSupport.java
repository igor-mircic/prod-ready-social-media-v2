package com.prodready.social.useraccounts;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

final class AuthITSupport {

  private AuthITSupport() {}

  static final ObjectMapper MAPPER = new ObjectMapper();

  static String signupBody(String email, String password, String displayName) {
    return String.format(
        "{\"email\":\"%s\",\"password\":\"%s\",\"displayName\":\"%s\"}",
        email, password, displayName);
  }

  static String loginBody(String email, String password) {
    return String.format("{\"email\":\"%s\",\"password\":\"%s\"}", email, password);
  }

  record LoginTokens(String accessToken, Cookie refreshCookie, long expiresIn) {}

  static LoginTokens loginAndCapture(MockMvc mvc, String email, String password) throws Exception {
    MvcResult result =
        mvc.perform(
                post("/api/v1/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(loginBody(email, password)))
            .andExpect(status().isOk())
            .andReturn();
    JsonNode body = MAPPER.readTree(result.getResponse().getContentAsString());
    Cookie cookie = result.getResponse().getCookie(AuthController.REFRESH_COOKIE_NAME);
    return new LoginTokens(
        body.get("accessToken").asText(), cookie, body.get("expiresIn").asLong());
  }

  static void signup(MockMvc mvc, String email, String password, String displayName)
      throws Exception {
    mvc.perform(
            post("/api/v1/auth/signup")
                .contentType(MediaType.APPLICATION_JSON)
                .content(signupBody(email, password, displayName)))
        .andExpect(status().isCreated());
  }

  static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
      postWithCsrf(String urlTemplate) {
    return post(urlTemplate).with(csrf());
  }
}
