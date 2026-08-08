/**
 * webhook-inbox.repo — record a webhook delivery, then claim and resolve it.
 *
 * The whole point of this repo is that receiving and processing are two separate
 * facts. `recordDelivery` commits on its own, before any business work, so a
 * delivery can never be lost by a later decision. Every mutation after that is a
 * single guarded UPDATE whose precondition sits in the WHERE clause, so no step is
 * a check-then-act race: under READ COMMITTED, Postgres re-evaluates the guard
 * against the committed row after taking the row lock, and two workers racing the
 * same row produce one winner and one no-op.
 *
 * What it deliberately does NOT do: mark anything processed from inside the
 * business transaction. The caller commits its work first, then reports the
 * outcome here. That ordering is why an early return can no longer masquerade as
 * success.
 *
 * Split by lifecycle stage — receive, claim, resolve, read — because that is the
 * order a reader follows a delivery through, and each stage's guards only make
 * sense next to the others in the same stage:
 */
export { claimDeliveryById, claimNextDelivery } from "./webhook-inbox-claim.repo.js";
export {
  markDeliveryDeadLettered,
  markDeliveryFailed,
  markDeliveryProcessed,
  markDeliveryUnmatched,
  requeueDeadLetteredDelivery,
} from "./webhook-inbox-outcome.repo.js";
export {
  countDeliveriesByState,
  findDeliveryByEvent,
  findDeliveryById,
  type InboxDeliverySummary,
  listDeliveriesByState,
  sweepInboxPayloads,
} from "./webhook-inbox-query.repo.js";
export {
  type RecordDeliveryInput,
  type RecordDeliveryResult,
  recordDelivery,
} from "./webhook-inbox-record.repo.js";
