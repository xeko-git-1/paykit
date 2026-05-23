/**
 * adapter-shim.ts — converts V1 legacy `providers: { stripe, sepay }` shape
 * to V1.5 `providers: PaymentProviderAdapter[]` array via lazy import.
 *
 * V1 user upgrading to V1.5 must `pnpm add @vibecc/paykit-stripe @vibecc/paykit-sepay`.
 * This shim throws a CLEAR migration error if either package is missing
 * (instead of a raw ModuleNotFoundError).
 *
 * V1.5 user passing array shape skips this shim entirely.
 */
import type { PaymentProviderAdapter } from "@vibecc/paykit";
import type { LegacyProvidersConfig } from "./create-paykit.js";

export async function resolveProvidersToAdapters(
  providers: readonly PaymentProviderAdapter[] | LegacyProvidersConfig,
): Promise<readonly PaymentProviderAdapter[]> {
  if (Array.isArray(providers)) {
    return providers as readonly PaymentProviderAdapter[];
  }

  // Legacy shape — lazy import adapter packages
  const legacy = providers as LegacyProvidersConfig;
  const adapters: PaymentProviderAdapter[] = [];

  if (legacy.stripe !== undefined) {
    let createStripeAdapter: (cfg: unknown) => PaymentProviderAdapter;
    try {
      const mod = (await import("@vibecc/paykit-stripe")) as {
        createStripeAdapter: (cfg: unknown) => PaymentProviderAdapter;
      };
      createStripeAdapter = mod.createStripeAdapter;
    } catch {
      throw new Error(
        "Legacy `providers: { stripe }` shape requires `pnpm add @vibecc/paykit-stripe`. " +
          "V1.5 extracted Stripe to a separate adapter package — see docs/upgrading-v1-to-v1.5.md.",
      );
    }
    adapters.push(createStripeAdapter(legacy.stripe));
  }

  if (legacy.sepay !== undefined) {
    let createSepayAdapter: (cfg: unknown) => PaymentProviderAdapter;
    try {
      const mod = (await import("@vibecc/paykit-sepay")) as {
        createSepayAdapter: (cfg: unknown) => PaymentProviderAdapter;
      };
      createSepayAdapter = mod.createSepayAdapter;
    } catch {
      throw new Error(
        "Legacy `providers: { sepay }` shape requires `pnpm add @vibecc/paykit-sepay`. " +
          "V1.5 extracted SePay to a separate adapter package — see docs/upgrading-v1-to-v1.5.md.",
      );
    }
    adapters.push(createSepayAdapter(legacy.sepay));
  }

  return adapters;
}
