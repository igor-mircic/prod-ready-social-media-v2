package com.prodready.social.useraccounts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
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
class SignupIT {

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
  @Autowired JdbcTemplate jdbc;
  @Autowired UserRepository userRepository;
  final ObjectMapper mapper = new ObjectMapper();

  @Test
  void signup_happyPath_persistsAndReturnsExactShape() throws Exception {
    userRepository.deleteAll();
    String body =
        """
        {"email":"alice@example.com","password":"correcthorse","displayName":"Alice"}
        """;

    String response =
        mvc.perform(
                post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.email").value("alice@example.com"))
            .andExpect(jsonPath("$.displayName").value("Alice"))
            .andExpect(jsonPath("$.id").exists())
            .andExpect(jsonPath("$.createdAt").exists())
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode parsed = mapper.readTree(response);
    List<String> fields = new ArrayList<>();
    Iterator<String> it = parsed.fieldNames();
    while (it.hasNext()) fields.add(it.next());
    assertThat(fields).containsExactlyInAnyOrder("id", "email", "displayName", "createdAt");

    String storedHash =
        jdbc.queryForObject(
            "SELECT password_hash FROM users WHERE email = ?", String.class, "alice@example.com");
    assertThat(storedHash).isNotNull();
    assertThat(storedHash).isNotEqualTo("correcthorse");
    assertThat(storedHash).matches("^\\$2[aby]\\$.+");
  }

  @Test
  void signup_invalidBody_returnsProblemDetailListingFields() throws Exception {
    String response =
        mvc.perform(
                post("/api/v1/auth/signup")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        """
                        {"email":"not-an-email","password":"short","displayName":"Bob"}
                        """))
            .andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode body = mapper.readTree(response);
    assertThat(body.get("status").asInt()).isEqualTo(400);
    JsonNode fields = body.get("fields");
    assertThat(fields).isNotNull();
    assertThat(fields.has("email")).isTrue();
    assertThat(fields.has("password")).isTrue();
  }

  @Test
  void signup_duplicateEmail_returns409Problem() throws Exception {
    userRepository.deleteAll();
    String body =
        """
        {"email":"dupe@example.com","password":"correcthorse","displayName":"Dupe"}
        """;

    mvc.perform(post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON).content(body))
        .andExpect(status().isCreated());

    String conflict =
        mvc.perform(
                post("/api/v1/auth/signup").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isConflict())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode parsed = mapper.readTree(conflict);
    assertThat(parsed.get("status").asInt()).isEqualTo(409);
    assertThat(parsed.get("detail").asText()).contains("dupe@example.com");
  }

  @Test
  void openApiSpec_responseSchemasDoNotExposePasswordOrPasswordHash() throws Exception {
    String spec =
        mvc.perform(
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(
                    "/v3/api-docs"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();

    JsonNode root = mapper.readTree(spec);
    JsonNode components = root.path("components").path("schemas");
    Set<String> responseSchemaNames = new LinkedHashSet<>();
    root.path("paths")
        .forEach(
            path ->
                path.forEach(
                    op ->
                        op.path("responses")
                            .forEach(
                                response ->
                                    response
                                        .path("content")
                                        .forEach(
                                            mt ->
                                                collectSchemaRefs(
                                                    mt.path("schema"), responseSchemaNames)))));

    assertThat(responseSchemaNames).isNotEmpty();
    for (String name : responseSchemaNames) {
      JsonNode schema = components.path(name);
      JsonNode props = schema.path("properties");
      for (String forbidden : List.of("password", "passwordHash", "password_hash")) {
        assertThat(props.has(forbidden))
            .as("response schema %s contains forbidden field %s", name, forbidden)
            .isFalse();
      }
    }
  }

  private static void collectSchemaRefs(JsonNode schema, Set<String> out) {
    if (schema == null || schema.isMissingNode()) return;
    JsonNode ref = schema.get("$ref");
    if (ref != null && ref.isTextual()) {
      String r = ref.asText();
      int idx = r.lastIndexOf('/');
      if (idx >= 0) out.add(r.substring(idx + 1));
    }
    JsonNode items = schema.get("items");
    if (items != null) collectSchemaRefs(items, out);
  }
}
