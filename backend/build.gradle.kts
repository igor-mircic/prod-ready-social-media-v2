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

dependencies {
	implementation(libs.spring.boot.starter.actuator)
	implementation(libs.spring.boot.starter.data.jpa)
	implementation(libs.spring.boot.starter.flyway)
	implementation(libs.spring.boot.starter.validation)
	implementation(libs.spring.boot.starter.webmvc)
	implementation(libs.springdoc.openapi.starter.webmvc.ui)
	implementation(libs.spring.security.crypto)
	implementation(libs.flyway.database.postgresql)
	runtimeOnly(libs.postgresql)
	testImplementation(libs.spring.boot.starter.actuator.test)
	testImplementation(libs.spring.boot.starter.data.jpa.test)
	testImplementation(libs.spring.boot.starter.flyway.test)
	testImplementation(libs.spring.boot.starter.validation.test)
	testImplementation(libs.spring.boot.starter.webmvc.test)
	testImplementation(libs.spring.boot.testcontainers)
	testImplementation(libs.testcontainers.junit.jupiter)
	testImplementation(libs.testcontainers.postgresql)
	testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.withType<Test> {
	useJUnitPlatform()
}

spotless {
	java {
		googleJavaFormat(libs.versions.googleJavaFormat.get())
		target("src/**/*.java")
	}
}

// Headless OpenAPI generation: `./gradlew generateOpenApiDocs` boots the
// Spring context with the `codegen` profile (no datasource), hits
// /v3/api-docs, writes the spec to <repo-root>/openapi/openapi.json, exits.
openApi {
	apiDocsUrl.set("http://localhost:8080/v3/api-docs")
	outputDir.set(file("$rootDir/../openapi"))
	outputFileName.set("openapi.json")
	waitTimeInSeconds.set(60)
	customBootRun {
		args.set(listOf("--spring.profiles.active=codegen"))
	}
}
