/**
 * Web layer infrastructure: controller-advice, OpenAPI customizers, and other cross-cutting HTTP
 * concerns.
 *
 * <p>API versioning convention: every feature controller declares its full path under {@code
 * /api/v1/...} via class-level {@code @RequestMapping}. The Actuator surface ({@code /actuator/*})
 * and the springdoc surface ({@code /v3/api-docs}, {@code /swagger-ui*}) are intentionally NOT
 * prefixed — applying the prefix per-controller leaves those framework endpoints at their default
 * unversioned paths without any extra reconfiguration.
 */
package com.prodready.social.web;
