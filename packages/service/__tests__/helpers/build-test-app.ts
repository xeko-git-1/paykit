/**
 * Shared test helper — builds a service app with a mock adapter so webhook
 * routes are registered and testable without real provider credentials.
 */
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";
import { buildServiceApp } from "../../src/main.js";

/**
 * Minimal mock adapter that satisfies the PaymentProviderAdapter interface.
 * Registers as "sepay" so webhook route /webhooks/sepay exists.
 */
function createMockAdapter(id = "sepay"): PaymentProviderAdapter {
  return {
    id,
    supportedCurrencies: ["VND"],
    checkoutMode: "qr" as const,
    createCheckout: async () => {
      throw new Error("mock: not implemented");
    },
    // Sync to match the real PaymentProviderAdapter interface. Returning a
    // Promise here (async) would make the router treat the truthy Promise as a
    // parsed event and fall through to db.transaction() on a null db.
    parseWebhookPayload: () => null,
    verifyWebhookSignature: () => true,
    refund: async () => ({ state: "unsupported" as const, reason: "mock" }),
    fetchTransactions: async () => [],
  };
}

export async function buildTestApp() {
  return buildServiceApp({
    db: null as never, // health doesn't need DB; auth rejects before DB call
    providers: [createMockAdapter("sepay")],
    jwtSecretLoader: async () => "test-secret-that-is-at-least-32-bytes-long!!",
  });
}
