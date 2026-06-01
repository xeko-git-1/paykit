/**
 * apply-discount — invokes the consumer's `DiscountResolver` hook safely.
 *
 * Race-safety contract:
 * - Resolver returns `{percent, code, sourceId, consume(tx)}` or `null`.
 * - Paykit calls `consume(tx)` INSIDE the checkout DB transaction.
 * - If `consume` returns `false` (race lost) → no discount applied.
 * - If resolver / consume throws → fall back to full price + warn log.
 */
import type {
  AppliedDiscount,
  CurrencyCode,
  DbTransaction,
  DiscountResolver,
} from "@vibecc/paykit";

export interface DiscountOutcome {
  readonly applied: boolean;
  readonly discount: AppliedDiscount | null;
  readonly originalMicros: bigint;
  readonly effectiveMicros: bigint;
  readonly reason?: "no-resolver" | "resolver-null" | "consume-lost" | "resolver-threw";
}

export interface DiscountLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

const NOOP_LOGGER: DiscountLogger = { warn: () => {} };

export async function resolveDiscount(opts: {
  resolver?: DiscountResolver;
  req: unknown;
  amountMicros: bigint;
  currencyCode: CurrencyCode;
  logger?: DiscountLogger;
}): Promise<{ discount: AppliedDiscount | null; reason?: DiscountOutcome["reason"] }> {
  const { resolver, req, amountMicros, currencyCode, logger = NOOP_LOGGER } = opts;
  if (!resolver) return { discount: null, reason: "no-resolver" };
  try {
    const discount = await resolver(req, amountMicros, currencyCode);
    if (discount === null) return { discount: null, reason: "resolver-null" };
    return { discount };
  } catch (err) {
    logger.warn("discountResolver threw — falling back to full price", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { discount: null, reason: "resolver-threw" };
  }
}

/**
 * Apply discount inside an in-progress DB transaction. Calls `consume(tx)`;
 * if it returns `false` (race lost) or throws, falls back to full price.
 */
export async function applyDiscountInTx(opts: {
  discount: AppliedDiscount | null;
  tx: DbTransaction;
  amountMicros: bigint;
  logger?: DiscountLogger;
}): Promise<DiscountOutcome> {
  const { discount, tx, amountMicros, logger = NOOP_LOGGER } = opts;
  if (!discount) {
    return {
      applied: false,
      discount: null,
      originalMicros: amountMicros,
      effectiveMicros: amountMicros,
      reason: "resolver-null",
    };
  }
  try {
    const consumed = await discount.consume(tx);
    if (!consumed) {
      logger.warn("discount consume() returned false — race lost, full price applied", {
        code: discount.code,
        sourceId: discount.sourceId,
      });
      return {
        applied: false,
        discount: null,
        originalMicros: amountMicros,
        effectiveMicros: amountMicros,
        reason: "consume-lost",
      };
    }
  } catch (err) {
    logger.warn("discount consume() threw — full price applied", {
      code: discount.code,
      sourceId: discount.sourceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      applied: false,
      discount: null,
      originalMicros: amountMicros,
      effectiveMicros: amountMicros,
      reason: "resolver-threw",
    };
  }
  // Success: compute effective amount.
  const pct = discount.percent;
  // NaN must be rejected explicitly: NaN < 0 and NaN > 100 are both false, so a
  // bare range check lets it through to BigInt(10000 - NaN), which throws.
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    logger.warn(`discount percent out of range [0,100]: ${pct} — full price applied`);
    return {
      applied: false,
      discount: null,
      originalMicros: amountMicros,
      effectiveMicros: amountMicros,
    };
  }
  // Percentage in basis points keeps fractional discounts exact: rounding the
  // percent itself would turn 12.5% into 13% and 0.4% into 0%, charging the
  // wrong amount. bps ∈ [0, 10000]; the +5000n rounds the result to the nearest micro.
  const bps = Math.round(pct * 100);
  const effective = (amountMicros * BigInt(10000 - bps) + 5000n) / 10000n;
  return {
    applied: true,
    discount,
    originalMicros: amountMicros,
    effectiveMicros: effective,
  };
}
