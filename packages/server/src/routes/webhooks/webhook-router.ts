/**
 * Generic webhook router — mounts POST `/{adapterId}` for every registered adapter.
 *
 * The pipeline is transport only. It authenticates the delivery, records it
 * durably, and then hands it to the shared processor:
 *
 *   1. Read the raw body.
 *   2. `adapter.verifyWebhookSignature` → 401 when it fails.
 *   3. `adapter.parseWebhookPayload` → null means "not ours", ACK and stop.
 *   4. Record the delivery in the inbox. THIS COMMITS ON ITS OWN.
 *   5. Claim it and process it — a second transaction, which is also the one that
 *      marks it processed.
 *
 * Step 4 committing separately is the whole point. The previous design inserted a
 * dedup row as the first statement of the business transaction, which made one row
 * mean two different things: "seen" and "done". Every business-reason early return
 * inside that transaction — most importantly "no payment carries this provider
 * reference yet" — still committed the dedup row, answered 200, and made the
 * delivery permanently unrepeatable. A customer could pay and be credited nothing,
 * with no log, no metric and no way to replay.
 *
 * Now receipt and completion are separate facts. A delivery that cannot be matched
 * becomes retryable work with its payload kept, and the response says so.
 */
import type {
  NormalizedWebhookEvent,
  PaymentProviderAdapter,
  ProviderRegistry,
  ScreeningService,
} from "@xeko-git-1/paykit";
import { screeningServiceFromOnBeforeCredit } from "@xeko-git-1/paykit";
import type { DbClient } from "@xeko-git-1/paykit-auth-core/db/client.js";
import {
  claimDeliveryById,
  recordDelivery,
} from "@xeko-git-1/paykit-auth-core/db/repos/webhook-inbox.repo.js";
import type { Context } from "hono";
import { Hono } from "hono";
import type { PaykitEventHandlers } from "../../events/emitter.js";
import { processNextScreeningJob } from "../../services/screening-runner.js";
import {
  type DeliveryProcessorDeps,
  type DeliveryResult,
  processDelivery,
} from "../../services/webhook-delivery-processor.js";
import { INBOX_LEASE_MS } from "../../services/webhook-inbox-policy.js";
import { hashRawBody, redactRawBody } from "../../services/webhook-payload-storage.js";
import { errorJson } from "../shared/response.js";

export interface WebhookRouterDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly events: PaykitEventHandlers;
  readonly logger?: { warn: (msg: string, details?: Record<string, unknown>) => void };
  /**
   * BYOC OFAC/sanctions screening hook — the legacy shape.
   *
   * Kept working by adapting it onto `ScreeningService`: a throw quarantines the
   * payment, exactly as before. Prefer `screeningService` for new configuration.
   */
  readonly onBeforeCredit?: (evt: NormalizedWebhookEvent) => Promise<void>;
  /**
   * Compliance screening service, called OUTSIDE the business transaction.
   *
   * When either this or `onBeforeCredit` is configured, `payment.completed` parks
   * the payment in `screening_pending` and enqueues a job instead of crediting
   * inline; the screening runner applies the verdict. Leaving both unset keeps the
   * inline credit path exactly as it was.
   */
  readonly screeningService?: ScreeningService;
  /** Optional metrics counter emitter — default no-op. */
  readonly emitMetric?: (name: string, labels: Record<string, string>, value?: number) => void;
  /** Extra redaction patterns for stored payloads, from `observability.redact`. */
  readonly redactPatterns?: readonly RegExp[];
}

export function buildWebhookRouter(deps: WebhookRouterDeps): Hono {
  const app = new Hono();

  for (const adapter of deps.registry.list()) {
    app.post(`/${adapter.id}`, async (c) => handleWebhook(c, adapter, deps));
  }

  return app;
}

async function handleWebhook(
  c: Context,
  adapter: PaymentProviderAdapter,
  deps: WebhookRouterDeps,
): Promise<Response> {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const authenticated = await authenticateDelivery(c, adapter, deps, rawBody, headers);
  if (authenticated.kind === "rejected") return authenticated.response;
  if (authenticated.kind === "ignored") {
    return c.json({ received: true, skipped: "adapter_returned_null" });
  }
  const evt = authenticated.event;

  // Record first, in its own transaction. From here on the delivery cannot be lost:
  // whatever happens next, the payload and its state are durable.
  const recorded = await recordDelivery(deps.db, {
    provider: adapter.id,
    eventId: evt.eventId,
    eventType: evt.type,
    payloadHash: hashRawBody(rawBody),
    rawPayload: redactRawBody(rawBody, deps.redactPatterns),
    normalizedPayload: { ...evt },
    providerRef: evt.providerRef,
  });

  if (recorded.payloadMismatch) {
    // One event id with two different bodies is a provider bug or an attack. The
    // stored payload is never overwritten — the first one is what the audit trail
    // describes — but this must be visible.
    deps.logger?.warn("webhook payload differs from the body already stored for this event id", {
      provider: adapter.id,
      eventId: evt.eventId,
    });
    deps.emitMetric?.("paykit_webhook_payload_mismatch_total", { provider: adapter.id });
  }

  // Claim the row we just recorded. Losing this claim is not an error: a background
  // worker holds the delivery, and it will be processed there.
  const claimed = await claimDeliveryById(deps.db, {
    inboxId: recorded.row.inboxId,
    leaseMs: INBOX_LEASE_MS,
  });
  if (claimed === undefined) {
    return c.json({ received: true, deferred: stateOf(recorded.row.state) });
  }

  const result = await processDelivery(processorDeps(deps, adapter), claimed);

  // A screening verdict is attempted only now: the business transaction has
  // committed and the payment row lock is gone. Doing it here rather than only from
  // a cron keeps the common case — a screening service that answers quickly — as
  // fast as the old inline hook, without holding a row lock across the call.
  if (result.kind === "processed" && result.screeningEnqueued) {
    await attemptScreeningVerdict(deps, adapter.id, evt.providerRef);
  }

  return c.json(responseFor(result));
}

/** What the caller is told, per outcome. Always 2xx — see below for why. */
function responseFor(result: DeliveryResult): Record<string, unknown> {
  switch (result.kind) {
    case "processed":
      return { received: true };
    // Retryable outcomes still ACK. The delivery is durable and owned by the retry
    // worker, so asking the provider to redeliver would add a second copy of work
    // that is already scheduled — and providers give up on non-2xx long before an
    // unmatched checkout resolves.
    case "unmatched":
      return { received: true, pending: "awaiting_transaction" };
    case "failed":
      return { received: true, pending: "retry_scheduled" };
    case "dead_letter":
      return { received: true, pending: "dead_letter" };
    case "not_claimable":
      return { received: true, deferred: "processing" };
  }
}

function stateOf(state: string): string {
  return state === "processed" ? "already_processed" : "processing";
}

type AuthenticatedDelivery =
  | { readonly kind: "event"; readonly event: NormalizedWebhookEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly response: Response };

/**
 * Establish that this delivery is genuine and understandable, before anything is
 * stored. Nothing unauthenticated reaches the inbox: the table is durable, and an
 * unverified body would be an attacker-controlled row anyone could plant.
 */
async function authenticateDelivery(
  c: Context,
  adapter: PaymentProviderAdapter,
  deps: WebhookRouterDeps,
  rawBody: string,
  headers: Record<string, string>,
): Promise<AuthenticatedDelivery> {
  if (adapter.resolveWebhook) {
    // Unsigned-webhook providers (BitPay): the IPN is an untrusted trigger, and the
    // adapter authenticates by fetching authoritative status from the provider API.
    try {
      const resolved = await adapter.resolveWebhook(rawBody, headers);
      return resolved ? { kind: "event", event: resolved } : { kind: "ignored" };
    } catch (err) {
      deps.logger?.warn(`adapter '${adapter.id}' resolveWebhook threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: "rejected",
        response: errorJson(c, 502, "WEBHOOK_RESOLVE_ERROR", "Adapter could not resolve webhook"),
      };
    }
  }

  if (!adapter.verifyWebhookSignature(rawBody, headers)) {
    return {
      kind: "rejected",
      response: errorJson(c, 401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature"),
    };
  }

  try {
    const parsed = adapter.parseWebhookPayload(rawBody, headers);
    return parsed ? { kind: "event", event: parsed } : { kind: "ignored" };
  } catch (err) {
    deps.logger?.warn(`adapter '${adapter.id}' parseWebhookPayload threw`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "rejected",
      response: errorJson(c, 400, "WEBHOOK_PARSE_ERROR", "Adapter could not parse payload"),
    };
  }
}

function processorDeps(
  deps: WebhookRouterDeps,
  adapter: PaymentProviderAdapter,
): DeliveryProcessorDeps {
  return {
    db: deps.db,
    events: deps.events,
    screeningConfigured: deps.screeningService !== undefined || deps.onBeforeCredit !== undefined,
    settlesExactAmount: () => adapter.settlesExactAmount !== false,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
  };
}

/**
 * Apply a pending screening verdict, swallowing every failure deliberately.
 *
 * The job row is the durable record, so an error here means the verdict lands on a
 * later attempt. Returning non-2xx instead would make the provider redeliver an
 * event that was already processed. The payment stays uncredited in the meantime,
 * which is the safe direction — a screening that has not answered must never read
 * as permission.
 */
async function attemptScreeningVerdict(
  deps: WebhookRouterDeps,
  provider: string,
  providerRef: string,
): Promise<void> {
  const screeningService = resolveScreeningService(deps);
  if (screeningService === undefined) return;
  try {
    await processNextScreeningJob({
      db: deps.db,
      screeningService,
      // The verdict path owns payment.completed for a screened payment: the park
      // had nothing to announce yet.
      events: deps.events,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.emitMetric !== undefined ? { emitMetric: deps.emitMetric } : {}),
    });
  } catch (err) {
    deps.logger?.warn("screening verdict deferred — job left for a later attempt", {
      provider,
      providerRef,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The screening service to apply verdicts with.
 *
 * An explicit `screeningService` wins; otherwise the legacy `onBeforeCredit` hook is
 * adapted onto the same contract, so tenants configured the old way keep the
 * behaviour they have without changing anything. Undefined means neither is
 * configured, in which case nothing was ever enqueued.
 */
function resolveScreeningService(deps: WebhookRouterDeps): ScreeningService | undefined {
  if (deps.screeningService !== undefined) return deps.screeningService;
  if (deps.onBeforeCredit !== undefined) {
    return screeningServiceFromOnBeforeCredit(deps.onBeforeCredit);
  }
  return undefined;
}
