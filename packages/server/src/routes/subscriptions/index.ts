/**
 * Subscription router barrel — wires tenant + admin routes for V2.
 *
 * Mounted by createPaykit() at:
 *   /billing/subscriptions    → buildTenantSubscriptionRoutes
 *   /admin/billing/subscriptions  → buildAdminSubscriptionRoutes (only if AdminGuard provided)
 *
 * Boot-time check: factory throws ADMIN_GUARD_REQUIRED if a SubscriptionAdapter
 * is registered AND admin routes are mounted without a guard.
 */
export {
  buildAdminSubscriptionRoutes,
  type AdminSubscriptionRoutesDeps,
} from "./admin-routes.js";
export { buildIdempotencyMiddleware, IDEMPOTENCY_HEADER } from "./idempotency-middleware.js";
export { type SubscriptionDto, parseStatusFilter, toDto } from "./subscription-dto.js";
export {
  buildTenantSubscriptionRoutes,
  type TenantSubscriptionRoutesDeps,
} from "./tenant-routes.js";
