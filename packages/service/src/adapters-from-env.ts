/**
 * Adapter selection from environment — enables payment adapters based on
 * which provider credentials are present in the service config.
 *
 * Each adapter is lazily imported only when its creds are available.
 * This keeps the service lightweight when running with a subset of providers.
 */
import type { PaymentProviderAdapter } from "@vibecc/paykit";
import type { ServiceConfig } from "./config.js";

/**
 * Build the list of payment adapters based on which provider creds are
 * configured. Only imports adapter packages when their creds are present.
 */
export async function buildAdaptersFromConfig(
  config: ServiceConfig,
): Promise<PaymentProviderAdapter[]> {
  const adapters: PaymentProviderAdapter[] = [];

  if (config.stripe) {
    const { createStripeAdapter } = await import("@vibecc/paykit-stripe");
    adapters.push(
      createStripeAdapter({
        secretKey: config.stripe.secretKey,
        webhookSecret: config.stripe.webhookSecret,
        successUrl: config.stripe.successUrl,
        cancelUrl: config.stripe.cancelUrl,
      }),
    );
  }

  if (config.sepay) {
    const { createSepayAdapter } = await import("@vibecc/paykit-sepay");
    adapters.push(
      createSepayAdapter({
        apiKey: config.sepay.apiKey,
        secretKey: config.sepay.secretKey,
        accountNumber: config.sepay.accountNumber,
        accountName: config.sepay.accountName,
        bankBin: config.sepay.bankBin,
      }),
    );
  }

  if (config.nowpayments) {
    const { createNowpaymentsAdapter } = await import("@vibecc/paykit-nowpayments");
    adapters.push(
      createNowpaymentsAdapter({
        apiKey: config.nowpayments.apiKey,
        ipnSecret: config.nowpayments.ipnSecret,
        environment: config.nowpayments.environment,
      }),
    );
  }

  return adapters;
}
