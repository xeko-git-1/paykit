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

  if (config.vnpay) {
    const { createVnpayAdapter } = await import("@vibecc/paykit-vnpay");
    adapters.push(
      createVnpayAdapter({
        tmnCode: config.vnpay.tmnCode,
        hashSecret: config.vnpay.hashSecret,
        returnUrl: config.vnpay.returnUrl,
        ipnUrl: config.vnpay.ipnUrl,
        environment: config.vnpay.environment,
      }),
    );
  }

  if (config.momo) {
    const { createMomoAdapter } = await import("@vibecc/paykit-momo");
    adapters.push(
      createMomoAdapter({
        partnerCode: config.momo.partnerCode,
        accessKey: config.momo.accessKey,
        secretKey: config.momo.secretKey,
        returnUrl: config.momo.returnUrl,
        ipnUrl: config.momo.ipnUrl,
        environment: config.momo.environment,
      }),
    );
  }

  if (config.zalopay) {
    const { createZaloPayAdapter } = await import("@vibecc/paykit-zalopay");
    adapters.push(
      createZaloPayAdapter({
        appId: config.zalopay.appId,
        key1: config.zalopay.key1,
        key2: config.zalopay.key2,
        returnUrl: config.zalopay.returnUrl,
        callbackUrl: config.zalopay.callbackUrl,
        environment: config.zalopay.environment,
      }),
    );
  }

  if (adapters.length === 0) {
    // Not fatal — the service can still serve health probes and the OpenAPI
    // spec — but a deploy with no providers almost certainly forgot its creds.
    console.warn(
      "paykit-service: no payment providers configured — checkout/refund routes will reject all requests.",
    );
  }

  return adapters;
}
