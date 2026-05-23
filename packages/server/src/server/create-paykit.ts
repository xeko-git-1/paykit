/**
 * createPaykit — main factory wiring all deps into a coherent Hono router.
 *
 * Usage:
 *   const paykit = createPaykit({ db, tenantResolver, providers, ... });
 *   app.route('/billing',  paykit.routes());        // checkout + balance + ledger
 *   app.route('/webhooks', paykit.webhookRoutes()); // sepay + stripe
 *   app.route('/admin/billing', paykit.adminRoutes()); // Phase 07
 */
import type { AdminGuard, DiscountResolver, PaykitError, TenantResolver } from "@vibecc/paykit";
import { Hono } from "hono";
import type { DbClient } from "../db/client.js";
import type { PaykitEventHandlers } from "../events/emitter.js";
import {
  type SePayClient,
  type SePayConfig,
  createSePayClient,
} from "../providers/sepay/client.js";
import {
  type StripeClient,
  type StripeConfig,
  createStripeClient,
} from "../providers/stripe/client.js";
import { buildBalanceRoute } from "../routes/billing/balance-route.js";
import { buildLedgerRoute } from "../routes/billing/ledger-route.js";
import { buildPaymentHistoryRoute } from "../routes/billing/payment-history-route.js";
import { buildSepayCheckoutRoute } from "../routes/checkout/sepay-route.js";
import { buildStripeCheckoutRoute } from "../routes/checkout/stripe-route.js";
import { buildSepayWebhookRoute } from "../routes/webhooks/sepay-handler.js";
import { buildStripeWebhookRoute } from "../routes/webhooks/stripe-handler.js";

export interface PaykitLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface PaykitConfig {
  readonly db: DbClient;
  readonly tenantResolver: TenantResolver;
  readonly discountResolver?: DiscountResolver;
  readonly adminGuard?: AdminGuard;
  readonly providers: {
    readonly sepay: SePayConfig;
    readonly stripe: StripeConfig;
  };
  readonly events?: PaykitEventHandlers;
  readonly logger?: PaykitLogger;
}

export interface Paykit {
  readonly db: DbClient;
  readonly clients: {
    readonly sepay: SePayClient;
    readonly stripe: StripeClient;
  };
  routes(): Hono;
  webhookRoutes(): Hono;
}

export function createPaykit(config: PaykitConfig): Paykit {
  const sepayClient = createSePayClient(config.providers.sepay);
  const stripeClient = createStripeClient(config.providers.stripe);
  const events: PaykitEventHandlers = config.events ?? {};
  const logger = config.logger;

  return {
    db: config.db,
    clients: { sepay: sepayClient, stripe: stripeClient },
    routes() {
      const app = new Hono();
      const checkout = new Hono();
      checkout.route(
        "/",
        buildSepayCheckoutRoute({
          db: config.db,
          tenantResolver: config.tenantResolver,
          ...(config.discountResolver !== undefined
            ? { discountResolver: config.discountResolver }
            : {}),
          sepayClient,
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      checkout.route(
        "/",
        buildStripeCheckoutRoute({
          db: config.db,
          tenantResolver: config.tenantResolver,
          ...(config.discountResolver !== undefined
            ? { discountResolver: config.discountResolver }
            : {}),
          stripeClient,
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      app.route("/checkout", checkout);
      // Billing read routes mount at /balance, /ledger, /payments.
      app.route("/", buildBalanceRoute({ db: config.db, tenantResolver: config.tenantResolver }));
      app.route("/", buildLedgerRoute({ db: config.db, tenantResolver: config.tenantResolver }));
      app.route(
        "/",
        buildPaymentHistoryRoute({ db: config.db, tenantResolver: config.tenantResolver }),
      );
      return app;
    },
    webhookRoutes() {
      const app = new Hono();
      app.route(
        "/",
        buildSepayWebhookRoute({
          db: config.db,
          sepayClient,
          events,
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      app.route(
        "/",
        buildStripeWebhookRoute({
          db: config.db,
          stripeClient,
          events,
          ...(logger !== undefined ? { logger } : {}),
        }),
      );
      return app;
    },
  };
}

// Re-export for convenience
export type { PaykitError };
