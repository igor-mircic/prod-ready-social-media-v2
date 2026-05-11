package com.prodready.social.posts;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
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
class PostsMigrationIT {

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
  void postsTable_existsWithExpectedColumns() {
    List<String> columns =
        jdbc.queryForList(
            "SELECT column_name FROM information_schema.columns"
                + " WHERE table_schema = 'public' AND table_name = 'posts'"
                + " ORDER BY ordinal_position",
            String.class);
    assertThat(columns).containsExactlyInAnyOrder("id", "author_id", "body", "created_at", "deleted_at");
  }

  @Test
  void postsAuthorCreatedIdx_existsAsPartialIndex() {
    String indexDef =
        jdbc.queryForObject(
            "SELECT indexdef FROM pg_indexes"
                + " WHERE schemaname = 'public' AND indexname = 'posts_author_created_idx'",
            String.class);
    assertThat(indexDef).isNotNull();
    assertThat(indexDef).contains("posts");
    assertThat(indexDef).contains("author_id");
    assertThat(indexDef).contains("created_at");
    assertThat(indexDef).contains("deleted_at IS NULL");
  }

  @Test
  void postsAuthorFk_isOnDeleteRestrict() {
    String confdeltype =
        jdbc.queryForObject(
            "SELECT confdeltype FROM pg_constraint c"
                + " JOIN pg_class t ON t.oid = c.conrelid"
                + " WHERE t.relname = 'posts' AND c.contype = 'f'",
            String.class);
    // 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL, 'a' = NO ACTION
    assertThat(confdeltype).isEqualTo("r");
  }
}
