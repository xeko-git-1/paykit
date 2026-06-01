/**
 * Service configuration — zod-validated env parsing with fail-fast semantics.
 *
 * JWT signing secret is NOT read from env. It lives in the runtime_config
 * table and is loaded/seeded at service start by createJwtSecretLoader
 * (see @vibecc/paykit-server jwt-middleware).
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
  readonly adminSecret: string | undefined;
}

/**
 * Parse and validate env vars. Throws on missing critical config.
 * Never echoes secret values in error messages.
 */
export function parseServiceConfig(env: Record<string, string | undefined>): ServiceConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Redact: only show field names, never values
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Service config validation failed: ${fields}`);
  }

  const parsed = result.data;

  const stripe =
    parsed.STRIPE_SECRET_KEY && parsed.STRIPE_WEBHOOK_SECRET
      ? {
          secretKey: parsed.STRIPE_SECRET_KEY,
          webhookSecret: parsed.STRIPE_WEBHOOK_SECRET,
          successUrl: parsed.STRIPE_SUCCESS_URL ?? "http://localhost:3000/success",
          cancelUrl: parsed.STRIPE_CANCEL_URL ?? "http://localhost:3000/cancel",
        }
      : undefined;

  const sepay =
    parsed.SEPAY_API_KEY &&
    parsed.SEPAY_SECRET_KEY &&
    parsed.SEPAY_ACCOUNT_NUMBER &&
    parsed.SEPAY_ACCOUNT_NAME &&
    parsed.SEPAY_BANK_BIN
      ? {
          apiKey: parsed.SEPAY_API_KEY,
          secretKey: parsed.SEPAY_SECRET_KEY,
          accountNumber: parsed.SEPAY_ACCOUNT_NUMBER,
          accountName: parsed.SEPAY_ACCOUNT_NAME,
          bankBin: parsed.SEPAY_BANK_BIN,
        }
      : undefined;

  const nowpayments =
    parsed.NOWPAYMENTS_API_KEY && parsed.NOWPAYMENTS_IPN_SECRET
      ? {
          apiKey: parsed.NOWPAYMENTS_API_KEY,
          ipnSecret: parsed.NOWPAYMENTS_IPN_SECRET,
          environment: parsed.NOWPAYMENTS_ENVIRONMENT ?? ("production" as const),
        }
      : undefined;

  const vnpay =
    parsed.VNPAY_TMN_CODE &&
    parsed.VNPAY_HASH_SECRET &&
    parsed.VNPAY_RETURN_URL &&
    parsed.VNPAY_IPN_URL
      ? {
          tmnCode: parsed.VNPAY_TMN_CODE,
          hashSecret: parsed.VNPAY_HASH_SECRET,
          returnUrl: parsed.VNPAY_RETURN_URL,
          ipnUrl: parsed.VNPAY_IPN_URL,
          environment: parsed.VNPAY_ENVIRONMENT ?? ("sandbox" as const),
        }
      : undefined;

  const momo =
    parsed.MOMO_PARTNER_CODE &&
    parsed.MOMO_ACCESS_KEY &&
    parsed.MOMO_SECRET_KEY &&
    parsed.MOMO_RETURN_URL &&
    parsed.MOMO_IPN_URL
      ? {
          partnerCode: parsed.MOMO_PARTNER_CODE,
          accessKey: parsed.MOMO_ACCESS_KEY,
          secretKey: parsed.MOMO_SECRET_KEY,
          returnUrl: parsed.MOMO_RETURN_URL,
          ipnUrl: parsed.MOMO_IPN_URL,
          environment: parsed.MOMO_ENVIRONMENT ?? ("sandbox" as const),
        }
      : undefined;

  const zalopay =
    parsed.ZALOPAY_APP_ID &&
    parsed.ZALOPAY_KEY1 &&
    parsed.ZALOPAY_KEY2 &&
    parsed.ZALOPAY_RETURN_URL &&
    parsed.ZALOPAY_CALLBACK_URL
      ? {
          appId: parsed.ZALOPAY_APP_ID,
          key1: parsed.ZALOPAY_KEY1,
          key2: parsed.ZALOPAY_KEY2,
          returnUrl: parsed.ZALOPAY_RETURN_URL,
          callbackUrl: parsed.ZALOPAY_CALLBACK_URL,
          environment: parsed.ZALOPAY_ENVIRONMENT ?? ("sandbox" as const),
        }
      : undefined;

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    stripe,
    sepay,
    nowpayments,
    vnpay,
    momo,
    zalopay,
    adminSecret: parsed.ADMIN_SECRET,
  };
}
