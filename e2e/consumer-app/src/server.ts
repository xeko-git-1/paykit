/**
 * V3 e2e harness — minimal createPaykit driver shared by Phase 04+ spec
 * stubs. Tests inject the providers array per spec; this module wires
 * routes onto a Hono app for fetch-based assertions.
 *
 * Phase 0b ships only the harness scaffold. Phase 04 wires Coinbase +
 * NowPayments adapters when they exist. Phase 02/03/04 live tests use the
 * fixtures dir + http-mock helper.
 */
import type {
  AdminGuard,
  PaymentProviderAdapter,
  TenantResolver,
} from "@vibecc/paykit";
import {
  type DbClient,
  type PaykitConfig,
  createPaykit,
} from "@vibecc/paykit-server";
import { Hono } from "hono";

export interface HarnessOptions {
  readonly db: DbClient;
  readonly providers: readonly PaymentProviderAdapter[];
  readonly tenantResolver?: TenantResolver;
  readonly adminGuard?: AdminGuard;
  readonly onBeforeCredit?: PaykitConfig["onBeforeCredit"];
  readonly emitMetric?: PaykitConfig["emitMetric"];
}

const DEFAULT_TENANT: TenantResolver = async () => ({
  tenantId: "tenant_e2e",
  ownerId: "user_e2e",
});

export async function buildHarnessApp(opts: HarnessOptions): Promise<Hono> {
  const paykit = await createPaykit({
    db: opts.db,
    tenantResolver: opts.tenantResolver ?? DEFAULT_TENANT,
    providers: opts.providers,
    ...(opts.adminGuard !== undefined ? { adminGuard: opts.adminGuard } : {}),
    ...(opts.onBeforeCredit !== undefined ? { onBeforeCredit: opts.onBeforeCredit } : {}),
    ...(opts.emitMetric !== undefined ? { emitMetric: opts.emitMetric } : {}),
  });

  const app = new Hono();
  app.route("/api/billing", paykit.routes());
  app.route("/webhooks", paykit.webhookRoutes());
  app.route("/admin", paykit.adminRoutes());
  return app;
}
