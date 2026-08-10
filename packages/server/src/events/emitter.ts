/**
 * Event emitter for paykit lifecycle hooks.
 * Fired AFTER DB transactions commit (never inside) — emitter throws are
 * isolated and do NOT roll back ledger writes.
 */
import type { PaymentTransaction } from "@xeko-git-1/paykit-auth-core/db/schema/payment-transactions.js";

export type PaykitEvent =
  | { readonly type: "payment.completed"; readonly transaction: PaymentTransaction }
  | { readonly type: "payment.failed"; readonly transaction: PaymentTransaction }
  | { readonly type: "payment.expired"; readonly transaction: PaymentTransaction }
  | {
      readonly type: "payment.refunded";
      readonly transaction: PaymentTransaction;
      readonly refundAmountMicros: string;
    };

export interface PaykitEventHandlers {
  readonly onPaymentCompleted?: (tx: PaymentTransaction) => void | Promise<void>;
  readonly onPaymentFailed?: (tx: PaymentTransaction) => void | Promise<void>;
  readonly onPaymentExpired?: (tx: PaymentTransaction) => void | Promise<void>;
  readonly onPaymentRefunded?: (
    tx: PaymentTransaction,
    refundAmountMicros: string,
  ) => void | Promise<void>;
}

export interface EventLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

const NOOP_LOGGER: EventLogger = { warn: () => {} };

export async function emitEvent(
  handlers: PaykitEventHandlers,
  event: PaykitEvent,
  logger: EventLogger = NOOP_LOGGER,
): Promise<void> {
  try {
    switch (event.type) {
      case "payment.completed":
        await handlers.onPaymentCompleted?.(event.transaction);
        break;
      case "payment.failed":
        await handlers.onPaymentFailed?.(event.transaction);
        break;
      case "payment.expired":
        await handlers.onPaymentExpired?.(event.transaction);
        break;
      case "payment.refunded":
        await handlers.onPaymentRefunded?.(event.transaction, event.refundAmountMicros);
        break;
    }
  } catch (err) {
    logger.warn("paykit event handler threw — swallowed (does not affect DB)", {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
