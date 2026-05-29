/**
 * Stripe subscription status → V2 SubscriptionStatus mapper (RT F3).
 *
 * Stripe documents 8 statuses. Future additions fall back to 'unpaid' and
 * emit `STATUS_UNKNOWN` so observability can alert without crashing the
 * adapter.
 */
import type { SubscriptionStatus } from "@vibecc/paykit";

const KNOWN: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  unpaid: "unpaid",
  incomplete_expired: "incomplete_expired",
  paused: "paused",
};

export interface MapStatusOutcome {
  readonly status: SubscriptionStatus;
  readonly fallback: boolean;
  readonly raw: string;
}

export function mapStripeStatus(raw: string): MapStatusOutcome {
  const known = KNOWN[raw];
  if (known) return { status: known, fallback: false, raw };
  return { status: "unpaid", fallback: true, raw };
}
