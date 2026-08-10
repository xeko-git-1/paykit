/**
 * Stripe payment client — Checkout Session for one-time top-up + webhook verify.
 * V1 supports `mode: "payment"` only. Subscription is V2 (see plan phase 12).
 *
 * Webhook secret rotation: `webhookSecret` accepts string or string[].
 * `constructWebhookEvent` tries each secret in order; first success wins.
 * On all failures, throws WebhookSignatureError (not raw Stripe error).
 */
import { WebhookSignatureError } from "@xeko-git-1/paykit";
import Stripe from "stripe";

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string | readonly string[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly apiVersion?: Stripe.LatestApiVersion;
}

export interface StripeCheckoutResult {
  readonly sessionId: string;
  readonly checkoutUrl: string;
}

export interface CreateTopUpSessionInput {
  readonly amountUsd: number;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly customerEmail?: string;
}

export class StripeClient {
  private readonly stripe: Stripe;
  private readonly config: StripeConfig;

  constructor(config: StripeConfig) {
    this.config = config;
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: config.apiVersion ?? ("2025-09-30.clover" as Stripe.LatestApiVersion),
    });
  }

  async createTopUpSession(opts: CreateTopUpSessionInput): Promise<StripeCheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Paykit Credits" },
            unit_amount: Math.round(opts.amountUsd * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { tenantId: opts.tenantId, ownerId: opts.ownerId },
      ...(opts.customerEmail !== undefined ? { customer_email: opts.customerEmail } : {}),
      success_url: `${this.config.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: this.config.cancelUrl,
    });
    return {
      sessionId: session.id,
      checkoutUrl: session.url ?? this.config.cancelUrl,
    };
  }

  /**
   * Verify a Stripe webhook signature against one or more configured secrets.
   * Tries each secret; first success returns the parsed event. All failures
   * throw `WebhookSignatureError` (paykit-typed, never raw Stripe error).
   */
  constructWebhookEvent(payload: string, signature: string): Stripe.Event {
    const secrets = Array.isArray(this.config.webhookSecret)
      ? (this.config.webhookSecret as readonly string[])
      : [this.config.webhookSecret as string];

    if (secrets.length === 0) {
      throw new WebhookSignatureError("No webhook secrets configured");
    }

    let lastErr: unknown = null;
    for (const secret of secrets) {
      try {
        return this.stripe.webhooks.constructEvent(payload, signature, secret);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new WebhookSignatureError(
      `Stripe webhook signature did not match any of ${secrets.length} configured secret(s): ${lastErr instanceof Error ? lastErr.message : "unknown"}`,
    );
  }

  async getSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.retrieve(sessionId);
  }

  /** Internal Stripe client handle — exposed for reconciliation worker (Phase 08). */
  get raw(): Stripe {
    return this.stripe;
  }
}

export function createStripeClient(config: StripeConfig): StripeClient {
  return new StripeClient(config);
}
