package com.prodready.social.observability;

public final class AccessLogMarkers {

  public static final String MDC_REQUEST_ID = "request.id";
  public static final String MDC_USER_ID = "user.id";

  public static final String ECS_HTTP_METHOD = "http.request.method";
  public static final String ECS_URL_PATH = "url.path";
  public static final String ECS_HTTP_STATUS = "http.response.status_code";
  public static final String ECS_EVENT_DURATION = "event.duration";
  public static final String ECS_EVENT_DATASET = "event.dataset";
  public static final String EVENT_DATASET_BACKEND_ACCESS = "backend.access";
  public static final String FIELD_DURATION_MS = "duration_ms";

  public static final String HEADER_REQUEST_ID = "X-Request-Id";

  // UserContextLogFilter mirrors MDC's user.id into this request attribute so
  // RequestLoggingFilter — which runs outside the Spring Security chain so it can
  // still emit an access-log line on a 401 — can read the value at log time even
  // after the inner filter's `finally` cleared MDC.
  public static final String REQUEST_ATTR_USER_ID = "com.prodready.social.observability.user.id";

  private AccessLogMarkers() {}
}
