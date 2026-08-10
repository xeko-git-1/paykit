/**
 * createStripeSubscriptionAdapter — V2 SubscriptionAdapter implementation.
 *
 * Coexists with V1.5 createStripeAdapter (id='stripe'). Default id here is
 * 'stripe-subscription'; override via config.id. Multi-instance grammar
 * deferred to V2.1 — see plan.md.
 *
 * Idempotency keys forwarded to Stripe verbatim (RT F4/F8). Signature
 * verification is per-instance (RT F7).
 *
 * findLatestEventCreated (RT F2) replaces the fictional Stripe.updated field
 * with `events.list({type: 'customer.subscription.*'})` filtered by
 * subscription id.
 */
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  NormalizedSubscriptionEvent,
  SubscriptionAdapter,
  SubscriptionResult,
  UpgradeSubscriptionInput,
} from "@xeko-git-1/paykit";
import Stripe from "stripe";
import { mapStripeStatus } from "./status-mapper.js";
import { mapEvent } from "./webhook-events.js";
import { verifyAndParse } from "./webhook-verifier.js";

export interface StripeSubscriptionAdapterConfig {
  readonly id?: string;
  readonly secretKey: string;
  readonly webhookSecret: string | readonly string[];
  readonly apiVersion?: Stripe.LatestApiVersion;
  readonly environment?: "sandbox" | "production";
  readonly stripe?: Stripe;
}

const DEFAULT_API_VERSION = "2025-09-30.clover" as Stripe.LatestApiVersion;

function toResult(sub: Stripe.Subscription, lastEventCreated: Date): SubscriptionResult {
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? "";
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const status = mapStripeStatus(sub.status).status;
  const periodEndUnix =
    (item?.current_period_end as number | undefined) ??
    ((sub as unknown as { current_period_end?: number }).current_period_end ?? 0);
  const currentPeriodEnd = new Date(periodEndUnix * 1000);
  const latestInvoiceId =
    typeof sub.latest_invoice === "string"
      ? sub.latest_invoice
      : (sub.latest_invoice?.id ?? undefined);
  const currencyCode = (sub.currency ?? "usd").toUpperCase() as SubscriptionResult["currencyCode"];
  const result: SubscriptionResult = {
    id: sub.id,
    status,
    currentPeriodEnd,
    customerId,
    priceId,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    currencyCode,
    lastEventCreated,
    ...(latestInvoiceId !== undefined ? { latestInvoiceId } : {}),
  };
  return result;
}

export function createStripeSubscriptionAdapter(
  config: StripeSubscriptionAdapterConfig,
): SubscriptionAdapter & {
  findLatestEventCreated(subscriptionId: string, since?: Date): Promise<Date | null>;
} {
  const stripe =
    config.stripe ??
    new Stripe(config.secretKey, { apiVersion: config.apiVersion ?? DEFAULT_API_VERSION });
  const id = config.id ?? "stripe-subscription";

  async function findLatestEventCreated(subscriptionId: string, since?: Date): Promise<Date | null> {
    const params: Stripe.EventListParams = { types: ["customer.subscription.*"], limit: 100 };
    if (since !== undefined) params.created = { gte: Math.floor(since.getTime() / 1000) };
    let cursor: string | undefined;
    let max: number | null = null;
    for (let page = 0; page < 10; page++) {
      const fetchParams: Stripe.EventListParams = { ...params };
      if (cursor !== undefined) fetchParams.starting_after = cursor;
      const list = await stripe.events.list(fetchParams);
      for (const ev of list.data) {
        const obj = ev.data.object as { id?: string; subscription?: string };
        const matches = obj.id === subscriptionId || obj.subscription === subscriptionId;
        if (matches && (max === null || (ev.created ?? 0) > max)) max = ev.created ?? 0;
      }
      if (!list.has_more) break;
      cursor = list.data[list.data.length - 1]?.id;
      if (cursor === undefined) break;
    }
    return max === null ? null : new Date(max * 1000);
  }

  async function deriveLastEventCreated(subscriptionId: string): Promise<Date> {
    const found = await findLatestEventCreated(subscriptionId);
    return found ?? new Date();
  }

  return {
    id,

    async subscribe(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
      const params: Stripe.SubscriptionCreateParams = {
        customer: input.customerId,
        items: [{ price: input.priceId }],
        payment_behavior: "default_incomplete",
        expand: ["latest_invoice"],
        metadata: {
          paykit_tenant_id: input.paykitTenantId,
          ...(input.metadata ?? {}),
        },
      };
      if (typeof input.trialDays === "number" && input.trialDays > 0) {
        params.trial_period_days = input.trialDays;
      }
      const opts: Stripe.RequestOptions = {};
      if (input.idempotencyKey !== undefined) opts.idempotencyKey = input.idempotencyKey;
      const sub = await stripe.subscriptions.create(params, opts);
      return toResult(sub, new Date(sub.created * 1000));
    },

    async cancel(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
      const opts: Stripe.RequestOptions = {};
      if (input.idempotencyKey !== undefined) opts.idempotencyKey = input.idempotencyKey;
      const sub = input.atPeriodEnd
        ? await stripe.subscriptions.update(
            input.subscriptionId,
            { cancel_at_period_end: true },
            opts,
          )
        : await stripe.subscriptions.cancel(input.subscriptionId, undefined, opts);
      return toResult(sub, await deriveLastEventCreated(sub.id));
    },

    async upgrade(input: UpgradeSubscriptionInput): Promise<SubscriptionResult> {
      const current = await stripe.subscriptions.retrieve(input.subscriptionId);
      const itemId = current.items.data[0]?.id;
      if (itemId === undefined) {
        throw new Error(`Subscription ${input.subscriptionId} has no items to upgrade`);
      }
      const opts: Stripe.RequestOptions = {};
      if (input.idempotencyKey !== undefined) opts.idempotencyKey = input.idempotencyKey;
      const sub = await stripe.subscriptions.update(
        input.subscriptionId,
        {
          items: [{ id: itemId, price: input.newPriceId }],
          proration_behavior: "create_prorations",
        },
        opts,
      );
      return toResult(sub, await deriveLastEventCreated(sub.id));
    },

    async listForCustomer(customerId: string): Promise<readonly SubscriptionResult[]> {
      const out: SubscriptionResult[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const params: Stripe.SubscriptionListParams = { customer: customerId, limit: 100 };
        if (cursor !== undefined) params.starting_after = cursor;
        const list = await stripe.subscriptions.list(params);
        for (const s of list.data) {
          out.push(toResult(s, new Date(s.created * 1000)));
        }
        if (!list.has_more) break;
        cursor = list.data[list.data.length - 1]?.id;
        if (cursor === undefined) break;
      }
      return out;
    },

    async getById(subscriptionId: string): Promise<SubscriptionResult | null> {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        return toResult(sub, await deriveLastEventCreated(sub.id));
      } catch (err) {
        if ((err as Stripe.errors.StripeError)?.code === "resource_missing") return null;
        throw err;
      }
    },

    verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
      const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"] ?? "";
      try {
        verifyAndParse(stripe, rawBody, signature, config.webhookSecret);
        return true;
      } catch {
        return false;
      }
    },

    parseSubscriptionEvent(
      rawBody: string,
      headers: Record<string, string>,
    ): NormalizedSubscriptionEvent | null {
      const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"] ?? "";
      let event: Stripe.Event;
      try {
        event = verifyAndParse(stripe, rawBody, signature, config.webhookSecret);
      } catch {
        return null;
      }
      return mapEvent(event);
    },

    async syncSubscription(subscriptionId: string): Promise<SubscriptionResult | null> {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const last = await findLatestEventCreated(sub.id);
        return toResult(sub, last ?? new Date(sub.created * 1000));
      } catch (err) {
        if ((err as Stripe.errors.StripeError)?.code === "resource_missing") return null;
        throw err;
      }
    },

    findLatestEventCreated,
  };
}
