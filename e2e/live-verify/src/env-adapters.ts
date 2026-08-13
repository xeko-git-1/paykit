/**
 * Adapter construction from env for the live-verify harness — crypto providers
 * only. Mirrors packages/service/src/adapters-from-env.ts semantics (a provider
 * is enabled when its creds are present, all-or-nothing) but adds BitPay, which
 * runs embedded-style here with the node-crypto merchant signer.
 *
 * PUBLIC_BASE_URL is the tunnel URL (cloudflared/ngrok) that providers must be
 * able to reach; webhook URLs are derived from it as
 * `${PUBLIC_BASE_URL}/webhooks/<providerId>` so no per-provider URL needs
 * hand-writing.
 */
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";

export interface LiveVerifyEnv {
  readonly publicBaseUrl?: string;
  readonly returnUrl?: string;
  readonly env: Record<string, string | undefined>;
}

function need(env: Record<string, string | undefined>, keys: string[]): boolean {
  const present = keys.filter((k) => env[k] !== undefined && env[k] !== "");
  if (present.length === 0) return false;
  if (present.length < keys.length) {
    const missing = keys.filter((k) => !present.includes(k));
    throw new Error(
      `Incomplete provider config: set [${present.join(", ")}] but missing [${missing.join(", ")}]`,
    );
  }
  return true;
}

export async function buildLiveVerifyAdapters(opts: LiveVerifyEnv): Promise<{
  adapters: PaymentProviderAdapter[];
  notes: string[];
}> {
  const { env, publicBaseUrl } = opts;
  const adapters: PaymentProviderAdapter[] = [];
  const notes: string[] = [];
  const webhookUrl = (id: string): string | undefined =>
    publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/webhooks/${id}` : undefined;
  const returnUrl = opts.returnUrl ?? (publicBaseUrl ? `${publicBaseUrl}/return` : undefined);

  if (need(env, ["NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"])) {
    const { createNowpaymentsAdapter } = await import("@xeko-git-1/paykit-nowpayments");
    const ipnUrl = webhookUrl("nowpayments");
    adapters.push(
      createNowpaymentsAdapter({
        apiKey: env.NOWPAYMENTS_API_KEY!,
        ipnSecret: env.NOWPAYMENTS_IPN_SECRET!,
        environment: env.NOWPAYMENTS_ENVIRONMENT === "production" ? "production" : "sandbox",
        ...(env.NOWPAYMENTS_PAY_CURRENCY ? { payCurrency: env.NOWPAYMENTS_PAY_CURRENCY } : {}),
        ...(ipnUrl !== undefined ? { ipnUrl } : {}),
        ...(returnUrl !== undefined ? { returnUrl } : {}),
      }),
    );
    notes.push(
      `nowpayments: ${env.NOWPAYMENTS_ENVIRONMENT ?? "sandbox"}, payCurrency=${env.NOWPAYMENTS_PAY_CURRENCY ?? "(customer choice)"}`,
    );
  }

  if (need(env, ["CRYPTOMUS_MERCHANT_ID", "CRYPTOMUS_PAYMENT_API_KEY"])) {
    const { createCryptomusAdapter } = await import("@xeko-git-1/paykit-cryptomus");
    const callbackUrl = webhookUrl("cryptomus");
    adapters.push(
      createCryptomusAdapter({
        merchantId: env.CRYPTOMUS_MERCHANT_ID!,
        paymentApiKey: env.CRYPTOMUS_PAYMENT_API_KEY!,
        ...(env.CRYPTOMUS_TO_CURRENCY ? { toCurrency: env.CRYPTOMUS_TO_CURRENCY } : {}),
        ...(env.CRYPTOMUS_NETWORK ? { network: env.CRYPTOMUS_NETWORK } : {}),
        ...(callbackUrl !== undefined ? { callbackUrl } : {}),
        ...(returnUrl !== undefined ? { returnUrl } : {}),
      }),
    );
    notes.push(
      `cryptomus: network=${env.CRYPTOMUS_NETWORK ?? "(customer choice)"}, toCurrency=${env.CRYPTOMUS_TO_CURRENCY ?? "(customer choice)"}`,
    );
  }

  if (need(env, ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_WEBHOOK_PUBLIC_KEY"])) {
    const { createBinanceAdapter } = await import("@xeko-git-1/paykit-binance");
    const binanceWebhookUrl = webhookUrl("binance");
    adapters.push(
      createBinanceAdapter({
        apiKey: env.BINANCE_API_KEY!,
        apiSecret: env.BINANCE_API_SECRET!,
        webhookPublicKey: env.BINANCE_WEBHOOK_PUBLIC_KEY!,
        ...(binanceWebhookUrl !== undefined ? { webhookUrl: binanceWebhookUrl } : {}),
        ...(returnUrl !== undefined ? { returnUrl } : {}),
      }),
    );
    notes.push("binance: LIVE API (no sandbox exists) — use the smallest amount possible");
  }

  if (need(env, ["BITPAY_API_TOKEN"])) {
    const { createBitpayAdapter, createNodeMerchantSigner } = await import(
      "@xeko-git-1/paykit-bitpay"
    );
    const signerKey = env.BITPAY_MERCHANT_PRIVATE_KEY;
    const notificationUrl = webhookUrl("bitpay");
    adapters.push(
      createBitpayAdapter({
        apiToken: env.BITPAY_API_TOKEN!,
        environment: env.BITPAY_ENVIRONMENT === "production" ? "production" : "sandbox",
        ...(signerKey ? { merchantSigner: createNodeMerchantSigner(signerKey) } : {}),
        ...(notificationUrl !== undefined ? { notificationUrl } : {}),
        ...(returnUrl !== undefined ? { redirectUrl: returnUrl } : {}),
      }),
    );
    notes.push(
      `bitpay: ${env.BITPAY_ENVIRONMENT ?? "sandbox"}, merchantSigner=${signerKey ? "configured (refunds enabled)" : "MISSING (refunds disabled)"}`,
    );
  }

  if (need(env, ["COINBASE_COMMERCE_API_KEY", "COINBASE_COMMERCE_WEBHOOK_SECRET"])) {
    const { createCoinbaseCommerceAdapter } = await import("@xeko-git-1/paykit-coinbase-commerce");
    adapters.push(
      createCoinbaseCommerceAdapter({
        apiKey: env.COINBASE_COMMERCE_API_KEY!,
        webhookSecret: env.COINBASE_COMMERCE_WEBHOOK_SECRET!,
        ...(returnUrl !== undefined ? { redirectUrl: returnUrl } : {}),
      }),
    );
    notes.push(
      "coinbase-commerce: webhook URL must be registered in the Coinbase dashboard " +
        `(point it at ${webhookUrl("coinbase-commerce") ?? "<PUBLIC_BASE_URL>/webhooks/coinbase-commerce"})`,
    );
  }

  return { adapters, notes };
}
