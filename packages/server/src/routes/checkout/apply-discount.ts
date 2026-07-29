/**
 * apply-discount — invokes the consumer's `DiscountResolver` hook safely.
 *
 * Race-safety contract:
 * - Resolver returns `{percent, code, sourceId, consume(tx)}` or `null`.
 * - Paykit validates `percent` BEFORE calling `consume(tx)`.
 * - Paykit calls `consume(tx)` INSIDE the checkout DB transaction.
 * - If `consume` returns `false` (race lost) → no discount applied.
 * - If resolver / consume throws → fall back to full price + warn log.
 *
 * Ordering and rollback are the whole point of this module:
 *
 * 1. `percent` is validated first. Validating after `consume` had already
 *    mutated the discount row would spend a redemption and then charge full
 *    price, leaving the customer's promo consumed for nothing.
 *
 * 2. `consume(tx)` runs inside a nested transaction, which Drizzle issues as a
 *    real SAVEPOINT. Without one, a `consume` that fails with a SQL error puts
 *    the whole transaction in the aborted state (Postgres rejects every later
 *    statement with SQLSTATE 25P02), so the "fall back to full price" path could
 *    not actually run — the checkout INSERT after it would fail too. The
 *    savepoint also undoes a partial mutation when `consume` fails *after*
 *    writing, so the fallback never charges full price on a spent reservation.
 */
import type {
  AppliedDiscount,
  CurrencyCode,
  DbTransaction,
  DiscountResolver,
} from "@vibecc/paykit";
import type { DbTransactionHandle } from "@vibecc/paykit-auth-core/db/client.js";
import { effectiveMicrosFor, validateDiscountPercent } from "./discount-percent.js";

export interface DiscountOutcome {
  readonly applied: boolean;
  readonly discount: AppliedDiscount | null;
  readonly originalMicros: bigint;
  readonly effectiveMicros: bigint;
  readonly reason?:
    | "no-resolver"
    | "resolver-null"
    | "consume-lost"
    | "resolver-threw"
    | "percent-out-of-range";
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

/** Full-price result, used for every path where no discount is applied. */
function fullPrice(amountMicros: bigint, reason: DiscountOutcome["reason"]): DiscountOutcome {
  return {
    applied: false,
    discount: null,
    originalMicros: amountMicros,
    effectiveMicros: amountMicros,
    reason,
  };
}

/** Internal signal — never escapes this module. */
class DiscountRaceLost extends Error {
  constructor() {
    super("discount consume lost the race");
    this.name = "DiscountRaceLost";
  }
}

/**
 * Run `consume(tx)` so that any failure leaves the surrounding transaction
 * usable and free of partial side effects.
 *
 * The handle is a Drizzle transaction; `tx.transaction()` on it emits a
 * SAVEPOINT, and the rollback on throw is what makes the caller's full-price
 * fallback both possible (transaction not poisoned) and correct (reservation
 * not half-applied). Re-throwing inside the nested callback is how Drizzle is
 * told to roll back to the savepoint; the outcome is carried out in `consumed`
 * so a `false` return is not conflated with a throw.
 */
async function consumeInSavepoint(
  discount: AppliedDiscount,
  tx: DbTransaction,
): Promise<{ ok: true; consumed: boolean } | { ok: false; error: unknown }> {
  const handle = tx as DbTransactionHandle;
  // A caller may hand us something that is not a Drizzle handle (unit tests pass
  // a plain object). Without savepoint support there is nothing to contain, so
  // call through directly and let the caller's error path deal with it.
  if (typeof handle?.transaction !== "function") {
    try {
      return { ok: true, consumed: await discount.consume(tx) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  let consumed = false;
  try {
    await handle.transaction(async (nested) => {
      consumed = await discount.consume(nested as DbTransaction);
      if (!consumed) {
        // Losing the race is not an error, but the savepoint must still be
        // discarded: consume may have written before deciding it lost.
        throw new DiscountRaceLost();
      }
    });
    return { ok: true, consumed: true };
  } catch (error) {
    if (error instanceof DiscountRaceLost) return { ok: true, consumed: false };
    return { ok: false, error };
  }
}

/**
 * Apply a discount inside an in-progress DB transaction: validate the percent,
 * then consume. Any failure falls back to full price with the transaction left
 * in a usable state.
 */
export async function applyDiscountInTx(opts: {
  discount: AppliedDiscount | null;
  tx: DbTransaction;
  amountMicros: bigint;
  logger?: DiscountLogger;
}): Promise<DiscountOutcome> {
  const { discount, tx, amountMicros, logger = NOOP_LOGGER } = opts;
  if (!discount) return fullPrice(amountMicros, "resolver-null");

  // Validate BEFORE consuming: an unusable percent must not spend a redemption.
  const valid = validateDiscountPercent(discount.percent);
  if (valid === null) {
    logger.warn(
      `discount percent out of range [0,100]: ${discount.percent} — full price applied, discount not consumed`,
      { code: discount.code, sourceId: discount.sourceId },
    );
    return fullPrice(amountMicros, "percent-out-of-range");
  }

  const result = await consumeInSavepoint(discount, tx);
  if (!result.ok) {
    logger.warn("discount consume() threw — full price applied", {
      code: discount.code,
      sourceId: discount.sourceId,
      error: result.error instanceof Error ? result.error.message : String(result.error),
    });
    return fullPrice(amountMicros, "resolver-threw");
  }
  if (!result.consumed) {
    logger.warn("discount consume() returned false — race lost, full price applied", {
      code: discount.code,
      sourceId: discount.sourceId,
    });
    return fullPrice(amountMicros, "consume-lost");
  }

  return {
    applied: true,
    discount,
    originalMicros: amountMicros,
    effectiveMicros: effectiveMicrosFor(amountMicros, valid),
  };
}
