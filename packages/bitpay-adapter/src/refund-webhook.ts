/**
 * BitPay refund IPN resolution — refund resource → payment.refunded.
 *
 * BitPay notifies refunds on a SEPARATE resource from invoices. The IPN body is
 * `{ event: { code, name }, data: <refund> }` where `data.id` is the REFUND id
 * and `data.invoice` points at the invoice. That distinction is the whole reason
 * this module exists: feeding a refund IPN through the invoice fetch-back would
 * GET /invoices/<refundId>, 404, and silently drop the ledger debit.
 *
 * Resolution is two authoritative fetches, never the IPN body:
 *   1. GET /refunds/:refundId  → refund status + amount + owning invoice id.
 *      Merchant facade, so it must be ECDSA-signed via the injected signer.
 *   2. GET /invoices/:invoiceId → `orderId`, which is the paykit transactionId.
 *      The emitted providerRef MUST be that orderId: the server stores
 *      provider_ref = orderId at checkout, so anything else fails the row
 *      lookup and no debit is written.
 *
 * FIELD SHAPES ARE DOCUMENTED, NOT LIVE-VERIFIED. BitPay offers no reliably
 * testable sandbox for the refund lifecycle, so every read below is defensive:
 * unknown/absent values resolve to null (skip, no debit) rather than guessing.
 * Needs verification against a live account: the refund `status` enum (only
 * 'pending' appears in BitPay's own sample; success is assumed to be one of
 * success/succeeded/completed/complete) and whether the notification really
 * carries `event.name`/`event.code` in the extended format for every refund
 * transition. Guessing wrong in the safe direction under-reports refunds, which
 * reconciliation catches; guessing wrong in the unsafe direction would debit for
 * a refund that never landed.
 */
import type { NormalizedWebhookEvent } from "@xeko-git-1/paykit";
import type { BitpayMerchantSigner } from "./adapter.js";
import { type BitpayInvoice, amountToMicros } from "./webhook-events.js";

/**
 * BitPay refund resource (documented fields; all optional because the IPN and
 * the API return different subsets — `supportRequest` and
 * `lastRefundNotification`, for instance, only appear after refund_created).
 */
export interface BitpayRefund {
  readonly id?: string;
  /** Id of the invoice this refund belongs to — the bridge back to `orderId`. */
  readonly invoice?: string;
  readonly status?: string;
  /** Refund amount, denominated in the INVOICE's currency. */
  readonly amount?: number | string;
  readonly currency?: string;
  readonly refundFee?: number | string;
  /** 'full (current rate)' | 'partial' | 'underpayment' | 'overpayment' | 'declined'. */
  readonly type?: string;
  /** True for a simulated refund quote — must never move the ledger. */
  readonly preview?: boolean;
  readonly immediate?: boolean;
  readonly buyerPaysRefundFee?: boolean;
  readonly txid?: string;
  readonly requestDate?: string;
  /** Amount in the settlement/crypto currency — deliberately NOT used as an
   *  amount fallback: it is denominated differently from the ledger currency. */
  readonly transactionAmount?: number | string;
  readonly transactionCurrency?: string;
}

/** Refund notification codes: created, pending, success, failure. */
const REFUND_EVENT_CODES = new Set([7001, 7002, 7003, 7004]);

/**
 * Refund statuses that mean "money has actually left the merchant". Anything
 * outside this set — created, pending, failure, cancelled, declined, or a value
 * BitPay adds later — resolves to null so no debit is written. Default-deny is
 * intentional: a missed debit is caught by reconciliation, a wrongly written one
 * silently gives the customer their money twice.
 */
const SETTLED_REFUND_STATUSES = new Set(["success", "succeeded", "completed", "complete"]);

function readId(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readCurrency(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value.toUpperCase() : undefined;
}

/**
 * Returns the refund id when the trigger looks like a refund notification,
 * otherwise undefined so the caller falls through to invoice resolution.
 *
 * Three independent signals are accepted because the exact envelope is not
 * live-verified: the `refund_*` event name, the numeric refund code, and the
 * `data.invoice` back-reference that only the refund resource carries (an
 * invoice never points at another invoice). Any one is enough — the classifier
 * only decides WHICH resource to fetch back, and the fetch itself is what
 * authenticates the event, so a misclassification degrades to a skip.
 */
export function extractRefundTriggerId(trigger: unknown): string | undefined {
  if (typeof trigger !== "object" || trigger === null) return undefined;
  const t = trigger as {
    id?: unknown;
    event?: { code?: unknown; name?: unknown };
    data?: { id?: unknown; invoice?: unknown };
  };
  const name = t.event?.name;
  const code = t.event?.code;
  const looksLikeRefund =
    (typeof name === "string" && /^refund[_-]?/i.test(name)) ||
    (typeof code === "number" && REFUND_EVENT_CODES.has(code)) ||
    (typeof code === "string" && REFUND_EVENT_CODES.has(Number(code))) ||
    readId(t.data?.invoice) !== undefined;
  if (!looksLikeRefund) return undefined;
  return readId(t.data?.id) ?? readId(t.id);
}

/**
 * Build a payment.refunded event from an authoritative refund + its invoice.
 * Returns null whenever the refund is not a settled, unambiguously priced debit.
 *
 * `refundAmountMicros` is mandatory: the server's refund branch early-returns
 * without it, so omitting it would ACK the webhook and write nothing.
 */
export function refundToEvent(
  refund: BitpayRefund,
  invoice: BitpayInvoice,
): NormalizedWebhookEvent | null {
  // providerRef must be the invoice's orderId (= paykit transactionId) or the
  // server cannot find the payment row to debit.
  const orderId = invoice.orderId;
  if (orderId === undefined || orderId === "") return null;

  // A preview is a quote for a refund that was never executed.
  if (refund.preview === true) return null;

  const status = typeof refund.status === "string" ? refund.status.toLowerCase() : undefined;
  if (status === undefined || !SETTLED_REFUND_STATUSES.has(status)) return null;

  // Only `amount` is documented as being in the invoice's currency, so there is
  // no safe fallback: transactionAmount is denominated in the settlement asset
  // and would debit an unrelated magnitude.
  const refundAmountMicros = amountToMicros(refund.amount);
  if (refundAmountMicros === undefined || refundAmountMicros === "0") return null;

  // The invoice currency is the ledger currency. If the refund reports a
  // different one, the amount's unit is ambiguous — skip instead of debiting a
  // number whose denomination is unknown.
  const invoiceCurrency = readCurrency(invoice.currency);
  const refundCurrency = readCurrency(refund.currency);
  if (
    invoiceCurrency !== undefined &&
    refundCurrency !== undefined &&
    invoiceCurrency !== refundCurrency
  ) {
    return null;
  }
  const currencyCode = invoiceCurrency ?? refundCurrency ?? "USD";

  return {
    eventId: `bitpay:refund:${refund.id ?? "0"}:${status}`,
    type: "payment.refunded",
    providerRef: orderId,
    refundAmountMicros,
    currencyCode,
    metadata: {
      refundId: refund.id,
      invoiceId: invoice.id ?? refund.invoice,
      refundStatus: refund.status,
      refundType: refund.type,
      refundAmount: refund.amount,
      refundFee: refund.refundFee,
      buyerPaysRefundFee: refund.buyerPaysRefundFee,
      txid: refund.txid,
      invoicePrice: invoice.price,
    },
  };
}

export interface BitpayRefundResolveContext {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly apiVersion: string;
  readonly fetcher: typeof fetch;
  /** Merchant facade signer — GET /refunds/:id is not available to POS tokens. */
  readonly merchantSigner?: BitpayMerchantSigner;
  /** Owned by the adapter (POS-facade GET /invoices/:id); null when unusable. */
  readonly fetchInvoice: (invoiceId: string) => Promise<BitpayInvoice | null>;
}

/**
 * Fetch-back resolution for a refund trigger. Transport failures are allowed to
 * throw so the caller answers 502 and BitPay retries; data we could read but
 * cannot trust resolves to null (ACK + skip) so BitPay stops replaying an event
 * we deliberately ignore.
 */
export async function resolveRefundWebhook(
  ctx: BitpayRefundResolveContext,
  refundId: string,
): Promise<NormalizedWebhookEvent | null> {
  // Without the merchant facade the refund cannot be authenticated, and the
  // trust model forbids taking the IPN body's word for a ledger move. Refunds
  // issued outside this adapter (BitPay dashboard, automatic over/underpayment
  // refunds) therefore need manual reconciliation on signer-less deployments.
  if (!ctx.merchantSigner) return null;

  const url = `${ctx.baseUrl}/refunds/${encodeURIComponent(refundId)}?token=${encodeURIComponent(ctx.apiToken)}`;

  let signed: { identity: string; signature: string };
  try {
    signed = await ctx.merchantSigner.sign(url, "");
  } catch {
    return null; // unsigned request would be rejected anyway
  }

  const res = await ctx.fetcher(url, {
    method: "GET",
    headers: {
      "X-Accept-Version": ctx.apiVersion,
      "x-identity": signed.identity,
      "x-signature": signed.signature,
    },
  });
  if (!res.ok) return null;

  let refund: BitpayRefund;
  try {
    const json = (await res.json()) as { data?: BitpayRefund };
    refund = json.data ?? (json as BitpayRefund);
  } catch {
    return null; // unreadable authoritative response → nothing trustworthy to act on
  }

  // Take the invoice id from the fetched refund, not the IPN, so the debit is
  // attributed by BitPay rather than by the untrusted caller.
  const invoiceId = readId(refund.invoice);
  if (invoiceId === undefined) return null;

  const invoice = await ctx.fetchInvoice(invoiceId);
  if (invoice === null) return null;

  return refundToEvent(refund, invoice);
}
