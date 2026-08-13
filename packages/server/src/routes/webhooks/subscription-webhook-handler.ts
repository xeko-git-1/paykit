/**
 * Subscription webhook handler — transport only, backed by the durable inbox.
 *
 * Mounted at POST /webhooks/{adapter.id} per registered SubscriptionAdapter
 * instance. Each instance verifies against its own webhook secret pool — no
 * cross-instance secret bleed.
 *
 * The pipeline mirrors the payment webhook router:
 *
 *   1. `adapter.verifyWebhookSignature` → 401 when it fails (nothing stored).
 *   2. `adapter.parseSubscriptionEvent` → null/throw means "not ours", ACK and
 *      stop. Nothing unauthenticated or unparseable reaches the inbox.
 *   3. Record the delivery in the inbox with kind 'subscription'. THIS COMMITS
 *      ON ITS OWN — from here the delivery cannot be lost.
 *   4. Claim it and process it — the business transaction, which also marks it
 *      processed.
 *
 * The previous handler inserted a dedup row as the first statement of the
 * business transaction and answered 409 when an `invoice.paid` arrived before
 * its subscription row, gambling that the provider's retry policy would outlast
 * the race. Now that delivery is durable, parked `unmatched`, and retried by the
 * same drain that retries payment webhooks — the response is always 2xx because
 * the retry is owned here, not by the provider.
 */
import type { NormalizedSubscriptionEvent, SubscriptionAdapter } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import {
  claimDeliveryById,
  recordDelivery,
} from "@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  type SubscriptionDeliveryResult,
  processSubscriptionDelivery,
} from "../../services/subscription-delivery-processor.js";
import { INBOX_LEASE_MS } from "../../services/webhook-inbox-policy.js";
import { hashRawBody, redactRawBody } from "../../services/webhook-payload-storage.js";
import { errorJson } from "../shared/response.js";

export interface SubscriptionWebhookHandlerDeps {
  readonly db: DbClient;
  readonly adapter: SubscriptionAdapter;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  readonly onLedgerSkipped?: (reason: string, payload: Record<string, unknown>) => void;
  /** Optional metrics counter emitter — default no-op. */
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  /** Extra redaction patterns for stored payloads, from `observability.redact`. */
  readonly redactPatterns?: readonly RegExp[];
}

export function buildSubscriptionWebhookHandler(deps: SubscriptionWebhookHandlerDeps): Hono {
  const app = new Hono();
  app.post(`/${deps.adapter.id}`, async (c) => handle(c, deps));
  return app;
}

async function handle(c: Context, deps: SubscriptionWebhookHandlerDeps): Promise<Response> {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  if (!deps.adapter.verifyWebhookSignature(rawBody, headers)) {
    return errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature");
  }

  let event: NormalizedSubscriptionEvent | null;
  try {
    event = deps.adapter.parseSubscriptionEvent(rawBody, headers);
  } catch (err) {
    deps.logger?.warn("parseSubscriptionEvent threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ received: true, skipped: "parse_error" });
  }
  if (!event) {
    deps.logger?.warn("WEBHOOK_EVENT_UNHANDLED", { provider: deps.adapter.id });
    return c.json({ received: true, skipped: "unhandled" });
  }
  const evt = event;

  // Record first, in its own transaction. From here on the delivery cannot be
  // lost: whatever happens next, the payload and its state are durable.
  const recorded = await recordDelivery(deps.db, {
    provider: deps.adapter.id,
    eventId: evt.eventId,
    eventType: evt.type,
    payloadHash: hashRawBody(rawBody),
    rawPayload: redactRawBody(rawBody, deps.redactPatterns),
    normalizedPayload: { ...evt },
    // customer.deleted carries no subscription id; the customer id is the only
    // reference an operator could search by.
    providerRef: evt.subscriptionId !== "" ? evt.subscriptionId : evt.customerId,
    inboxKind: "subscription",
  });

  if (recorded.payloadMismatch) {
    deps.logger?.warn("webhook payload differs from the body already stored for this event id", {
      provider: deps.adapter.id,
      eventId: evt.eventId,
    });
    deps.emitMetric?.("paykit_webhook_payload_mismatch_total", { provider: deps.adapter.id });
  }

  // Claim the row we just recorded. Losing this claim is not an error: a
  // background worker holds the delivery, and it will be processed there.
  const claimed = await claimDeliveryById(deps.db, {
    inboxId: recorded.row.inboxId,
    leaseMs: INBOX_LEASE_MS,
  });
  if (claimed === undefined) {
    return c.json({ received: true, deferred: stateOf(recorded.row.state) });
  }

  const result = await processSubscriptionDelivery(
    {
      db: deps.db,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
      ...(deps.onLedgerSkipped !== undefined ? { onLedgerSkipped: deps.onLedgerSkipped } : {}),
    },
    claimed,
  );

  return c.json(responseFor(result));
}

/**
 * What the caller is told, per outcome. Always 2xx: retryable outcomes are
 * durable and owned by the retry worker, so asking the provider to redeliver
 * would add a second copy of work that is already scheduled.
 */
function responseFor(result: SubscriptionDeliveryResult): Record<string, unknown> {
  switch (result.kind) {
    case "processed":
      return { received: true };
    case "unmatched":
      return { received: true, pending: "awaiting_subscription" };
    case "failed":
      return { received: true, pending: "retry_scheduled" };
    case "dead_letter":
      return { received: true, pending: "dead_letter" };
  }
}

function stateOf(state: string): string {
  return state === "processed" ? "already_processed" : "processing";
}
