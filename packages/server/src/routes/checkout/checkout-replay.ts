/**
 * What a retried checkout gets back, and when a retry is allowed at all.
 *
 * A checkout spans this database and the provider, so a retry with the same
 * Idempotency-Key can arrive in three very different situations, and the old
 * replay path handled only one of them:
 *
 *   - The first attempt finished. The retry must return the SAME response,
 *     including the URLs and expiry the client needs to send the customer to the
 *     provider. Returning a trimmed body (which is what happened) means a client
 *     that retried once could no longer complete the checkout it had already
 *     paid for the right to make.
 *   - The first attempt is still running, or died between claiming the key and
 *     the provider answering. There is no response to replay yet, and creating a
 *     second provider session would charge the customer twice. The retry has to
 *     be told to come back.
 *   - The payment has moved on — paid, expired, refunded. It is not a checkout
 *     any more, and re-issuing a session for it would be a second charge.
 *
 * The stored `checkoutResultJson` is what makes the first case a real replay: it
 * is the provider's answer kept whole, rather than reassembled from whichever
 * fields happened to survive in `metadata_json`.
 */
import type { PaymentTransaction } from "@vibecc/paykit-auth-core/db/schema/payment-transactions.js";

/** The body a checkout returns, on a first attempt and on a replay alike. */
export interface CheckoutResponseBody {
  readonly transactionId: string;
  readonly provider: string;
  readonly webUrl: string;
  readonly qrUrl?: string;
  readonly mobileDeeplink?: string;
  readonly expiresAt: string;
  readonly discountApplied: boolean;
  /** Present only on a replay, so a client can tell one from a fresh checkout. */
  readonly cached?: true;
}

export type ReplayDecision =
  /** A complete stored response — return it verbatim. */
  | { readonly kind: "replay"; readonly body: CheckoutResponseBody }
  /**
   * A claim exists but has no answer yet. The caller must not create a second
   * provider session; it reports 409 and the client retries.
   */
  | { readonly kind: "in_progress" }
  /**
   * The payment is past the checkout stage. Re-issuing a session would be a
   * second charge, so the caller refuses.
   */
  | { readonly kind: "not_replayable"; readonly status: string };

/** Shape of the provider answer as stored. Every field is re-validated on read. */
interface StoredCheckoutResult {
  readonly webUrl?: unknown;
  readonly qrUrl?: unknown;
  readonly mobileDeeplink?: unknown;
  readonly expiresAt?: unknown;
  readonly discountApplied?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rebuild the original response from a stored provider answer.
 *
 * Returns undefined when the stored value cannot produce a usable checkout — a
 * row written before this column existed, or one whose JSON is missing the URL a
 * client cannot proceed without. Such a retry is treated as in-progress rather
 * than replayed: handing back a body with no `webUrl` looks like success and
 * leaves the caller with nothing to do.
 */
function bodyFromStoredResult(row: PaymentTransaction): CheckoutResponseBody | undefined {
  const stored = row.checkoutResultJson as StoredCheckoutResult | null;
  if (stored === null || typeof stored !== "object") return undefined;

  const webUrl = readString(stored.webUrl);
  const expiresAt = readString(stored.expiresAt);
  if (webUrl === undefined || expiresAt === undefined) return undefined;

  const qrUrl = readString(stored.qrUrl);
  const mobileDeeplink = readString(stored.mobileDeeplink);
  return {
    transactionId: row.transactionId,
    provider: row.provider,
    webUrl,
    ...(qrUrl !== undefined ? { qrUrl } : {}),
    ...(mobileDeeplink !== undefined ? { mobileDeeplink } : {}),
    expiresAt,
    discountApplied: stored.discountApplied === true,
    cached: true,
  };
}

/**
 * Decide what a retry on an existing claim should receive.
 *
 * `provider_creating` is the one status that means "no answer yet": the claim was
 * taken and the provider call has not come back (or the process died during it).
 * Everything else that is still awaiting payment should have a stored result; if
 * it does not — a row from before this column existed — it is reported as
 * in-progress rather than replayed with an unusable body.
 */
export function decideReplay(row: PaymentTransaction): ReplayDecision {
  if (row.status === "provider_creating") return { kind: "in_progress" };

  if (row.status === "pending" || row.status === "awaiting_payment") {
    const body = bodyFromStoredResult(row);
    return body !== undefined ? { kind: "replay", body } : { kind: "in_progress" };
  }

  // Paid, expired, quarantined, refunded, screening: no longer a checkout.
  return { kind: "not_replayable", status: row.status };
}

/** The provider answer, in the shape stored for replay. */
export function storableCheckoutResult(opts: {
  webUrl: string;
  expiresAt: Date;
  qrUrl?: string;
  mobileDeeplink?: string;
  discountApplied: boolean;
}): Record<string, unknown> {
  return {
    webUrl: opts.webUrl,
    expiresAt: opts.expiresAt.toISOString(),
    ...(opts.qrUrl !== undefined ? { qrUrl: opts.qrUrl } : {}),
    ...(opts.mobileDeeplink !== undefined ? { mobileDeeplink: opts.mobileDeeplink } : {}),
    discountApplied: opts.discountApplied,
  };
}
