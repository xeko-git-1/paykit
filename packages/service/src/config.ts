/**
 * Service configuration — zod-validated env parsing with fail-fast semantics.
 *
 * JWT signing secret is NOT read from env. It lives in the runtime_config
 * table and is loaded/seeded at service start by createJwtSecretLoader
 * (see @xeko-git-1/paykit-server jwt-middleware).
 */
import { describeUnknownChainCodes, findUnknownChainCodes } from "@xeko-git-1/paykit";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Env schema — fail-fast on missing critical vars
// ---------------------------------------------------------------------------

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3000))
    .pipe(z.number().int().min(1).max(65535)),

  // Provider creds — optional; adapter enabled when present
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().optional(),
  STRIPE_CANCEL_URL: z.string().optional(),

  SEPAY_API_KEY: z.string().optional(),
  SEPAY_SECRET_KEY: z.string().optional(),
  SEPAY_ACCOUNT_NUMBER: z.string().optional(),
  SEPAY_ACCOUNT_NAME: z.string().optional(),
  SEPAY_BANK_BIN: z.string().optional(),

  // ApiPay (VN Open Banking bank transfer) — enabled when all required creds
  // present. The webhook secret is issued per webhook endpoint and is separate
  // from the API secret key; without it no inbound event can be verified, so a
  // deploy with only API keys could create payment links it could never credit.
  APIPAY_ACCESS_KEY: z.string().optional(),
  APIPAY_SECRET_KEY: z.string().optional(),
  APIPAY_WEBHOOK_SECRET: z.string().optional(),
  APIPAY_BANK_PUBLIC_ID: z.string().optional(),

  NOWPAYMENTS_API_KEY: z.string().optional(),
  NOWPAYMENTS_IPN_SECRET: z.string().optional(),
  NOWPAYMENTS_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  // Optional: force a single pay currency/chain (e.g. usdtbsc=BEP20,
  // usdttrc20=TRC20, usdterc20=ERC20, usdtmatic=Polygon). Leave unset to let
  // the customer pick the coin+chain on the NowPayments checkout page.
  NOWPAYMENTS_PAY_CURRENCY: z.string().optional(),

  // VNPay (VN bank/QR) — enabled when all required creds present
  VNPAY_TMN_CODE: z.string().optional(),
  VNPAY_HASH_SECRET: z.string().optional(),
  VNPAY_RETURN_URL: z.string().optional(),
  VNPAY_IPN_URL: z.string().optional(),
  VNPAY_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),

  // Momo (VN wallet)
  MOMO_PARTNER_CODE: z.string().optional(),
  MOMO_ACCESS_KEY: z.string().optional(),
  MOMO_SECRET_KEY: z.string().optional(),
  MOMO_RETURN_URL: z.string().optional(),
  MOMO_IPN_URL: z.string().optional(),
  MOMO_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),

  // ZaloPay (VN wallet)
  ZALOPAY_APP_ID: z.string().optional(),
  ZALOPAY_KEY1: z.string().optional(),
  ZALOPAY_KEY2: z.string().optional(),
  ZALOPAY_RETURN_URL: z.string().optional(),
  ZALOPAY_CALLBACK_URL: z.string().optional(),
  ZALOPAY_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),

  // Cryptomus (multi-chain USDT gateway) — enabled when merchant + api key present
  CRYPTOMUS_MERCHANT_ID: z.string().optional(),
  CRYPTOMUS_PAYMENT_API_KEY: z.string().optional(),
  // Optional: pin a settlement coin (e.g. USDT) and/or chain (bsc=BEP20,
  // tron=TRC20, eth=ERC20, polygon). Leave unset to let the customer pick
  // coin+chain on the Cryptomus pay page.
  CRYPTOMUS_TO_CURRENCY: z.string().optional(),
  CRYPTOMUS_NETWORK: z.string().optional(),
  CRYPTOMUS_RETURN_URL: z.string().optional(),
  CRYPTOMUS_CALLBACK_URL: z.string().optional(),

  // Binance Pay (off-chain, funds settle inside Binance wallets) — enabled when
  // api key + secret + webhook public key are all present. The public key is
  // `certPublic` from POST /binancepay/openapi/certificates; without it no
  // webhook can be verified, so it is required rather than optional.
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  BINANCE_RETURN_URL: z.string().optional(),
  BINANCE_CANCEL_URL: z.string().optional(),
  BINANCE_WEBHOOK_URL: z.string().optional(),

  // BitPay (crypto invoices, unsigned webhooks resolved by fetch-back) — enabled
  // when the POS-facade token is present. The merchant private key is optional:
  // without it checkout + webhook credit still work, but refunds and
  // reconciliation (merchant facade, ECDSA-signed) are disabled.
  BITPAY_API_TOKEN: z.string().optional(),
  BITPAY_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  // 64-hex-char private key (BitPay SDK format) or a secp256k1 PEM.
  BITPAY_MERCHANT_PRIVATE_KEY: z.string().optional(),
  BITPAY_NOTIFICATION_URL: z.string().optional(),
  BITPAY_REDIRECT_URL: z.string().optional(),

  // Coinbase Commerce (USD-priced crypto charges) — enabled when the API key and
  // the webhook shared secret are both present. The secret is separate from the
  // API key and is what every inbound event is verified against, so a deploy with
  // only the API key could create charges it could never credit.
  COINBASE_COMMERCE_API_KEY: z.string().optional(),
  COINBASE_COMMERCE_WEBHOOK_SECRET: z.string().optional(),
  COINBASE_COMMERCE_REDIRECT_URL: z.string().optional(),
  COINBASE_COMMERCE_CANCEL_URL: z.string().optional(),

  // Polar (polar.sh, USD/EUR merchant of record) — enabled when the access
  // token, product id, and webhook secret are all present. Polar has no
  // amount-only checkout, so a pre-created product is required: every paykit
  // charge is priced over it with a per-session fixed price override. The
  // webhook secret is separate from the token and is what every inbound event
  // is verified against (Standard Webhooks).
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_PRODUCT_ID: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  POLAR_SUCCESS_URL: z.string().optional(),

  // Paddle Billing (USD/EUR/JPY merchant of record) — enabled when the API key
  // and the webhook endpoint secret are both present. Prices are inline
  // (non-catalog) so no product needs pre-creating, BUT the Paddle account
  // must have an approved default payment link (a page embedding Paddle.js) or
  // transaction creation is rejected. PADDLE_CHECKOUT_URL overrides that
  // default per deploy.
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  PADDLE_CHECKOUT_URL: z.string().optional(),

  // Creem.io (USD/EUR, licensing-capable) — enabled when the API key, product
  // id, and webhook secret are all present. Like Polar, every charge is priced
  // over one pre-created product (custom_price override). Refunds are
  // dashboard-only on Creem's side; the refund webhook settles the paykit row.
  CREEM_API_KEY: z.string().optional(),
  CREEM_PRODUCT_ID: z.string().optional(),
  CREEM_WEBHOOK_SECRET: z.string().optional(),
  CREEM_ENVIRONMENT: z.enum(["test", "production"]).optional(),
  CREEM_SUCCESS_URL: z.string().optional(),

  // Accept a coin/chain code paykit does not recognise. The crypto gateways add
  // combinations faster than paykit can enumerate them, so this is the escape
  // hatch for a genuinely newer code — the value is then passed through to the
  // provider unchecked, and a typo will surface as a failed checkout instead.
  PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  // How long a pending_webhook refund may wait for its confirmation before the
  // background sweeper reports it overdue (metric + admin queue). Hours,
  // because the runbook threshold is a day, not milliseconds.
  PAYKIT_REFUND_WEBHOOK_TIMEOUT_HOURS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : Number.parseFloat(v)))
    .pipe(z.number().positive().finite().optional()),

  // How long an unpaid checkout may exist before the background sweeper expires
  // it and releases its discount reservation. Money-relevant: must exceed the
  // longest provider checkout validity, because a payment landing after the
  // expiry does not credit. Default 48h.
  PAYKIT_CHECKOUT_STALE_TTL_HOURS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : Number.parseFloat(v)))
    .pipe(z.number().positive().finite().optional()),

  // Admin guard secret (env-based for V4.0; dashboard JWT is V4.4)
  ADMIN_SECRET: z.string().optional(),
});

export interface ServiceConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly stripe:
    | {
        secretKey: string;
        webhookSecret: string;
        successUrl: string;
        cancelUrl: string;
      }
    | undefined;
  readonly sepay:
    | {
        apiKey: string;
        secretKey: string;
        accountNumber: string;
        accountName: string;
        bankBin: string;
      }
    | undefined;
  readonly apipay:
    | {
        accessKey: string;
        secretKey: string;
        webhookSecret: string;
        bankPublicId: string;
      }
    | undefined;
  readonly nowpayments:
    | {
        apiKey: string;
        ipnSecret: string;
        environment: "sandbox" | "production";
        payCurrency?: string;
      }
    | undefined;
  readonly vnpay:
    | {
        tmnCode: string;
        hashSecret: string;
        returnUrl: string;
        ipnUrl: string;
        environment: "sandbox" | "production";
      }
    | undefined;
  readonly momo:
    | {
        partnerCode: string;
        accessKey: string;
        secretKey: string;
        returnUrl: string;
        ipnUrl: string;
        environment: "sandbox" | "production";
      }
    | undefined;
  readonly zalopay:
    | {
        appId: string;
        key1: string;
        key2: string;
        returnUrl: string;
        callbackUrl: string;
        environment: "sandbox" | "production";
      }
    | undefined;
  readonly cryptomus:
    | {
        merchantId: string;
        paymentApiKey: string;
        toCurrency?: string;
        network?: string;
        returnUrl?: string;
        callbackUrl?: string;
      }
    | undefined;
  readonly binance:
    | {
        apiKey: string;
        apiSecret: string;
        webhookPublicKey: string;
        returnUrl?: string;
        cancelUrl?: string;
        webhookUrl?: string;
      }
    | undefined;
  readonly bitpay:
    | {
        apiToken: string;
        environment: "sandbox" | "production";
        merchantPrivateKey?: string;
        notificationUrl?: string;
        redirectUrl?: string;
      }
    | undefined;
  readonly coinbaseCommerce:
    | {
        apiKey: string;
        webhookSecret: string;
        redirectUrl?: string;
        cancelUrl?: string;
      }
    | undefined;
  readonly polar:
    | {
        accessToken: string;
        productId: string;
        webhookSecret: string;
        environment: "sandbox" | "production";
        successUrl?: string;
      }
    | undefined;
  readonly paddle:
    | {
        apiKey: string;
        webhookSecret: string;
        environment: "sandbox" | "production";
        checkoutUrl?: string;
      }
    | undefined;
  readonly creem:
    | {
        apiKey: string;
        productId: string;
        webhookSecret: string;
        environment: "test" | "production";
        successUrl?: string;
      }
    | undefined;
  readonly adminSecret: string | undefined;
  /** Hours before a pending_webhook refund is reported overdue. Default 24 (in the sweeper). */
  readonly refundWebhookTimeoutHours: number | undefined;
  /** Hours before an unpaid checkout is expired and its discount reservation freed. Default 48 (in the sweeper). */
  readonly checkoutStaleTtlHours: number | undefined;
}

/**
 * Parse and validate env vars. Throws on missing critical config.
 * Never echoes secret values in error messages.
 */
/**
 * Resolve a provider's credentials with all-or-nothing semantics. If none of
 * the required vars are set, the provider is simply disabled (returns
 * undefined). If some — but not all — are set, that is almost always a
 * misconfigured deploy (a typo'd or forgotten secret), so we fail fast at boot
 * with the exact missing field names rather than silently starting without the
 * provider. Never echoes secret values.
 */
function resolveProviderCreds<K extends string, T>(
  providerName: string,
  required: Record<K, string | undefined>,
  build: (credentials: Record<K, string>) => T,
): T | undefined {
  const present: string[] = [];
  const missing: string[] = [];
  const credentials = {} as Record<K, string>;

  for (const key of Object.keys(required) as K[]) {
    const value = required[key];
    if (value === undefined || value === "") {
      missing.push(key);
    } else {
      present.push(key);
      credentials[key] = value;
    }
  }

  if (present.length === 0) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `Incomplete ${providerName} configuration: set [${present.join(", ")}] ` +
        `but missing [${missing.join(", ")}]. Provide all required vars or none.`,
    );
  }
  return build(credentials);
}

export function parseServiceConfig(env: Record<string, string | undefined>): ServiceConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Redact: only show field names, never values
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Service config validation failed: ${fields}`);
  }

  const parsed = result.data;

  // Coin/chain codes are checked before any adapter is built. An unrecognised
  // code is otherwise accepted here and rejected by the provider at every
  // checkout, which reads as a transient provider fault rather than the static
  // misconfiguration it is. Unlike the generic zod failure above this message
  // quotes the value: a chain code is not a secret, and withholding it leaves
  // the operator without the one detail that identifies the mistake.
  if (!parsed.PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES) {
    const unknown = findUnknownChainCodes({
      nowpaymentsPayCurrency: parsed.NOWPAYMENTS_PAY_CURRENCY,
      cryptomusNetwork: parsed.CRYPTOMUS_NETWORK,
      cryptomusToCurrency: parsed.CRYPTOMUS_TO_CURRENCY,
    });
    if (unknown.length > 0) {
      throw new Error(describeUnknownChainCodes(unknown, "PAYKIT_ALLOW_UNKNOWN_CHAIN_CODES"));
    }
  }

  const stripe = resolveProviderCreds(
    "Stripe",
    {
      STRIPE_SECRET_KEY: parsed.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: parsed.STRIPE_WEBHOOK_SECRET,
    },
    (creds) => ({
      secretKey: creds.STRIPE_SECRET_KEY,
      webhookSecret: creds.STRIPE_WEBHOOK_SECRET,
      successUrl: parsed.STRIPE_SUCCESS_URL ?? "http://localhost:3000/success",
      cancelUrl: parsed.STRIPE_CANCEL_URL ?? "http://localhost:3000/cancel",
    }),
  );

  const sepay = resolveProviderCreds(
    "SePay",
    {
      SEPAY_API_KEY: parsed.SEPAY_API_KEY,
      SEPAY_SECRET_KEY: parsed.SEPAY_SECRET_KEY,
      SEPAY_ACCOUNT_NUMBER: parsed.SEPAY_ACCOUNT_NUMBER,
      SEPAY_ACCOUNT_NAME: parsed.SEPAY_ACCOUNT_NAME,
      SEPAY_BANK_BIN: parsed.SEPAY_BANK_BIN,
    },
    (creds) => ({
      apiKey: creds.SEPAY_API_KEY,
      secretKey: creds.SEPAY_SECRET_KEY,
      accountNumber: creds.SEPAY_ACCOUNT_NUMBER,
      accountName: creds.SEPAY_ACCOUNT_NAME,
      bankBin: creds.SEPAY_BANK_BIN,
    }),
  );

  const apipay = resolveProviderCreds(
    "ApiPay",
    {
      APIPAY_ACCESS_KEY: parsed.APIPAY_ACCESS_KEY,
      APIPAY_SECRET_KEY: parsed.APIPAY_SECRET_KEY,
      APIPAY_WEBHOOK_SECRET: parsed.APIPAY_WEBHOOK_SECRET,
      APIPAY_BANK_PUBLIC_ID: parsed.APIPAY_BANK_PUBLIC_ID,
    },
    (creds) => ({
      accessKey: creds.APIPAY_ACCESS_KEY,
      secretKey: creds.APIPAY_SECRET_KEY,
      webhookSecret: creds.APIPAY_WEBHOOK_SECRET,
      bankPublicId: creds.APIPAY_BANK_PUBLIC_ID,
    }),
  );

  const nowpayments = resolveProviderCreds(
    "NOWPayments",
    {
      NOWPAYMENTS_API_KEY: parsed.NOWPAYMENTS_API_KEY,
      NOWPAYMENTS_IPN_SECRET: parsed.NOWPAYMENTS_IPN_SECRET,
    },
    (creds) => ({
      apiKey: creds.NOWPAYMENTS_API_KEY,
      ipnSecret: creds.NOWPAYMENTS_IPN_SECRET,
      environment: parsed.NOWPAYMENTS_ENVIRONMENT ?? ("production" as const),
      // Optional. Leave unset so the customer picks any USDT chain (BEP20/TRC20/
      // ERC20/…) on the NowPayments page; set to force one chain, e.g.
      // 'usdtbsc' (BEP20), 'usdttrc20', 'usdterc20', 'usdtmatic'.
      ...(parsed.NOWPAYMENTS_PAY_CURRENCY !== undefined && parsed.NOWPAYMENTS_PAY_CURRENCY !== ""
        ? { payCurrency: parsed.NOWPAYMENTS_PAY_CURRENCY }
        : {}),
    }),
  );

  const vnpay = resolveProviderCreds(
    "VNPay",
    {
      VNPAY_TMN_CODE: parsed.VNPAY_TMN_CODE,
      VNPAY_HASH_SECRET: parsed.VNPAY_HASH_SECRET,
      VNPAY_RETURN_URL: parsed.VNPAY_RETURN_URL,
      VNPAY_IPN_URL: parsed.VNPAY_IPN_URL,
    },
    (creds) => ({
      tmnCode: creds.VNPAY_TMN_CODE,
      hashSecret: creds.VNPAY_HASH_SECRET,
      returnUrl: creds.VNPAY_RETURN_URL,
      ipnUrl: creds.VNPAY_IPN_URL,
      environment: parsed.VNPAY_ENVIRONMENT ?? ("sandbox" as const),
    }),
  );

  const momo = resolveProviderCreds(
    "Momo",
    {
      MOMO_PARTNER_CODE: parsed.MOMO_PARTNER_CODE,
      MOMO_ACCESS_KEY: parsed.MOMO_ACCESS_KEY,
      MOMO_SECRET_KEY: parsed.MOMO_SECRET_KEY,
      MOMO_RETURN_URL: parsed.MOMO_RETURN_URL,
      MOMO_IPN_URL: parsed.MOMO_IPN_URL,
    },
    (creds) => ({
      partnerCode: creds.MOMO_PARTNER_CODE,
      accessKey: creds.MOMO_ACCESS_KEY,
      secretKey: creds.MOMO_SECRET_KEY,
      returnUrl: creds.MOMO_RETURN_URL,
      ipnUrl: creds.MOMO_IPN_URL,
      environment: parsed.MOMO_ENVIRONMENT ?? ("sandbox" as const),
    }),
  );

  const zalopay = resolveProviderCreds(
    "ZaloPay",
    {
      ZALOPAY_APP_ID: parsed.ZALOPAY_APP_ID,
      ZALOPAY_KEY1: parsed.ZALOPAY_KEY1,
      ZALOPAY_KEY2: parsed.ZALOPAY_KEY2,
      ZALOPAY_RETURN_URL: parsed.ZALOPAY_RETURN_URL,
      ZALOPAY_CALLBACK_URL: parsed.ZALOPAY_CALLBACK_URL,
    },
    (creds) => ({
      appId: creds.ZALOPAY_APP_ID,
      key1: creds.ZALOPAY_KEY1,
      key2: creds.ZALOPAY_KEY2,
      returnUrl: creds.ZALOPAY_RETURN_URL,
      callbackUrl: creds.ZALOPAY_CALLBACK_URL,
      environment: parsed.ZALOPAY_ENVIRONMENT ?? ("sandbox" as const),
    }),
  );

  const cryptomus = resolveProviderCreds(
    "Cryptomus",
    {
      CRYPTOMUS_MERCHANT_ID: parsed.CRYPTOMUS_MERCHANT_ID,
      CRYPTOMUS_PAYMENT_API_KEY: parsed.CRYPTOMUS_PAYMENT_API_KEY,
    },
    (creds) => ({
      merchantId: creds.CRYPTOMUS_MERCHANT_ID,
      paymentApiKey: creds.CRYPTOMUS_PAYMENT_API_KEY,
      // All optional. Leave to_currency/network unset so the customer picks any
      // USDT chain (BEP20/TRC20/ERC20/…) on the Cryptomus page; set to pin one.
      ...(parsed.CRYPTOMUS_TO_CURRENCY !== undefined && parsed.CRYPTOMUS_TO_CURRENCY !== ""
        ? { toCurrency: parsed.CRYPTOMUS_TO_CURRENCY }
        : {}),
      ...(parsed.CRYPTOMUS_NETWORK !== undefined && parsed.CRYPTOMUS_NETWORK !== ""
        ? { network: parsed.CRYPTOMUS_NETWORK }
        : {}),
      ...(parsed.CRYPTOMUS_RETURN_URL !== undefined && parsed.CRYPTOMUS_RETURN_URL !== ""
        ? { returnUrl: parsed.CRYPTOMUS_RETURN_URL }
        : {}),
      ...(parsed.CRYPTOMUS_CALLBACK_URL !== undefined && parsed.CRYPTOMUS_CALLBACK_URL !== ""
        ? { callbackUrl: parsed.CRYPTOMUS_CALLBACK_URL }
        : {}),
    }),
  );

  const binance = resolveProviderCreds(
    "Binance Pay",
    {
      BINANCE_API_KEY: parsed.BINANCE_API_KEY,
      BINANCE_API_SECRET: parsed.BINANCE_API_SECRET,
      // Required, not optional: without Binance's public key every webhook
      // fails signature verification, so a paid order would never be credited.
      BINANCE_WEBHOOK_PUBLIC_KEY: parsed.BINANCE_WEBHOOK_PUBLIC_KEY,
    },
    (creds) => ({
      apiKey: creds.BINANCE_API_KEY,
      apiSecret: creds.BINANCE_API_SECRET,
      webhookPublicKey: creds.BINANCE_WEBHOOK_PUBLIC_KEY,
      ...(parsed.BINANCE_RETURN_URL !== undefined && parsed.BINANCE_RETURN_URL !== ""
        ? { returnUrl: parsed.BINANCE_RETURN_URL }
        : {}),
      ...(parsed.BINANCE_CANCEL_URL !== undefined && parsed.BINANCE_CANCEL_URL !== ""
        ? { cancelUrl: parsed.BINANCE_CANCEL_URL }
        : {}),
      ...(parsed.BINANCE_WEBHOOK_URL !== undefined && parsed.BINANCE_WEBHOOK_URL !== ""
        ? { webhookUrl: parsed.BINANCE_WEBHOOK_URL }
        : {}),
    }),
  );

  const bitpay = resolveProviderCreds(
    "BitPay",
    {
      BITPAY_API_TOKEN: parsed.BITPAY_API_TOKEN,
    },
    (creds) => ({
      apiToken: creds.BITPAY_API_TOKEN,
      environment: parsed.BITPAY_ENVIRONMENT ?? ("sandbox" as const),
      // Optional: enables the merchant facade (refunds + reconciliation).
      ...(parsed.BITPAY_MERCHANT_PRIVATE_KEY !== undefined &&
      parsed.BITPAY_MERCHANT_PRIVATE_KEY !== ""
        ? { merchantPrivateKey: parsed.BITPAY_MERCHANT_PRIVATE_KEY }
        : {}),
      ...(parsed.BITPAY_NOTIFICATION_URL !== undefined && parsed.BITPAY_NOTIFICATION_URL !== ""
        ? { notificationUrl: parsed.BITPAY_NOTIFICATION_URL }
        : {}),
      ...(parsed.BITPAY_REDIRECT_URL !== undefined && parsed.BITPAY_REDIRECT_URL !== ""
        ? { redirectUrl: parsed.BITPAY_REDIRECT_URL }
        : {}),
    }),
  );

  const coinbaseCommerce = resolveProviderCreds(
    "Coinbase Commerce",
    {
      COINBASE_COMMERCE_API_KEY: parsed.COINBASE_COMMERCE_API_KEY,
      // Required, not optional: every inbound event is authenticated against this
      // secret, so without it a paid charge could never be credited.
      COINBASE_COMMERCE_WEBHOOK_SECRET: parsed.COINBASE_COMMERCE_WEBHOOK_SECRET,
    },
    (creds) => ({
      apiKey: creds.COINBASE_COMMERCE_API_KEY,
      webhookSecret: creds.COINBASE_COMMERCE_WEBHOOK_SECRET,
      ...(parsed.COINBASE_COMMERCE_REDIRECT_URL !== undefined &&
      parsed.COINBASE_COMMERCE_REDIRECT_URL !== ""
        ? { redirectUrl: parsed.COINBASE_COMMERCE_REDIRECT_URL }
        : {}),
      ...(parsed.COINBASE_COMMERCE_CANCEL_URL !== undefined &&
      parsed.COINBASE_COMMERCE_CANCEL_URL !== ""
        ? { cancelUrl: parsed.COINBASE_COMMERCE_CANCEL_URL }
        : {}),
    }),
  );

  const polar = resolveProviderCreds(
    "Polar",
    {
      POLAR_ACCESS_TOKEN: parsed.POLAR_ACCESS_TOKEN,
      // Required, not optional: Polar has no amount-only checkout, so without
      // a product to price over no session can be created.
      POLAR_PRODUCT_ID: parsed.POLAR_PRODUCT_ID,
      // Required, not optional: every inbound event is authenticated against
      // this secret, so without it a paid order could never be credited.
      POLAR_WEBHOOK_SECRET: parsed.POLAR_WEBHOOK_SECRET,
    },
    (creds) => ({
      accessToken: creds.POLAR_ACCESS_TOKEN,
      productId: creds.POLAR_PRODUCT_ID,
      webhookSecret: creds.POLAR_WEBHOOK_SECRET,
      environment: parsed.POLAR_ENVIRONMENT ?? ("sandbox" as const),
      ...(parsed.POLAR_SUCCESS_URL !== undefined && parsed.POLAR_SUCCESS_URL !== ""
        ? { successUrl: parsed.POLAR_SUCCESS_URL }
        : {}),
    }),
  );

  const paddle = resolveProviderCreds(
    "Paddle",
    {
      PADDLE_API_KEY: parsed.PADDLE_API_KEY,
      // Required, not optional: every inbound event is authenticated against
      // this secret, so without it a completed transaction could never credit.
      PADDLE_WEBHOOK_SECRET: parsed.PADDLE_WEBHOOK_SECRET,
    },
    (creds) => ({
      apiKey: creds.PADDLE_API_KEY,
      webhookSecret: creds.PADDLE_WEBHOOK_SECRET,
      environment: parsed.PADDLE_ENVIRONMENT ?? ("sandbox" as const),
      ...(parsed.PADDLE_CHECKOUT_URL !== undefined && parsed.PADDLE_CHECKOUT_URL !== ""
        ? { checkoutUrl: parsed.PADDLE_CHECKOUT_URL }
        : {}),
    }),
  );

  const creem = resolveProviderCreds(
    "Creem",
    {
      CREEM_API_KEY: parsed.CREEM_API_KEY,
      // Required, not optional: Creem checkouts are priced over a product, so
      // without one no session can be created.
      CREEM_PRODUCT_ID: parsed.CREEM_PRODUCT_ID,
      // Required, not optional: every inbound event is authenticated against
      // this secret, so without it a completed checkout could never credit.
      CREEM_WEBHOOK_SECRET: parsed.CREEM_WEBHOOK_SECRET,
    },
    (creds) => ({
      apiKey: creds.CREEM_API_KEY,
      productId: creds.CREEM_PRODUCT_ID,
      webhookSecret: creds.CREEM_WEBHOOK_SECRET,
      environment: parsed.CREEM_ENVIRONMENT ?? ("test" as const),
      ...(parsed.CREEM_SUCCESS_URL !== undefined && parsed.CREEM_SUCCESS_URL !== ""
        ? { successUrl: parsed.CREEM_SUCCESS_URL }
        : {}),
    }),
  );

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    stripe,
    sepay,
    apipay,
    nowpayments,
    vnpay,
    momo,
    zalopay,
    cryptomus,
    binance,
    bitpay,
    coinbaseCommerce,
    polar,
    paddle,
    creem,
    adminSecret: parsed.ADMIN_SECRET,
    refundWebhookTimeoutHours: parsed.PAYKIT_REFUND_WEBHOOK_TIMEOUT_HOURS,
    checkoutStaleTtlHours: parsed.PAYKIT_CHECKOUT_STALE_TTL_HOURS,
  };
}
