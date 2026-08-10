/**
 * The two verdict transactions: credit a cleared payment, or quarantine a
 * blocked one. Both move the payment out of `screening_pending` and close the
 * screening job in the SAME transaction as the money move.
 *
 * Why one transaction per verdict rather than two steps: the status transition is
 * the exactly-once gate. Both writes are guarded on the payment still being
 * `screening_pending`, so a duplicated verdict (lease expired and a replacement
 * worker also got an answer, or a provider redelivery) finds zero rows on the
 * second attempt and does nothing. If the credit and the transition were separate
 * transactions, a crash between them would leave a credited payment that still
 * looks pending — and the next attempt would credit it again. The ledger's
 * UNIQUE (provider, source_id, entry_type) would catch the duplicate ledger row,
 * but relying on that alone leaves the balance projection to guesswork.
 *
 * No external call may appear in either function. That is the invariant this
 * module exists to hold.
 */
import { parseMicros } from "@xeko-git-1/paykit";
import type { DbClient, DbOrTx } from "@xeko-git-1/paykit-auth-core/db/client.js";
import type { LedgerEntry } from "@xeko-git-1/paykit-auth-core/db/schema/ledger-entries.js";
import { paymentTransactions } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";
import type {
  ScreeningDecidedState,
  ScreeningJob,
  ScreeningJobState,
} from "@xeko-git-1/paykit-auth-core/db/schema/screening-jobs.js";
import { and, eq } from "drizzle-orm";

/**
 * Move a payment out of `screening_pending`, but only if it is still there.
 *
 * The `status` predicate is the fence. Returns the row when this caller won the
 * transition and `undefined` when someone already moved it, which the callers use
 * to decide whether to perform the money move at all. `metadataJson` comes back
 * with it so a discount reservation can be resolved without a second read.
 */
async function transitionOutOfScreening(
  tx: DbOrTx,
  transactionId: string,
  status: "completed" | "quarantine",
  now: Date,
): Promise<{ metadataJson: unknown } | undefined> {
  const [row] = await tx
    .update(paymentTransactions)
    .set({ status, updatedAt: now })
    .where(
      and(
        eq(paymentTransactions.transactionId, transactionId),
        eq(paymentTransactions.status, "screening_pending"),
      ),
    )
    .returning({ metadataJson: paymentTransactions.metadataJson });
  return row;
}

/**
 * A discount reservation held by a checkout is resolved here rather than in the
 * webhook: the webhook parks the payment before the verdict is known, so the slot
 * stays reserved until the payment actually resolves. Releasing it on quarantine
 * matters — a quarantined payment never completes, and a reservation that is never
 * released permanently shrinks the promo's cap.
 *
 * Only the service checkout stamps a `discountId`; embedded BYO-resolver checkouts
 * never do, making this a no-op there.
 */
function discountIdFrom(metadataJson: unknown): string | null {
  if (typeof metadataJson !== "object" || metadataJson === null) return null;
  const id = (metadataJson as Record<string, unknown>).discountId;
  return typeof id === "string" ? id : null;
}

/** Reservation mutators, injected so this module stays free of repo coupling. */
export interface DiscountReservationDeps {
  readonly commitReservation: (tx: DbOrTx, discountId: string) => Promise<boolean>;
  readonly releaseReservation: (tx: DbOrTx, discountId: string) => Promise<boolean>;
}

export interface MarkDecidedDep {
  readonly markScreeningDecided: (
    tx: DbOrTx,
    opts: { jobId: string; state: ScreeningDecidedState; reason?: string; now?: Date },
  ) => Promise<ScreeningJob | undefined>;
}

export interface CreditScreenedPaymentDeps extends MarkDecidedDep, DiscountReservationDeps {
  readonly appendLedgerEntryIdempotent: (
    tx: DbOrTx,
    data: {
      tenantId: string;
      ownerId: string;
      entryType: "credit";
      amountMicros: string;
      currencyCode: string;
      provider: string;
      sourceId: string;
      metadataJson?: Record<string, unknown>;
    },
  ) => Promise<{ row: LedgerEntry; inserted: boolean }>;
  readonly applyDelta: (
    tx: DbOrTx,
    tenantId: string,
    currencyCode: string,
    deltaMicros: bigint,
  ) => Promise<unknown>;
  readonly now: Date;
}

/** Outcome of a verdict transaction, so a caller can tell a no-op from a move. */
export interface VerdictApplied {
  readonly applied: boolean;
}

/**
 * Credit a payment whose screening came back clear.
 *
 * The credited amount is the one frozen on the job at webhook time, not a
 * re-derivation: the settlement comparison already decided it (an overpaid
 * transfer credits the requested amount, not the received one), so recomputing it
 * here could reach a different answer.
 */
export async function creditScreenedPayment(
  db: DbClient,
  job: ScreeningJob,
  deps: CreditScreenedPaymentDeps,
): Promise<VerdictApplied> {
  return db.transaction(async (tx) => {
    const won = await transitionOutOfScreening(tx, job.transactionId, "completed", deps.now);
    if (won === undefined) {
      // Already decided by another attempt. Not an error, and crucially not a
      // reason to credit a second time.
      return { applied: false };
    }

    const { inserted } = await deps.appendLedgerEntryIdempotent(tx, {
      tenantId: job.tenantId,
      ownerId: job.ownerId,
      entryType: "credit",
      amountMicros: job.creditMicros,
      currencyCode: job.currencyCode,
      provider: job.provider,
      sourceId: job.sourceId,
      metadataJson: {
        source: "payment",
        provider: job.provider,
        transactionId: job.transactionId,
        screened: true,
      },
    });
    // The projection moves only when the ledger row is new: the ledger is the
    // source of truth, and its unique index is what makes a redelivered credit a
    // no-op rather than a duplicate balance move.
    if (inserted) {
      await deps.applyDelta(tx, job.tenantId, job.currencyCode, parseMicros(job.creditMicros));
    }

    const discountId = discountIdFrom(won.metadataJson);
    if (discountId !== null) await deps.commitReservation(tx, discountId);

    await deps.markScreeningDecided(tx, {
      jobId: job.jobId,
      state: "cleared",
      now: deps.now,
    });
    return { applied: true };
  });
}

export interface QuarantineScreenedPaymentDeps extends MarkDecidedDep, DiscountReservationDeps {
  readonly state: Extract<ScreeningJobState, "rejected" | "manual_review">;
  readonly reason: string;
  readonly now: Date;
}

/**
 * Quarantine a payment that screening blocked or could not clear.
 *
 * The ledger is deliberately untouched: a quarantined payment has money at the
 * provider and none in the wallet, which is the intended outcome. The job row
 * carries the reason and the decision time — the audit trail a reviewer needs to
 * later release or refund it by hand.
 */
export async function quarantineScreenedPayment(
  db: DbClient,
  job: ScreeningJob,
  deps: QuarantineScreenedPaymentDeps,
): Promise<VerdictApplied> {
  return db.transaction(async (tx) => {
    const won = await transitionOutOfScreening(tx, job.transactionId, "quarantine", deps.now);
    if (won === undefined) return { applied: false };

    // Quarantine is terminal, so the promo slot goes back to the pool.
    const discountId = discountIdFrom(won.metadataJson);
    if (discountId !== null) await deps.releaseReservation(tx, discountId);

    await deps.markScreeningDecided(tx, {
      jobId: job.jobId,
      state: deps.state,
      reason: deps.reason,
      now: deps.now,
    });
    return { applied: true };
  });
}
