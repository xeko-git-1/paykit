/**
 * Stripe fetcher — paginate `checkout.sessions.list({created: {gte: since}})`.
 *
 * Why Sessions not Charges: paykit stores `provider_ref = session.id` at
 * checkout time; matching by session.id is direct. Charges have nested
 * `payment_intent.checkout` which requires extra hops.
 *
 * Returns ProviderTxnRecord[] with amount in micros (cents × 10_000).
 */
import { stripeUsdAmountToMicros } from "@vibecc/paykit";
import type Stripe from "stripe";
import type { ProviderTxnRecord } from "./differ.js";

export interface StripeFetcher {
  list(window: { since: Date; until?: Date }): Promise<ProviderTxnRecord[]>;
}

export function createStripeFetcher(stripe: Stripe): StripeFetcher {
  return {
    async list(window) {
      const records: ProviderTxnRecord[] = [];
      const created: { gte: number; lt?: number } = {
        gte: Math.floor(window.since.getTime() / 1000),
      };
      if (window.until !== undefined) {
        created.lt = Math.floor(window.until.getTime() / 1000);
      }
      const baseParams: Stripe.Checkout.SessionListParams = { limit: 100, created };
      let cursor: string | undefined;
      // Defensive cap: Stripe pagination at most 1000 pages × 100 = 100k records.
      for (let page = 0; page < 1000; page++) {
        const fetchParams: Stripe.Checkout.SessionListParams = { ...baseParams };
        if (cursor !== undefined) fetchParams.starting_after = cursor;
        const list = await stripe.checkout.sessions.list(fetchParams);
        for (const s of list.data) {
          if (s.payment_status !== "paid") continue;
          if (s.amount_total === null) continue;
          let micros: bigint;
          try {
            micros = stripeUsdAmountToMicros(s.amount_total, s.currency ?? "usd");
          } catch {
            continue; // skip non-USD; surfaced to consumer logs by orchestrator
          }
          records.push({
            providerRef: s.id,
            amountMicros: micros.toString(),
            currencyCode: "USD",
          });
        }
        if (!list.has_more) break;
        cursor = list.data[list.data.length - 1]?.id;
        if (cursor === undefined) break;
      }
      return records;
    },
  };
}
