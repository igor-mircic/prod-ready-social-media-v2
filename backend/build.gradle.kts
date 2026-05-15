import org.springframework.boot.gradle.tasks.bundling.BootBuildImage
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

// Slice 15 (add-local-k3s-backend): bootBuildImage publish + OTel agent bake.
//
// Goal: a single `./gradlew bootBuildImage -Ppublish=true` invocation builds
// an arm64 OCI image with the OTel Java agent baked in at a stable path
// (/workspace/agent/opentelemetry-javaagent.jar) and pushes it to the local
// registry tagged `registry.local:5000/backend:dev`. The chain:
//
//   bootBuildImage          → produces <imageName>-base via Paketo buildpacks
//     finalizedBy
//   bakeBackendImage        → docker build over <imageName>-base, adds the
//                             agent jar and JAVA_TOOL_OPTIONS env, tags
//                             <imageName>
//     finalizedBy (only when -Ppublish=true)
//   pushBackendImage        → docker push <imageName>
//
// The buildpack output is kept as an intermediate `<imageName>-base` tag so
// the registry only ever sees the final agent-baked image; the base tag is a
// local-only artifact that can be `docker rmi`'d at any time. The `-base`
// suffix is appended deterministically from `imageName` so a Hetzner override
// (`-PimageName=ghcr.io/<owner>/backend:<sha>`) produces a matching base tag.
//
// `imagePlatform = linux/arm64` matches the Lima VM and the future CAX21
// Hetzner box. Apple Silicon hosts produce arm64 images natively; on x86
// hosts buildpacks would refuse this target (no cross-build path) — a
// deliberate choice, since we never run an x86 backend in this project.
//
// `publish=false` on bootBuildImage: we never push the buildpack-output base
// tag. The push happens after the bake, scoped to the final tag only.
val backendImageName: Provider<String> = providers.gradleProperty("imageName")
	.orElse("registry.local:5000/backend:dev")
val backendBaseImageName: Provider<String> = backendImageName.map { "$it-base" }
// Push tag asymmetry: the cluster references `registry.local:5000/...` in
// the pod manifest (resolved via the k3s `registries.yaml` mirror that
// rewrites to `http://host.lima.internal:5000`), but the host has no
// `registry.local` DNS entry — `docker push registry.local:5000/...` would
// fail with "no such host". So the push target swaps the registry-local
// alias for `127.0.0.1`, which IS the address the local registry container
// binds to. The result is one image content with two equivalent tags
// pointing at the same underlying registry. A Hetzner override
// (`-PimageName=ghcr.io/<owner>/backend:<sha>`) skips this rewrite because
// `ghcr.io` resolves identically from the host and from the cluster — the
// `-PpushTag=` property lets the override hand-set the push tag if a future
// registry needs a different shape.
val backendPushTag: Provider<String> = providers.gradleProperty("pushTag")
	.orElse(backendImageName.map { it.replaceFirst(Regex("^registry\\.local:5000/"), "127.0.0.1:5000/") })
val publishBackendImage: Boolean = providers.gradleProperty("publish")
	.map { it.toBoolean() }.orElse(false).get()

tasks.named<BootBuildImage>("bootBuildImage") {
	imageName.set(backendBaseImageName)
	imagePlatform.set("linux/arm64")
	publish.set(false)
	finalizedBy("bakeBackendImage")
}

// Stage the docker build context: the checked-in Dockerfile next to the
// freshly-resolved agent jar. Using Sync (not Copy) clears stale files from
// previous runs — important so a `docker build` does not pick up a jar from
// an earlier agent version after a libs.versions.toml bump. The `from(...)`
// for the agent jar uses an explicit file path (NOT `from(copyOtelAgentForBootJar)`,
// which would pull the entire `build/libs/` directory — including bootJar's
// output — and trigger Gradle's implicit-dependency validation).
val backendBakeAgentJar: Provider<RegularFile> =
	layout.buildDirectory.file("libs/opentelemetry-javaagent.jar")
val prepareBackendBakeContext by tasks.registering(Sync::class) {
	dependsOn(copyOtelAgentForBootJar)
	from("docker/agent")
	from(backendBakeAgentJar)
	into(layout.buildDirectory.dir("docker-bake/agent"))
}

val bakeBackendImage by tasks.registering(Exec::class) {
	dependsOn(prepareBackendBakeContext)
	workingDir(layout.buildDirectory.dir("docker-bake/agent"))
	val baseImage = backendBaseImageName.get()
	val finalImage = backendImageName.get()
	val pushTag = backendPushTag.get()
	// Two `-t` flags so the same content carries both the manifest-facing
	// tag (registry.local:5000/...) and the host-push-facing tag
	// (127.0.0.1:5000/...). When they happen to be equal — e.g. a Hetzner
	// override using ghcr.io — Docker silently dedupes.
	commandLine(
		"docker", "build",
		"--platform", "linux/arm64",
		"--build-arg", "BASE_IMAGE=$baseImage",
		"-t", finalImage,
		"-t", pushTag,
		"."
	)
}

val pushBackendImage by tasks.registering(Exec::class) {
	val pushTag = backendPushTag.get()
	commandLine("docker", "push", pushTag)
	doLast {
		logger.lifecycle("Pushed backend image: $pushTag")
	}
}

if (publishBackendImage) {
	bakeBackendImage.configure { finalizedBy(pushBackendImage) }
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
