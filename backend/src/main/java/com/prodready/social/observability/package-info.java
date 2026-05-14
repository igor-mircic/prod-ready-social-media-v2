/**
 * Observability building blocks: structured logging glue ({@link
 * com.prodready.social.observability.EcsTraceFieldsCustomizer}, {@link
 * com.prodready.social.observability.AccessLogMarkers}), request/access logging ({@link
 * com.prodready.social.observability.RequestIdFilter}, {@link
 * com.prodready.social.observability.UserContextLogFilter}, {@link
 * com.prodready.social.observability.RequestLoggingFilter}), metrics wiring ({@link
 * com.prodready.social.observability.MetricsConfig}), and the cross-thread MDC building block
 * ({@link com.prodready.social.observability.MdcTaskDecorator}).
 *
 * <h2>MDC across thread boundaries</h2>
 *
 * Any new {@code Executor}, {@code TaskExecutor}, or {@code @Async} bean must wire {@link
 * com.prodready.social.observability.MdcTaskDecorator} (via {@code
 * ThreadPoolTaskExecutor#setTaskDecorator}, the equivalent on a custom executor, or {@code
 * AsyncConfigurer#getAsyncExecutor}). Without this decorator, request-scoped MDC keys — {@code
 * request.id} and {@code user.id}, populated by {@link
 * com.prodready.social.observability.RequestIdFilter} and {@link
 * com.prodready.social.observability.UserContextLogFilter} — disappear from worker-thread log
 * lines, because they are not propagated by the OpenTelemetry java agent the way {@code trace.id}
 * and {@code span.id} are. Worker-thread logs would still carry trace/span IDs, but lose
 * application-managed correlation keys.
 */
package com.prodready.social.observability;
