import org.springframework.boot.gradle.tasks.bundling.BootJar
import org.springframework.boot.gradle.tasks.run.BootRun

plugins {
	java
	alias(libs.plugins.spring.boot)
	alias(libs.plugins.spring.dependency.management)
	alias(libs.plugins.spotless)
	alias(libs.plugins.springdoc.openapi)
}

group = "com.prodready.social"
version = "0.0.1-SNAPSHOT"

java {
	toolchain {
		languageVersion = JavaLanguageVersion.of(21)
	}
}

repositories {
	mavenCentral()
}

// Dedicated configuration that resolves the OpenTelemetry Java agent JAR. Kept
// isolated from compileClasspath / runtimeClasspath / testRuntimeClasspath so
// the agent is never on the application classpath — it must attach via the
// JVM's `-javaagent:` flag, not via classloading. The agent shades dozens of
// libraries that would conflict if they reached the application classloader.
val agent: Configuration by configurations.creating {
	isCanBeConsumed = false
	isCanBeResolved = true
}

dependencies {
	implementation(libs.spring.boot.starter.actuator)
	implementation(libs.micrometer.registry.prometheus)
	// Provides `OpenTelemetryAgentSpanContext`, the implementation of
	// `io.prometheus.metrics.tracer.common.SpanContext` we register as a bean
	// in `ExemplarsConfig`. The library is shaded against the OTel Java
	// agent's own copy of `io.opentelemetry.api.*` (see the artifact POM's
	// `maven-shade-plugin` relocation), so it reads the active span from the
	// agent's bootstrap classloader — exactly what we need at exemplar time.
	implementation(libs.prometheus.metrics.tracer.otel.agent)
	implementation(libs.spring.boot.starter.data.jpa)
	implementation(libs.spring.boot.starter.flyway)
	implementation(libs.spring.boot.starter.validation)
	implementation(libs.spring.boot.starter.webmvc)
	implementation(libs.spring.boot.starter.security)
	implementation(libs.springdoc.openapi.starter.webmvc.ui)
	implementation(libs.spring.security.crypto)
	implementation(libs.flyway.database.postgresql)
	runtimeOnly(libs.postgresql)
	testImplementation(libs.spring.boot.starter.actuator.test)
	testImplementation(libs.spring.boot.starter.data.jpa.test)
	testImplementation(libs.spring.boot.starter.flyway.test)
	testImplementation(libs.spring.boot.starter.validation.test)
	testImplementation(libs.spring.boot.starter.webmvc.test)
	testImplementation(libs.spring.security.test)
	testImplementation(libs.spring.boot.testcontainers)
	testImplementation(libs.testcontainers.junit.jupiter)
	testImplementation(libs.testcontainers.postgresql)
	// Public OTel API on the test classpath only — gives `TracingIT` compile-time
	// access to GlobalOpenTelemetry / Span / Tracer types. At runtime the agent's
	// bootstrap classloader shadows these with its own pinned versions, so the
	// versions must align with what the agent ships (see `opentelemetryApi`
	// matching agent 2.10.0).
	testImplementation(libs.opentelemetry.api)
	testRuntimeOnly(libs.junit.platform.launcher)

	agent(libs.opentelemetry.javaagent)
}

// Copies the resolved OTel Java agent JAR to two stable paths:
//   build/otel/opentelemetry-javaagent.jar   — used by `bootRun` and `test`
//   build/libs/opentelemetry-javaagent.jar   — sits next to `backend.jar` so
//     the e2e harness's `java -jar` launcher (e2e/src/setup/backend.ts) can
//     attach the agent without resolving a Gradle build path at runtime.
// Resolve the agent configuration into a FileCollection once at config time. Passing the
// `Configuration` object directly to `from(...)` captures a script object reference that
// Gradle's configuration cache cannot serialize. The `rename(regex, replacement)` overload
// is used instead of `rename { ... }` for the same reason — the closure form captures
// script state.
val otelAgentFiles: FileCollection = agent
val copyOtelAgent by tasks.registering(Copy::class) {
	from(otelAgentFiles)
	into(layout.buildDirectory.dir("otel"))
	rename(".*", "opentelemetry-javaagent.jar")
}

val copyOtelAgentForBootJar by tasks.registering(Copy::class) {
	from(otelAgentFiles)
	into(layout.buildDirectory.dir("libs"))
	rename(".*", "opentelemetry-javaagent.jar")
}

val otelAgentJarPath: Provider<String> =
	layout.buildDirectory.file("otel/opentelemetry-javaagent.jar").map { it.asFile.absolutePath }

// OTEL_* defaults shared by `bootRun` and `test`. The agent reads these at
// JVM start. Each is overridable by a real env var: when the parent shell
// already exports a key (e.g. the GitHub Actions workflow sets
// `OTEL_TRACES_EXPORTER=none` to silence the CI exporter retries, or the
// e2e harness sets its own), the build skips the corresponding
// `environment(…)` call so Gradle does not silently re-apply the default
// on the forked JVM.
//
// OTEL_INSTRUMENTATION_LOGBACK_MDC_ENABLED is intentionally NOT set here — it
// defaults to `true` in the agent, which puts `trace_id` / `span_id` /
// `trace_flags` into the Logback LoggingEvent MDC view that
// EcsTraceFieldsCustomizer maps to ECS-canonical `trace.id` / `span.id` /
// `trace.flags` JSON members on emit.
val otelEnvDefaults = mapOf(
	"OTEL_SERVICE_NAME" to "backend",
	"OTEL_RESOURCE_ATTRIBUTES" to "service.environment=local,deployment.environment=local",
	"OTEL_TRACES_EXPORTER" to "otlp",
	"OTEL_EXPORTER_OTLP_PROTOCOL" to "http/protobuf",
	"OTEL_EXPORTER_OTLP_ENDPOINT" to "http://localhost:4318",
	"OTEL_METRICS_EXPORTER" to "none",
	"OTEL_LOGS_EXPORTER" to "none",
)

tasks.named<BootRun>("bootRun") {
	dependsOn(copyOtelAgent)
	jvmArgs("-javaagent:${otelAgentJarPath.get()}")
	otelEnvDefaults.forEach { (k, v) ->
		if (System.getenv(k) == null) environment(k, v)
	}
}

tasks.named<BootJar>("bootJar") {
	dependsOn(copyOtelAgentForBootJar)
}

tasks.withType<Test> {
	useJUnitPlatform()
	dependsOn(copyOtelAgent)
	jvmArgs("-javaagent:${otelAgentJarPath.get()}")
	// The OTLP defaults are set so the agent boots deterministically with the
	// same wiring it has in `bootRun`. `OTEL_EXPORTER_OTLP_ENDPOINT` points at
	// `http://localhost:4318` but TracingIT does not run a Tempo container —
	// the OTLP exporter logs a connection-refused warning and the agent
	// continues. Span assertions in TracingIT use an in-process
	// `OpenTelemetryExtension` that hijacks `GlobalOpenTelemetry` rather than
	// inspecting OTLP traffic.
	otelEnvDefaults.forEach { (k, v) ->
		if (System.getenv(k) == null) environment(k, v)
	}
}

spotless {
	java {
		googleJavaFormat(libs.versions.googleJavaFormat.get())
		target("src/**/*.java")
	}
}

// `./gradlew generateOpenApiDocs` boots the Spring context, hits
// /v3/api-docs, writes the spec to <repo-root>/openapi/openapi.json, exits.
// Requires a Postgres reachable at the default datasource URL.
openApi {
	apiDocsUrl.set("http://localhost:8080/v3/api-docs")
	outputDir.set(file("$rootDir/../openapi"))
	outputFileName.set("openapi.json")
	waitTimeInSeconds.set(60)
}
