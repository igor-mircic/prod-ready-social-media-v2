package com.prodready.social.observability;

import ch.qos.logback.classic.spi.ILoggingEvent;
import java.util.Map;
import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.logging.structured.StructuredLoggingJsonMembersCustomizer;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

/**
 * Reconciles the OTel Java agent's Logstash-style MDC keys ({@code trace_id}, {@code span_id},
 * {@code trace_flags}) with the rest of the backend's ECS-canonical JSON shape ({@code trace.id},
 * {@code span.id}, {@code trace.flags}). The agent populates the keys in Logback's MDC view at
 * log-emit time; Spring Boot 4's {@code EcsStructuredLogFormatter} would otherwise lift them
 * verbatim into the JSON envelope. This customizer adds nested ECS members and strips the
 * Logstash-style keys so each log line carries exactly one naming convention.
 *
 * <p>Registered via {@code META-INF/spring.factories}; instantiated by Spring Boot's
 * {@code StructuredLogFormatterFactory} during Logback init, before the application context
 * exists. Runs at {@link Ordered#LOWEST_PRECEDENCE} so any other future customizer sees the
 * original Logstash-style keys before this customizer's path filter drops them.
 */
@Order(Ordered.LOWEST_PRECEDENCE)
public class EcsTraceFieldsCustomizer
    implements StructuredLoggingJsonMembersCustomizer<ILoggingEvent> {

  static final String MDC_TRACE_ID = "trace_id";
  static final String MDC_SPAN_ID = "span_id";
  static final String MDC_TRACE_FLAGS = "trace_flags";

  @Override
  public void customize(JsonWriter.Members<ILoggingEvent> members) {
    members
        .add()
        .whenNotNull(ev -> mdcValue(ev, MDC_TRACE_ID))
        .usingMembers(
            outer ->
                outer
                    .add("trace")
                    .usingMembers(
                        trace -> {
                          trace.add("id", (ILoggingEvent ev) -> mdcValue(ev, MDC_TRACE_ID));
                          trace
                              .add("flags", (ILoggingEvent ev) -> mdcValue(ev, MDC_TRACE_FLAGS))
                              .whenHasLength();
                        }));

    members
        .add()
        .whenNotNull(ev -> mdcValue(ev, MDC_SPAN_ID))
        .usingMembers(
            outer ->
                outer
                    .add("span")
                    .usingMembers(
                        span ->
                            span.add(
                                "id", (ILoggingEvent ev) -> mdcValue(ev, MDC_SPAN_ID))));

    // Drop the agent's Logstash-style MDC keys so each line carries exactly one naming
    // convention. Spring Boot's `applyingPathFilter` predicate is *exclusionary* —
    // predicate true means "skip this path during render", false means "keep it".
    members.applyingPathFilter(EcsTraceFieldsCustomizer::isTopLevelLogstashTraceKey);
  }

  private static String mdcValue(ILoggingEvent event, String key) {
    if (event == null) {
      return null;
    }
    Map<String, String> mdc = event.getMDCPropertyMap();
    if (mdc == null) {
      return null;
    }
    String value = mdc.get(key);
    return (value != null && !value.isBlank()) ? value : null;
  }

  // Returns TRUE to *exclude* the path. Targets exactly the agent's flat top-level
  // Logstash-style keys (trace_id / span_id / trace_flags); all other paths — including
  // the nested "trace" / "span" subtree this customizer adds — pass through unaffected.
  static boolean isTopLevelLogstashTraceKey(JsonWriter.MemberPath path) {
    if (path == null) {
      return false;
    }
    String name = path.name();
    if (!(MDC_TRACE_ID.equals(name)
        || MDC_SPAN_ID.equals(name)
        || MDC_TRACE_FLAGS.equals(name))) {
      return false;
    }
    JsonWriter.MemberPath parent = path.parent();
    if (parent == null) {
      return true;
    }
    String parentName = parent.name();
    // ROOT's name is null/empty. A top-level path's parent is ROOT.
    return parentName == null || parentName.isEmpty();
  }
}
