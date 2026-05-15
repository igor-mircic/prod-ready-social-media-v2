package com.prodready.social.observability;

import io.prometheus.metrics.tracer.agent.OpenTelemetryAgentSpanContext;
import io.prometheus.metrics.tracer.common.SpanContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ExemplarsConfig {

  // Spring Boot 4.0.6's `PrometheusMetricsExportAutoConfiguration` constructs
  // `PrometheusMeterRegistry` with an `ObjectProvider<SpanContext>`; when a
  // `SpanContext` bean is on the context, every histogram observation pulls a
  // (trace_id, span_id) pair from it and emits an exemplar line on the
  // OpenMetrics scrape. Without this bean, no exemplars surface — the autoconfig
  // injects `null` and silently disables the path.
  //
  // `OpenTelemetryAgentSpanContext` is shaded against the OTel Java agent's own
  // bootstrap copy of `io.opentelemetry.api.*` (see the artifact POM's
  // `maven-shade-plugin` relocation), so it reads the active span from the same
  // context the agent itself maintains — no SDK on the application classpath.
  @Bean
  public SpanContext openTelemetryAgentSpanContext() {
    return new OpenTelemetryAgentSpanContext();
  }
}
