/**
 * Coinbase Commerce webhook event → paykit WebhookEventType.
 *
 * The delivery wraps an event in `{ event: { type, data } }`, where `data` is the
 * charge. Event types, per the published webhook contract:
 *   charge:created   → null (charge opened; nothing has been paid)
 *   charge:pending   → null (payment seen on-chain, awaiting confirmations)
 *   charge:confirmed → payment.completed (settled)
 *   charge:failed    → payment.failed / payment.expired (see below)
 *   charge:resolved  → payment.completed (an unresolved charge released by the
 *                      merchant, e.g. after an underpayment was accepted)
 *   charge:delayed   → null (paid after expiry; sits unresolved until someone acts)
 *
 * `charge:failed` covers both a charge nobody paid and one that failed outright,
 * and the two are not the same fact to paykit: an expiry releases any discount
 * reservation and reads as abandonment, whereas a failure is a terminal error. The
 * timeline's last status distinguishes them — EXPIRED maps to `payment.expired`,
 * anything else to `payment.failed`.
 *
 * UNRESOLVED is deliberately not treated as payment. Its context says why the
 * charge could not settle cleanly (UNDERPAID, OVERPAID, DELAYED, MULTIPLE,
 * MANUAL), and only two of those are safe to map: UNDERPAID becomes
 * `payment.underpaid`, which the server records without moving the ledger.
 * Everything else stays `null` and waits for `charge:resolved`, because releasing
 * an unresolved charge is a merchant decision that paykit must not make on its own.
 *
 * providerRef = `metadata.paykit_transaction_id`, the reference set at checkout.
 * Coinbase echoes metadata back on every event, so the router's
 * (provider, provider_ref) lookup matches the row. The charge id and code travel
 * in metadata for audit.
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";

export interface CoinbaseCommercePrice {
  readonly amount?: string;
  readonly currency?: string;
}

export interface CoinbaseCommerceTimelineEntry {
  readonly time?: string;
  readonly status?: string;
  readonly context?: string;
}

export interface CoinbaseCommerceCharge {
  readonly id?: string;
  readonly code?: string;
  readonly pricing_type?: string;
  readonly pricing?: { readonly local?: CoinbaseCommercePrice };
  readonly local_price?: CoinbaseCommercePrice;
  readonly metadata?: Record<string, unknown>;
  readonly timeline?: readonly CoinbaseCommerceTimelineEntry[];
  readonly payments?: readonly {
    readonly status?: string;
    readonly value?: { readonly local?: CoinbaseCommercePrice };
  }[];
  readonly expires_at?: string;
  readonly created_at?: string;
  readonly confirmed_at?: string;
}

export interface CoinbaseCommerceEventEnvelope {
  readonly id?: string;
  readonly scheduled_for?: string;
  readonly event?: {
    readonly id?: string;
    readonly type?: string;
    readonly created_at?: string;
    readonly data?: CoinbaseCommerceCharge;
  };
}

/** The metadata key carrying paykit's transaction id through the charge. */
export const PAYKIT_REFERENCE_METADATA_KEY = "paykit_transaction_id";

const AMOUNT_DRIFT_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

function usdMicros(amount: string | undefined): string | undefined {
  if (amount === undefined || amount === null || amount === "") return undefined;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.round(n * 1_000_000)).toString();
}

function exceedsDriftThreshold(expected: bigint, actual: bigint): boolean {
  if (expected === 0n) return actual !== 0n;
  const diff = expected > actual ? expected - actual : actual - expected;
  return diff * BPS_DENOMINATOR > expected * AMOUNT_DRIFT_BPS;
}

/** The charge's last timeline entry — the status that currently holds. */
function latestTimelineEntry(
  charge: CoinbaseCommerceCharge,
): CoinbaseCommerceTimelineEntry | undefined {
  const timeline = charge.timeline ?? [];
  return timeline.length > 0 ? timeline[timeline.length - 1] : undefined;
}

export function mapEventTypeToWebhookEventType(
  eventType: string | undefined,
  charge: CoinbaseCommerceCharge,
): WebhookEventType | null {
  const latest = latestTimelineEntry(charge);
  const status = latest?.status?.toUpperCase();
  const context = latest?.context?.toUpperCase();

  switch (eventType) {
    case "charge:confirmed":
    case "charge:resolved":
      return "payment.completed";
    case "charge:failed":
      // An expiry and a failure are different facts downstream: the first
      // releases the discount reservation and reads as abandonment.
      return status === "EXPIRED" ? "payment.expired" : "payment.failed";
    case "charge:pending":
    case "charge:created":
    case "charge:delayed":
      // A short payment is worth recording even while the charge is unresolved,
      // so the shortfall is visible before anyone decides what to do about it.
      // The server logs it without touching the ledger.
      if (status === "UNRESOLVED" && context === "UNDERPAID") return "payment.underpaid";
      return null;
    default:
      return null;
  }
}

/**
 * The USD amount the charge was priced at. `pricing.local` is the canonical
 * field on a charge; `local_price` is the request-shaped alias, accepted as a
 * fallback so a payload echoing the create body still reads.
 */
function chargePriceUsd(charge: CoinbaseCommerceCharge): string | undefined {
  return charge.pricing?.local?.amount ?? charge.local_price?.amount;
}

/** What the customer actually paid, in the charge's local (USD) terms. */
function paidLocalUsd(charge: CoinbaseCommerceCharge): string | undefined {
  for (const payment of charge.payments ?? []) {
    const amount = payment.value?.local?.amount;
    if (amount !== undefined && amount !== "") return amount;
  }
  return undefined;
}

export function parseCoinbaseCommerceEvent(
  envelope: CoinbaseCommerceEventEnvelope,
): NormalizedWebhookEvent | null {
  const event = envelope.event;
  const charge = event?.data;
  if (!event || !charge) return null;

  const reference = charge.metadata?.[PAYKIT_REFERENCE_METADATA_KEY];
  // Without paykit's own reference there is no row this event could belong to.
  // Charges created outside paykit reach the same endpoint and must be ignored
  // rather than guessed at.
  if (typeof reference !== "string" || reference === "") return null;

  const baseType = mapEventTypeToWebhookEventType(event.type, charge);
  if (baseType === null) return null;

  const expected = usdMicros(chargePriceUsd(charge));
  const actually = usdMicros(paidLocalUsd(charge));

  let type: WebhookEventType = baseType;
  if (
    baseType === "payment.completed" &&
    expected !== undefined &&
    actually !== undefined &&
    exceedsDriftThreshold(BigInt(expected), BigInt(actually))
  ) {
    // Quarantine rather than credit: the settled amount disagrees with the price
    // by more than rounding explains, and which figure is right is not something
    // this adapter can decide.
    type = "payment.amount_mismatch";
  }

  // Credit the invoiced price, not the on-chain amount. An overpayment is the
  // customer covering fees or rounding up; crediting it would put more in the
  // wallet than was ever charged for.
  const amountMicros = type === "payment.completed" ? (expected ?? actually) : actually;

  // The event id, not the charge id: a single charge emits several events and each
  // must be a distinct inbox row, or the second one is discarded as a duplicate.
  const eventId = `coinbase-commerce:${reference}:${event.id ?? charge.id ?? "0"}:${event.type ?? "?"}`;

  return {
    eventId,
    type,
    providerRef: reference,
    ...(amountMicros !== undefined ? { amountMicros } : {}),
    ...(expected !== undefined ? { expectedAmountMicros: expected } : {}),
    currencyCode: "USD",
    metadata: {
      eventType: event.type,
      eventId: event.id,
      chargeId: charge.id,
      chargeCode: charge.code,
      timelineStatus: latestTimelineEntry(charge)?.status,
      timelineContext: latestTimelineEntry(charge)?.context,
      paidLocalAmount: paidLocalUsd(charge),
    },
  };
}
