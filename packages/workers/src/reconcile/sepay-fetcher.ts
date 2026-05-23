/**
 * SePay fetcher — paginate via SePay HTTP API.
 *
 * V1 placeholder: SePay HTTP API integration is consumer-specific (some use
 * GET /transactions, others use a polling endpoint). For V1 the fetcher
 * accepts a pre-fetched array — orchestrator caller wires their own SePay
 * HTTP client. Phase 11 adds a default `httpFetcher` against `api.sepay.vn`
 * once schema is locked.
 */
import type { ProviderTxnRecord } from "./differ.js";

export interface SepayApiTxn {
  readonly id: string;
  readonly orderId: string; // we use this as providerRef (paykit transactionId)
  readonly transferAmount: number; // VND
}

export interface SepayFetcher {
  list(window: { since: Date; until?: Date }): Promise<ProviderTxnRecord[]>;
}

/**
 * In-memory fetcher backed by a function the consumer provides. Tests + Phase
 * 11 wire a real HTTP fetcher; production consumers can use this to plug in
 * their own SePay polling code.
 */
export function createSepayFetcher(
  pull: (window: { since: Date; until?: Date }) => Promise<readonly SepayApiTxn[]>,
): SepayFetcher {
  return {
    async list(window) {
      const txns = await pull(window);
      return txns.map<ProviderTxnRecord>((t) => ({
        providerRef: t.orderId,
        amountMicros: (BigInt(t.transferAmount) * 1_000_000n).toString(),
        currencyCode: "VND",
      }));
    },
  };
}
