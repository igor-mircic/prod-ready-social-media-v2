package com.prodready.social;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
class ApplicationContextIT {

  @Container
  static final PostgreSQLContainer POSTGRES =
      new PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine"));

  @DynamicPropertySource
  static void datasourceProperties(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
    registry.add("spring.datasource.username", POSTGRES::getUsername);
    registry.add("spring.datasource.password", POSTGRES::getPassword);
  }

  @Autowired JdbcTemplate jdbc;

  @Test
  void contextLoads() {}

  @Test
  void v2MigrationCreatesAuthTokenTables() {
    Integer accessCount =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM information_schema.tables "
                + "WHERE table_schema = 'public' AND table_name = 'auth_access_tokens'",
            Integer.class);
    Integer refreshCount =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM information_schema.tables "
                + "WHERE table_schema = 'public' AND table_name = 'auth_refresh_tokens'",
            Integer.class);
    assertThat(accessCount).isEqualTo(1);
    assertThat(refreshCount).isEqualTo(1);

    Integer accessIdx =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM pg_indexes "
                + "WHERE tablename = 'auth_access_tokens' AND indexdef LIKE '%token_hash%'",
            Integer.class);
    Integer refreshIdx =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM pg_indexes "
                + "WHERE tablename = 'auth_refresh_tokens' AND indexdef LIKE '%token_hash%'",
            Integer.class);
    assertThat(accessIdx).isGreaterThanOrEqualTo(1);
    assertThat(refreshIdx).isGreaterThanOrEqualTo(1);
  }
}
