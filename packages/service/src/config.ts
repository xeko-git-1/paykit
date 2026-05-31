/**
 * Service configuration — zod-validated env parsing with fail-fast semantics.
 *
 * JWT signing secret is NOT read from env. It lives in the runtime_config
 * table and is bootstrapped at service start (generate+seed if absent,
 * fail if present but too short).
 */
import { randomBytes } from "node:crypto";
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

  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    stripe,
    sepay,
    nowpayments,
    adminSecret: parsed.ADMIN_SECRET,
  };
}

// ---------------------------------------------------------------------------
// JWT secret bootstrap — reads/seeds from runtime_config, NOT from env
// ---------------------------------------------------------------------------

const MIN_SECRET_BYTES = 32;

export interface BootstrapJwtDeps {
  readonly getKey: (db: unknown, key: string) => Promise<{ value: string } | undefined>;
  readonly setKey: (
    db: unknown,
    input: { key: string; value: string; expiresAt?: Date | null },
  ) => Promise<{ value: string }>;
  readonly db: unknown;
}

/**
 * Bootstrap JWT signing secret from runtime_config table.
 * - If absent: generate cryptographically random >= 32 bytes and seed.
 * - If present but < 32 bytes: fail-fast (rotation needed).
 * - If present and valid: return it.
 */
export async function bootstrapJwtSecret(deps: BootstrapJwtDeps): Promise<string> {
  const configKey = "jwt_signing_secret";
  const row = await deps.getKey(deps.db, configKey);

  if (row) {
    if (Buffer.byteLength(row.value, "utf8") < MIN_SECRET_BYTES) {
      throw new Error(
        `JWT secret in runtime_config is too short (< ${MIN_SECRET_BYTES} bytes). Rotate to a longer secret before starting the service.`,
      );
    }
    return row.value;
  }

  // Generate and seed a new secret
  const newSecret = randomBytes(48).toString("base64url"); // 48 bytes → 64 chars
  const result = await deps.setKey(deps.db, {
    key: configKey,
    value: newSecret,
    expiresAt: null,
  });
  return result.value;
}
