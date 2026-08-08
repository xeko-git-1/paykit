/**
 * Draining the webhook inbox — the retry side of the two-transaction pipeline.
 *
 * The request path processes a delivery once, immediately. This is what happens for
 * every delivery that did not succeed then: the one whose checkout had not yet
 * committed its provider reference, the one whose processing threw, the one whose
 * worker died mid-attempt and left a lease to expire. Without something running
 * this, `unmatched` would be a state deliveries entered and never left — which is
 * the original bug wearing a better label.
 *
 * Designed to be invoked from a cron, not to be a daemon: each call claims what is
 * due, processes it, and returns. Two instances running it concurrently is safe and
 * expected — the claim is a guarded UPDATE, so they divide the work rather than
 * duplicating it.
 */
import {
  claimNextDelivery,
  sweepInboxPayloads,
} from "@vibecc/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import {
  type DeliveryProcessorDeps,
  type DeliveryResult,
  processDelivery,
} from "./webhook-delivery-processor.js";
import { INBOX_LEASE_MS, INBOX_PAYLOAD_RETENTION_DAYS } from "./webhook-inbox-policy.js";

export interface InboxRunnerDeps extends DeliveryProcessorDeps {
  /** Restrict the drain to one provider — useful for isolating a noisy one. */
  readonly provider?: string;
}

/**
 * Claim and process one due delivery.
 *
 * `undefined` means nothing was due, which is the normal steady state and not a
 * condition worth logging.
 */
export async function processNextDelivery(
  deps: InboxRunnerDeps,
): Promise<DeliveryResult | undefined> {
  const claimed = await claimNextDelivery(deps.db, {
    leaseMs: INBOX_LEASE_MS,
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    ...(deps.now !== undefined ? { now: deps.now() } : {}),
  });
  if (claimed === undefined) return undefined;
  return processDelivery(deps, claimed);
}

/**
 * Process due deliveries until there are none left or `maxDeliveries` is reached.
 *
 * The bound exists so one invocation cannot run unboundedly: a backlog of thousands
 * should be worked through over several scheduled runs rather than in a single call
 * that holds a connection for minutes and cannot be observed while it does.
 *
 * A delivery that threw its way out of `processDelivery` would stop the drain, so it
 * does not: the processor converts every failure into a recorded state. This loop
 * therefore stops only when the queue is empty or the bound is reached.
 */
export async function drainWebhookInbox(
  deps: InboxRunnerDeps,
  maxDeliveries = 50,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (let i = 0; i < maxDeliveries; i++) {
    const result = await processNextDelivery(deps);
    if (result === undefined) break;
    results.push(result);
  }
  return results;
}

/**
 * Drop stored bodies for deliveries settled longer ago than the retention window.
 *
 * Run on the same schedule as the drain. Two reasons it exists: `raw_payload` is the
 * bulk of the table's size, and it is the part with any chance of holding something
 * sensitive despite redaction. The rows stay — the dedup key and the audit trail are
 * what must last.
 */
export async function sweepWebhookInbox(
  deps: Pick<InboxRunnerDeps, "db" | "now">,
  opts: { retentionDays?: number; limit?: number } = {},
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const retentionDays = opts.retentionDays ?? INBOX_PAYLOAD_RETENTION_DAYS;
  const before = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return sweepInboxPayloads(deps.db, {
    before,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
}
