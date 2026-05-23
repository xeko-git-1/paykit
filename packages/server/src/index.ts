// Server barrel — db schema + repos. Phases 04-07 will add provider clients,
// routes, middleware. Phase 13 adds observability + secret rotation hooks.

export type { DbClient, DbOrTx, DbTransactionHandle } from "./db/client.js";

// Schema
export {
  type BalanceProjection,
  balanceProjections,
  type LedgerEntry,
  ledgerEntries,
  type NewBalanceProjection,
  type NewLedgerEntry,
  type NewPaymentTransaction,
  type NewReconciliationRun,
  type NewWebhookEvent,
  paykitSchema,
  paymentTransactions,
  type PaymentTransaction,
  reconciliationRuns,
  type ReconciliationRun,
  type WebhookEvent,
  webhookEvents,
} from "./db/schema/index.js";

// Repos
export * as balanceRepo from "./db/repos/balance.repo.js";
export * as ledgerRepo from "./db/repos/ledger.repo.js";
export * as paymentRepo from "./db/repos/payment.repo.js";
export * as reconciliationRepo from "./db/repos/reconciliation.repo.js";
export * as webhookEventRepo from "./db/repos/webhook-event.repo.js";

// Provider clients
export {
  createSePayClient,
  type SePayCheckoutResult,
  SePayClient,
  type SePayConfig,
  type SePayWebhookPayload,
  type CreateTopUpSessionInput,
  createStripeClient,
  type StripeCheckoutResult,
  StripeClient,
  type StripeConfig,
} from "./providers/index.js";

export const PAYKIT_SERVER_VERSION = "0.1.0-alpha.1";
