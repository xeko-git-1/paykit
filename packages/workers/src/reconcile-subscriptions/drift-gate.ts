/**
 * Pass A drift-gate (RT F2, F9). Decides whether the reconciler may mutate
 * a paykit cache row or must defer (assume webhook still in flight).
 *
 * Gate rules:
 *   1. If `lastEventCreated` is within `webhookFreshnessMs` (default 5 min),
 *      NEVER mutate — webhook will land soon.
 *   2. Otherwise, ask the adapter for the latest Stripe event for this sub
 *      since `lastEventCreated`. If Stripe has a newer event we don't, allow
 *      mutation; if no newer event, skip (paykit is current).
 */
import type { SubscriptionAdapter } from "@xeko-git-1/paykit";

export interface DriftGateAdapter extends Pick<SubscriptionAdapter, "id"> {
  findLatestEventCreated(subscriptionId: string, since?: Date): Promise<Date | null>;
}

export interface DriftGateInput {
  readonly subscriptionId: string;
  readonly cacheLastEventCreated: Date;
  readonly now?: Date;
  readonly webhookFreshnessMs?: number;
}

export interface DriftGateOutcome {
  readonly allow: boolean;
  readonly reason: "fresh_skip" | "no_newer_event" | "stripe_newer";
}

const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export async function evaluateDriftGate(
  adapter: DriftGateAdapter,
  input: DriftGateInput,
): Promise<DriftGateOutcome> {
  const now = (input.now ?? new Date()).getTime();
  const freshnessMs = input.webhookFreshnessMs ?? DEFAULT_FRESHNESS_MS;
  if (now - input.cacheLastEventCreated.getTime() < freshnessMs) {
    return { allow: false, reason: "fresh_skip" };
  }
  const latest = await adapter.findLatestEventCreated(
    input.subscriptionId,
    input.cacheLastEventCreated,
  );
  if (!latest) return { allow: false, reason: "no_newer_event" };
  if (latest.getTime() <= input.cacheLastEventCreated.getTime()) {
    return { allow: false, reason: "no_newer_event" };
  }
  return { allow: true, reason: "stripe_newer" };
}
