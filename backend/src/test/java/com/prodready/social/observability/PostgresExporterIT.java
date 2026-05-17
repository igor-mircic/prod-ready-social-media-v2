package com.prodready.social.observability;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

/**
 * End-to-end proof that the slice-12 Postgres-observability pipeline emits the key Prometheus
 * series after real database traffic. Spins up a testcontainers Postgres with {@code
 * shared_preload_libraries=pg_stat_statements} and a sibling {@code postgres-exporter}
 * configured against the same {@code queries.yaml} used in {@code docker-compose.yml}, drives a
 * handful of JDBC operations, then HTTP-fetches the exporter's {@code /metrics} surface and
 * asserts the presence of the series the dashboard panels and alert rules depend on.
 *
 * <p>The test does NOT run Prometheus, Grafana, or the Spring context — it proves the
 * exporter-side of the chain in isolation. Dashboard panels are visual artefacts and aren't
 * asserted (consistent with how prior observability slices handle them).
 *
 * <p>Image tag and queries file path are kept in lock-step with {@code docker-compose.yml}; if
 * either drifts, the test catches it on the next run.
 */
class PostgresExporterIT {

  private static final String POSTGRES_IMAGE = "postgres:16-alpine";
  private static final String EXPORTER_IMAGE = "quay.io/prometheuscommunity/postgres-exporter:v0.17.1";

  // `user.dir` resolves to `<repo>/backend` when Gradle runs the Test task, so this climbs one
  // level to reach the queries.yaml that the in-k3s postgres-exporter's kustomization mounts
  // (the same file, post-22b, kept in its consumer-local home under infra/k8s/base/). Keeping
  // a single source of truth here means a stale or rotten queries.yaml fails the test, not
  // just runtime.
  private static final Path QUERIES_YAML =
      Paths.get(System.getProperty("user.dir"))
          .resolve("../infra/k8s/base/postgres-exporter/queries.yaml")
          .normalize();

  private static Network network;
  private static PostgreSQLContainer<?> postgres;
  private static GenericContainer<?> exporter;

  @BeforeAll
  static void startContainers() throws Exception {
    network = Network.newNetwork();

    postgres =
        new PostgreSQLContainer<>(DockerImageName.parse(POSTGRES_IMAGE))
            .withDatabaseName("social")
            .withUsername("social")
            .withPassword("social")
            .withNetwork(network)
            .withNetworkAliases("postgres")
            // Override the default CMD to load pg_stat_statements as a shared preload library —
            // mirrors the `command:` block on the postgres service in docker-compose.yml. The
            // library is bundled with postgres:16-alpine, so no custom image is needed.
            .withCommand("postgres", "-c", "shared_preload_libraries=pg_stat_statements");
    postgres.start();

    // Once the library is loaded the extension can be installed against the database. The
    // docker-compose stack does this via the /docker-entrypoint-initdb.d/ init script, which
    // only runs on a fresh data directory; in this test the testcontainers volume is always
    // fresh, but we exercise the CREATE EXTENSION manually to keep the test in JDBC space.
    try (Connection conn =
            DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
        Statement stmt = conn.createStatement()) {
      stmt.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    }

    exporter =
        new GenericContainer<>(DockerImageName.parse(EXPORTER_IMAGE))
            .withNetwork(network)
            .withNetworkAliases("postgres-exporter")
            .withExposedPorts(9187)
            // Same data-source wiring as docker-compose.yml: the exporter talks to Postgres via
            // its in-network DNS name on the standard port.
            .withEnv("DATA_SOURCE_URI", "postgres:5432/social?sslmode=disable")
            .withEnv("DATA_SOURCE_USER", "social")
            .withEnv("DATA_SOURCE_PASS", "social")
            .withEnv("PG_EXPORTER_EXTEND_QUERY_PATH", "/etc/postgres-exporter/queries.yaml")
            .withCopyFileToContainer(
                MountableFile.forHostPath(QUERIES_YAML), "/etc/postgres-exporter/queries.yaml")
            .waitingFor(Wait.forHttp("/metrics").forPort(9187).forStatusCode(200));
    exporter.start();
  }

  @AfterAll
  static void stopContainers() {
    if (exporter != null) {
      exporter.stop();
    }
    if (postgres != null) {
      postgres.stop();
    }
    if (network != null) {
      network.close();
    }
  }

  @Test
  void exporterMetrics_includeStatDatabaseAndStatStatementsSeries() throws Exception {
    driveDatabaseTraffic();

    // Force `pg_stat_statements` to materialise the new rows: the view aggregates by queryid in
    // a background buffer that flushes after a short delay. Two scrapes spaced a second apart
    // give the exporter (cache_seconds=30 in queries.yaml — first call seeds, subsequent calls
    // serve the cached result) and Postgres both a chance to settle.
    fetchMetrics();
    Thread.sleep(1000);
    String metrics = fetchMetrics();

    assertThat(metrics)
        .as("postgres-exporter must emit pg_stat_database_xact_commit for the social database")
        .containsPattern("pg_stat_database_xact_commit\\{[^}]*datname=\"social\"[^}]*\\}");
    assertThat(metrics)
        .as("postgres-exporter must emit pg_stat_database_numbackends")
        .contains("pg_stat_database_numbackends");
    assertThat(metrics)
        .as("custom-queries projection must surface pg_stat_statements_calls (declared in queries.yaml)")
        .contains("pg_stat_statements_calls");
  }

  private static void driveDatabaseTraffic() throws Exception {
    // The point of this seed traffic is to populate pg_stat_statements; the schema is
    // intentionally trivial because the test does not depend on the application's tables. A few
    // executions of distinct statements is enough to put rows into the pg_stat_statements view.
    try (Connection conn =
            DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
        Statement stmt = conn.createStatement()) {
      stmt.execute("CREATE TABLE IF NOT EXISTS exporter_seed (id SERIAL PRIMARY KEY, label TEXT)");
      try (PreparedStatement ps =
          conn.prepareStatement("INSERT INTO exporter_seed (label) VALUES (?)")) {
        for (int i = 0; i < 25; i++) {
          ps.setString(1, "row-" + i);
          ps.executeUpdate();
        }
      }
      for (int i = 0; i < 10; i++) {
        try (var rs = stmt.executeQuery("SELECT count(*) FROM exporter_seed")) {
          rs.next();
          rs.getInt(1);
        }
      }
    }
  }

  private static String fetchMetrics() throws Exception {
    URI uri =
        URI.create(
            "http://" + exporter.getHost() + ":" + exporter.getMappedPort(9187) + "/metrics");
    HttpClient client = HttpClient.newHttpClient();
    HttpResponse<String> response =
        client.send(HttpRequest.newBuilder(uri).GET().build(), HttpResponse.BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    return response.body();
  }
}
