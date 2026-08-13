/**
 * Sweeping refunds whose confirmation webhook is overdue.
 *
 * A `pending_webhook` refund moves no money until the provider's webhook lands.
 * The happy path resolves in minutes; the runbook (docs/refund-flows.md) said
 * "manual reconcile after 24h" for the rest — which relied on a human
 * remembering to check. This sweeper is the reminder: it marks each overdue row
 * once, raises `paykit_refund_webhook_overdue_total`, and logs where the
 * runbook lives.
 *
 * What it deliberately does NOT do is resolve the refund. Whether the money
 * moved is a question only the provider can answer: flipping the status back
 * would un-reserve an amount the provider may still refund, and writing the
 * debit would move money on no evidence. The operator asks the provider and
 * settles it via `/admin/billing/ledger/adjust` — the sweeper's job is to make
 * sure that conversation happens.
 *
 * Runs from the background drains, same pattern as the inbox and screening
 * drains: several instances sweeping concurrently divide the work, because the
 * marking UPDATE is guarded.
 */
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import { markOverdueRefundWebhooks } from "@xeko-git-1/paykit-auth-core/db/repos/refund-overdue.repo.js";
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";

/**
 * 24 hours, matching the runbook's manual-reconcile threshold: every provider
 * that uses `pending_webhook` (NowPayments, BitPay) confirms well inside a day,
 * so a webhook older than that is missing, not slow.
 */
export const REFUND_WEBHOOK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface RefundWebhookOverdueSweeperDeps {
  readonly db: DbClient;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  readonly now?: () => Date;
}

export interface SweepOverdueRefundWebhooksOptions {
  /** How long a refund may wait on its webhook before it is reported. */
  readonly timeoutMs?: number;
  /** Rows marked per sweep — bounds how long one sweep can run. */
  readonly limit?: number;
}

/**
 * Mark every newly-overdue refund and report it. Returns the rows marked by
 * THIS sweep — a row is reported exactly once even with concurrent sweepers,
 * so the metric stays a counter an alert can fire on.
 */
export async function sweepOverdueRefundWebhooks(
  deps: RefundWebhookOverdueSweeperDeps,
  opts: SweepOverdueRefundWebhooksOptions = {},
): Promise<PaymentTransaction[]> {
  const now = deps.now?.() ?? new Date();
  const timeoutMs = opts.timeoutMs ?? REFUND_WEBHOOK_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - timeoutMs);

  const marked = await markOverdueRefundWebhooks(deps.db, {
    cutoff,
    now,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });

  for (const row of marked) {
    deps.emitMetric?.("paykit_refund_webhook_overdue_total", { provider: row.provider });
    deps.logger?.warn(
      "refund confirmation webhook is overdue — ask the provider and settle per docs/refund-flows.md",
      {
        transactionId: row.transactionId,
        provider: row.provider,
        amountMicros: row.amountMicros,
        currencyCode: row.currencyCode,
        pendingSince: row.updatedAt.toISOString(),
      },
    );
  }

  return marked;
}
