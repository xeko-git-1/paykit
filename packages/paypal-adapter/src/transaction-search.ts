/**
 * Reconciliation listing via the Transaction Search API
 * (GET /v1/reporting/transactions).
 *
 * Three provider limits shape this:
 *   - A single query spans at most 31 days, so longer windows are split.
 *   - Pages are 1-based, at most 500 rows, with `total_pages` to stop on.
 *   - Data is not real-time: PayPal reports `last_refreshed_datetime`, and
 *     transactions after it are simply absent. A window reaching past that
 *     instant would list as complete while missing its newest payments, and
 *     the reconciler would report each one as missing at the provider. Such a
 *     window THROWS instead, so it is recorded as uncovered and retried once
 *     PayPal's data has caught up.
 *
 * Rows are keyed on `custom_field` (= the custom_id paykit set at checkout).
 * Only settled payments count: status S (success), F (partially refunded), V
 * (reversed — fully refunded, but the money did settle first). Negative
 * amounts are refunds/fees and are skipped by the amount parser.
 */
import type { ProviderTxnRecord } from "@xeko-git-1/paykit";
import { paypalValueToMicros } from "./amounts.js";
import { type PaypalClient, readPaypalError } from "./paypal-client.js";
import type { PaypalSearchResponse } from "./paypal-types.js";

const MAX_SPAN_MS = 31 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
/** Bounds one run if `total_pages` is absent or never reached. */
const MAX_PAGES_PER_SPAN = 100;
const SETTLED_STATUSES = new Set(["S", "F", "V"]);

/** PayPal wants seconds and no milliseconds: 2026-08-01T00:00:00Z. */
function paypalTime(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

async function listSpan(
  client: PaypalClient,
  since: Date,
  until: Date,
  out: ProviderTxnRecord[],
): Promise<void> {
  for (let page = 1; page <= MAX_PAGES_PER_SPAN; page++) {
    const params = new URLSearchParams({
      start_date: paypalTime(since),
      end_date: paypalTime(until),
      fields: "transaction_info",
      page_size: String(PAGE_SIZE),
      page: String(page),
    });
    const res = await client.request<PaypalSearchResponse>(
      "GET",
      `/v1/reporting/transactions?${params.toString()}`,
    );
    if (!res.ok || res.body === undefined) {
      throw new Error(
        `PayPal transaction search failed: HTTP ${res.status} ${readPaypalError(res.text)}`,
      );
    }
    const json = res.body;

    const refreshed = Date.parse(json.last_refreshed_datetime ?? "");
    if (!Number.isNaN(refreshed) && refreshed < until.getTime()) {
      throw new Error(
        `PayPal transaction data is only refreshed to ${json.last_refreshed_datetime}; the window ending ${until.toISOString()} cannot be listed completely yet`,
      );
    }

    const rows = json.transaction_details ?? [];
    for (const row of rows) {
      const info = row.transaction_info;
      if (info === undefined) continue;
      if (!SETTLED_STATUSES.has(info.transaction_status ?? "")) continue;
      const reference = info.custom_field;
      if (typeof reference !== "string" || reference === "") continue;
      const amountMicros = paypalValueToMicros(info.transaction_amount?.value);
      const currency = info.transaction_amount?.currency_code;
      if (amountMicros === null || typeof currency !== "string") continue;
      out.push({ providerRef: reference, amountMicros, currencyCode: currency.toUpperCase() });
    }

    const totalPages = typeof json.total_pages === "number" ? json.total_pages : page;
    if (page >= totalPages || rows.length < PAGE_SIZE) return;
  }
  throw new Error(
    `PayPal transaction search exceeded ${MAX_PAGES_PER_SPAN} pages; narrow the reconciliation window`,
  );
}

export async function searchSettledTransactions(
  client: PaypalClient,
  window: { since: Date; until?: Date },
): Promise<readonly ProviderTxnRecord[]> {
  const until = window.until ?? new Date();
  const records: ProviderTxnRecord[] = [];
  let spanStart = window.since.getTime();
  while (spanStart < until.getTime()) {
    const spanEnd = Math.min(spanStart + MAX_SPAN_MS, until.getTime());
    await listSpan(client, new Date(spanStart), new Date(spanEnd), records);
    spanStart = spanEnd;
  }
  return records;
}
