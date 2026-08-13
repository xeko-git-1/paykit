/**
 * SePay fetcher — provider-side transaction listing for reconciliation.
 *
 * Three constructors:
 * - `createSepayFetcher(pull)` — consumer supplies the pull function. Kept for
 *   merchants whose SePay account sits behind a proxy or a bespoke client.
 * - `createSepayHttpPull(config)` — default HTTP pull against SePay's user API
 *   (`GET https://my.sepay.vn/userapi/transactions/list`, Bearer token). The
 *   returned function has the same shape as the SePay ADAPTER's
 *   `transactionFetcher` option, so one construction serves both the legacy
 *   orchestrator and the registry-based v15 orchestrator:
 *     createSepayAdapter({ ..., transactionFetcher: createSepayHttpPull(cfg) })
 * - `createSepayHttpFetcher(config)` — the HTTP pull wrapped as a
 *   `SepayFetcher` for the legacy orchestrator.
 *
 * The HTTP pull pages with `since_id` until the window is exhausted and maps
 * each incoming transfer back to a paykit reference by parsing the transfer
 * memo with the same brand-prefix rule the adapter used to write it.
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
 * In-memory fetcher backed by a function the consumer provides. Tests and
 * consumers with bespoke SePay polling code plug in here; everyone else uses
 * `createSepayHttpPull` / `createSepayHttpFetcher`.
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

export interface SepayHttpFetcherConfig {
  /** SePay user API token (Bearer). Issued in the SePay dashboard under API Access. */
  readonly apiToken: string;
  /**
   * Memo prefix the checkout QR wrote in front of the paykit transactionId.
   * Must match the adapter's `brandPrefix` or no transfer will map back.
   */
  readonly brandPrefix?: string;
  /** Restrict to one bank account when the SePay account aggregates several. */
  readonly accountNumber?: string;
  readonly baseUrl?: string;
  /** Rows per page; SePay caps at 5000. */
  readonly pageLimit?: number;
  readonly fetchImpl?: typeof fetch;
}

const SEPAY_DEFAULT_BASE_URL = "https://my.sepay.vn";
const SEPAY_MAX_PAGE_LIMIT = 5000;
/** Hard ceiling on pages per window — 100 × 5000 rows; beyond this something is wrong. */
const SEPAY_MAX_PAGES = 100;

interface SepayListResponse {
  readonly status?: number;
  readonly error?: unknown;
  readonly messages?: { readonly success?: boolean };
  readonly transactions?: readonly SepayListTxn[];
}

interface SepayListTxn {
  readonly id: string | number;
  readonly transaction_date?: string; // "YYYY-MM-DD HH:mm:ss", UTC+7
  readonly amount_in?: string | number;
  readonly transaction_content?: string | null;
  readonly code?: string | null;
}

/** SePay timestamps are Vietnam local time (UTC+7); format the window to match. */
function formatSepayDate(d: Date): string {
  const local = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = local.getUTCFullYear().toString();
  const MM = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const HH = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const ss = String(local.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

/** Whole-VND from SePay's decimal string ("18067000.00") or number form. */
function vndFromAmountIn(amountIn: string | number | undefined): bigint {
  const whole = String(amountIn ?? "0").split(".")[0] ?? "0";
  return /^\d+$/.test(whole) ? BigInt(whole) : 0n;
}

/**
 * Default HTTP pull against SePay's user API.
 *
 * Only incoming transfers whose memo carries the brand prefix map to paykit
 * records; everything else on the account (outgoing transfers, unrelated
 * deposits) is not a paykit payment and is skipped rather than reported as a
 * paykit_missing discrepancy.
 *
 * On any transport or API failure this THROWS — an empty list is a factual
 * claim that the account received nothing, and the reconciler believes it.
 */
export function createSepayHttpPull(
  config: SepayHttpFetcherConfig,
): (window: { since: Date; until?: Date }) => Promise<readonly SepayApiTxn[]> {
  const baseUrl = (config.baseUrl ?? SEPAY_DEFAULT_BASE_URL).replace(/\/$/, "");
  const brandPrefix = config.brandPrefix ?? "PAYKIT";
  const pageLimit = Math.min(config.pageLimit ?? SEPAY_MAX_PAGE_LIMIT, SEPAY_MAX_PAGE_LIMIT);
  const doFetch = config.fetchImpl ?? fetch;

  // Same extraction rule as the adapter's webhook parser: the QR memo is
  // "<brandPrefix> <transactionId>", and banks may glue arbitrary text around it.
  const orderRegex = new RegExp(
    `${brandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([A-Za-z0-9-]+)`,
    "i",
  );

  return async (window) => {
    const until = window.until ?? new Date();
    const txnsOut: SepayApiTxn[] = [];
    let sinceId: string | undefined;

    for (let page = 0; page < SEPAY_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        transaction_date_min: formatSepayDate(window.since),
        transaction_date_max: formatSepayDate(until),
        limit: String(pageLimit),
      });
      if (config.accountNumber !== undefined) {
        params.set("account_number", config.accountNumber);
      }
      if (sinceId !== undefined) params.set("since_id", sinceId);

      const res = await doFetch(`${baseUrl}/userapi/transactions/list?${params.toString()}`, {
        headers: { Authorization: `Bearer ${config.apiToken}` },
      });
      if (!res.ok) {
        throw new Error(`SePay transactions/list returned HTTP ${res.status}`);
      }
      const json = (await res.json()) as SepayListResponse;
      if (json.messages?.success !== true) {
        throw new Error(`SePay transactions/list failed: ${JSON.stringify(json.error ?? json)}`);
      }
      const txns = json.transactions ?? [];

      let maxId = 0n;
      for (const t of txns) {
        const idStr = String(t.id);
        if (/^\d+$/.test(idStr) && BigInt(idStr) > maxId) maxId = BigInt(idStr);
        // since_id is inclusive (>=), so the row that anchored the previous
        // page comes back on the next one — drop it instead of double-counting.
        if (sinceId !== undefined && idStr === sinceId) continue;

        const vnd = vndFromAmountIn(t.amount_in);
        if (vnd <= 0n) continue; // outgoing or zero — not a paykit credit
        const memo = t.transaction_content ?? t.code ?? "";
        const match = memo.match(orderRegex);
        const orderId = match?.[1];
        if (orderId === undefined) continue; // unrelated deposit, no paykit reference

        txnsOut.push({ id: idStr, orderId, transferAmount: Number(vnd) });
      }

      if (txns.length < pageLimit) break;
      sinceId = maxId.toString();
    }

    return txnsOut;
  };
}

/** The default HTTP pull wrapped as a `SepayFetcher` for the legacy orchestrator. */
export function createSepayHttpFetcher(config: SepayHttpFetcherConfig): SepayFetcher {
  return createSepayFetcher(createSepayHttpPull(config));
}
