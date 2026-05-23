/**
 * createPaykit — V1.5 main factory.
 *
 * Accepts EITHER:
 *   - V1.5 array shape: providers: PaymentProviderAdapter[]
 *   - V1 legacy shape:  providers: { stripe?: StripeConfig, sepay?: SePayConfig }
 *
 * Legacy shape is converted via lazy-import of @vibecc/paykit-stripe and
 * @vibecc/paykit-sepay packages. Consumer must `pnpm add` them; missing
 * package surfaces clear migration error.
 *
 * Webhook URLs become `/webhooks/{adapterId}` (V1: /webhooks/stripe stays
 * compatible because adapter id='stripe').
 */
import {
  type AdminGuard,
  type DiscountResolver,
  type PaykitError,
  type PaymentProviderAdapter,
  ProviderRegistry,
  type TenantResolver,
} from "@vibecc/paykit";
import { Hono } from "hono";
import type { DbClient } from "../db/client.js";
import type { PaykitEventHandlers } from "../events/emitter.js";
import type { SePayConfig } from "../providers/sepay/client.js";
import type { StripeConfig } from "../providers/stripe/client.js";
import {
  type AdminAuditAction,
  buildAdminLedgerAdjustRoute,
} from "../routes/admin/ledger-adjust-route.js";
import { buildAdminRefundRoute } from "../routes/admin/refund-route.js";
import { buildAdminTransactionsRoute } from "../routes/admin/transactions-route.js";
import { buildAdminWebhookEventsRoute } from "../routes/admin/webhook-events-route.js";
import { buildBalanceRoute } from "../routes/billing/balance-route.js";
import { buildLedgerRoute } from "../routes/billing/ledger-route.js";
import { buildPaymentHistoryRoute } from "../routes/billing/payment-history-route.js";
import { buildCheckoutRouter } from "../routes/checkout/checkout-router.js";
import { buildWebhookRouter } from "../routes/webhooks/webhook-router.js";
import { resolveProvidersToAdapters } from "./adapter-shim.js";

export interface PaykitLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export type LegacyProvidersConfig = {
  readonly stripe?: StripeConfig;
  readonly sepay?: SePayConfig;
};

export interface PaykitConfig {
  readonly db: DbClient;
  readonly tenantResolver: TenantResolver;
  readonly discountResolver?: DiscountResolver;
  readonly adminGuard?: AdminGuard;
  /** V1.5: array of registered adapters. V1 legacy: object with stripe + sepay configs. */
  readonly providers: readonly PaymentProviderAdapter[] | LegacyProvidersConfig;
  readonly events?: PaykitEventHandlers;
  readonly onAdminAction?: (action: AdminAuditAction) => void | Promise<void>;
  readonly logger?: PaykitLogger;
}

export interface Paykit {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  routes(): Hono;
  webhookRoutes(): Hono;
  adminRoutes(): Hono;
}

export async function createPaykit(config: PaykitConfig): Promise<Paykit> {
  const events: PaykitEventHandlers = config.events ?? {};
  const logger = config.logger;

  // Resolve adapters from either shape (legacy → adapter array via lazy import)
  const adapters = await resolveProvidersToAdapters(config.providers);

  const registry = new ProviderRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return {
    db: config.db,
    registry,

    routes() {
      const app = new Hono();
      app.route(
        "/checkout",
        buildCheckoutRouter({
          db: config.db,
          registry,
          tenantResolver: config.tenantResolver,
          ...(config.discountResolver !== undefined
            ? { discountResolver: config.discountResolver }
            : {}),
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      app.route("/", buildBalanceRoute({ db: config.db, tenantResolver: config.tenantResolver }));
      app.route("/", buildLedgerRoute({ db: config.db, tenantResolver: config.tenantResolver }));
      app.route(
        "/",
        buildPaymentHistoryRoute({ db: config.db, tenantResolver: config.tenantResolver }),
      );
      return app;
    },

    webhookRoutes() {
      return buildWebhookRouter({
        db: config.db,
        registry,
        events,
        ...(logger !== undefined ? { logger } : {}),
      });
    },

    adminRoutes() {
      if (!config.adminGuard) {
        throw new Error(
          "createPaykit.adminRoutes() requires `adminGuard` in config. Pass an AdminGuard returning {allowed, adminUserId?, role?}.",
        );
      }
      const guard = config.adminGuard;
      const app = new Hono();
      app.route("/", buildAdminTransactionsRoute({ db: config.db, adminGuard: guard }));
      app.route("/", buildAdminWebhookEventsRoute({ db: config.db, adminGuard: guard }));
      app.route(
        "/",
        buildAdminLedgerAdjustRoute({
          db: config.db,
          adminGuard: guard,
          ...(config.onAdminAction !== undefined ? { onAdminAction: config.onAdminAction } : {}),
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      app.route(
        "/",
        buildAdminRefundRoute({
          db: config.db,
          adminGuard: guard,
          registry,
          ...(config.onAdminAction !== undefined ? { onAdminAction: config.onAdminAction } : {}),
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      return app;
    },
  };
}

// Re-export for convenience
export type { PaykitError };
