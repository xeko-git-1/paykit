/**
 * Service configuration — zod-validated env parsing with fail-fast semantics.
 *
 * JWT signing secret is NOT read from env. It lives in the runtime_config
 * table and is loaded/seeded at service start by createJwtSecretLoader
 * (see @xeko-git-1/paykit-server jwt-middleware).
 */
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
  readonly adminSecret: string | undefined;
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
function resolveProviderCreds<T>(
  providerName: string,
  required: Record<string, string | undefined>,
  build: () => T,
): T | undefined {
  const present = Object.entries(required)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k]) => k);
  if (present.length === 0) return undefined;

  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined || v === "")
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete ${providerName} configuration: set [${present.join(", ")}] ` +
        `but missing [${missing.join(", ")}]. Provide all required vars or none.`,
    );
  }
  return build();
}

export function parseServiceConfig(env: Record<string, string | undefined>): ServiceConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Redact: only show field names, never values
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Service config validation failed: ${fields}`);
  }

  const parsed = result.data;

  const stripe = resolveProviderCreds(
    "Stripe",
    {
      STRIPE_SECRET_KEY: parsed.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: parsed.STRIPE_WEBHOOK_SECRET,
    },
    () => ({
      secretKey: parsed.STRIPE_SECRET_KEY!,
      webhookSecret: parsed.STRIPE_WEBHOOK_SECRET!,
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
    () => ({
      apiKey: parsed.SEPAY_API_KEY!,
      secretKey: parsed.SEPAY_SECRET_KEY!,
      accountNumber: parsed.SEPAY_ACCOUNT_NUMBER!,
      accountName: parsed.SEPAY_ACCOUNT_NAME!,
      bankBin: parsed.SEPAY_BANK_BIN!,
    }),
  );

  const nowpayments = resolveProviderCreds(
    "NOWPayments",
    {
      NOWPAYMENTS_API_KEY: parsed.NOWPAYMENTS_API_KEY,
      NOWPAYMENTS_IPN_SECRET: parsed.NOWPAYMENTS_IPN_SECRET,
    },
    () => ({
      apiKey: parsed.NOWPAYMENTS_API_KEY!,
      ipnSecret: parsed.NOWPAYMENTS_IPN_SECRET!,
      environment: parsed.NOWPAYMENTS_ENVIRONMENT ?? ("production" as const),
      // Optional. Leave unset so the customer picks any USDT chain (BEP20/TRC20/
      // ERC20/…) on the NowPayments page; set to force one chain, e.g.
      // 'usdtbsc' (BEP20), 'usdttrc20', 'usdterc20', 'usdtmatic'.
      ...(parsed.NOWPAYMENTS_PAY_CURRENCY !== undefined &&
      parsed.NOWPAYMENTS_PAY_CURRENCY !== ""
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
    () => ({
      tmnCode: parsed.VNPAY_TMN_CODE!,
      hashSecret: parsed.VNPAY_HASH_SECRET!,
      returnUrl: parsed.VNPAY_RETURN_URL!,
      ipnUrl: parsed.VNPAY_IPN_URL!,
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
    () => ({
      partnerCode: parsed.MOMO_PARTNER_CODE!,
      accessKey: parsed.MOMO_ACCESS_KEY!,
      secretKey: parsed.MOMO_SECRET_KEY!,
      returnUrl: parsed.MOMO_RETURN_URL!,
      ipnUrl: parsed.MOMO_IPN_URL!,
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
    () => ({
      appId: parsed.ZALOPAY_APP_ID!,
      key1: parsed.ZALOPAY_KEY1!,
      key2: parsed.ZALOPAY_KEY2!,
      returnUrl: parsed.ZALOPAY_RETURN_URL!,
      callbackUrl: parsed.ZALOPAY_CALLBACK_URL!,
      environment: parsed.ZALOPAY_ENVIRONMENT ?? ("sandbox" as const),
    }),
  );

  const cryptomus = resolveProviderCreds(
    "Cryptomus",
    {
      CRYPTOMUS_MERCHANT_ID: parsed.CRYPTOMUS_MERCHANT_ID,
      CRYPTOMUS_PAYMENT_API_KEY: parsed.CRYPTOMUS_PAYMENT_API_KEY,
    },
    () => ({
      merchantId: parsed.CRYPTOMUS_MERCHANT_ID!,
      paymentApiKey: parsed.CRYPTOMUS_PAYMENT_API_KEY!,
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
    () => ({
      apiKey: parsed.BINANCE_API_KEY!,
      apiSecret: parsed.BINANCE_API_SECRET!,
      webhookPublicKey: parsed.BINANCE_WEBHOOK_PUBLIC_KEY!,
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

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    stripe,
    sepay,
    nowpayments,
    vnpay,
    momo,
    zalopay,
    cryptomus,
    binance,
    adminSecret: parsed.ADMIN_SECRET,
  };
}
