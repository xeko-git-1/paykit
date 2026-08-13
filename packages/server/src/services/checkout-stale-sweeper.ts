/**
 * Sweeping checkouts the customer abandoned.
 *
 * A checkout nobody pays stays `awaiting_payment` (or `provider_creating`, or
 * historical `pending`) until the provider says otherwise — and some rails
 * never send an expiry webhook. The row is harmless; the discount reservation
 * it may hold is not: reservations count against the promo cap, so abandoned
 * checkouts silently eat the discount budget until something releases them.
 * This sweeper is that something.
 *
 * Each expired row releases its reservation IN THE SAME TRANSACTION as the
 * status flip — the two must not be separable, or a crash between them leaks
 * the reservation permanently (there is no later path that comes back for it).
 *
 * The race with a slow payment is resolved by the guarded UPDATE in the repo:
 * whichever transaction moves the row first wins, and a `completed` webhook
 * landing on an already-expired row deliberately does not credit (same as a
 * provider-side expiry). That makes the TTL a money-relevant setting: it must
 * exceed the longest provider checkout validity. 48 hours clears every
 * supported rail's session lifetime with a day to spare.
 *
 * Runs from the background drains, same pattern as the inbox and refund
 * sweepers: guarded UPDATEs make concurrent instances divide the work.
 */
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { expireStaleCheckouts } from "@xeko-git-1/paykit-auth-core/db/repos/checkout-stale.repo.js";
import { releaseReservation } from "@xeko-git-1/paykit-auth-core/db/repos/discount.repo.js";
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";

/**
 * 48 hours: longer than any supported provider keeps a checkout session alive
 * (card sessions expire in hours; crypto invoices in minutes; VietQR bank
 * transfers have no session but are paid same-day in practice). Expiring
 * earlier than the provider would risks refusing credit for a payment the
 * provider still considers collectable.
 */
export const CHECKOUT_STALE_TTL_MS = 48 * 60 * 60 * 1000;

export interface CheckoutStaleSweeperDeps {
  readonly db: DbClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  readonly now?: () => Date;
}

export interface SweepStaleCheckoutsOptions {
  /** How long an unpaid checkout may exist before it is expired. */
  readonly ttlMs?: number;
  /** Rows expired per sweep — bounds how long one sweep can run. */
  readonly limit?: number;
}

/**
 * Expire every checkout past the TTL and release its discount reservation.
 * Returns the rows expired by THIS sweep.
 */
export async function sweepStaleCheckouts(
  deps: CheckoutStaleSweeperDeps,
  opts: SweepStaleCheckoutsOptions = {},
): Promise<PaymentTransaction[]> {
  const now = deps.now?.() ?? new Date();
  const ttlMs = opts.ttlMs ?? CHECKOUT_STALE_TTL_MS;
  const cutoff = new Date(now.getTime() - ttlMs);

  // One transaction for the batch: the status flip and the reservation release
  // must commit together, or a crash in between leaks reserved discount slots
  // with nothing that ever comes back for them.
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await expireStaleCheckouts(tx, {
      cutoff,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    for (const row of rows) {
      const discountId = discountIdFrom(row.metadataJson);
      if (discountId !== null) await releaseReservation(tx, discountId);
    }
    return rows;
  });

  for (const row of expired) {
    deps.emitMetric?.("paykit_checkout_stale_expired_total", { provider: row.provider });
    deps.logger?.warn("stale checkout expired — customer never paid", {
      transactionId: row.transactionId,
      provider: row.provider,
      amountMicros: row.amountMicros,
      currencyCode: row.currencyCode,
      createdAt: row.createdAt.toISOString(),
    });
  }

  return expired;
}

/** Same extraction the webhook processor uses — metadataJson.discountId is set
 * only by the v1 checkout when a promo code was reserved. */
function discountIdFrom(metadataJson: unknown): string | null {
  if (typeof metadataJson !== "object" || metadataJson === null) return null;
  const id = (metadataJson as Record<string, unknown>).discountId;
  return typeof id === "string" ? id : null;
}
