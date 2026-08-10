/**
 * Binance Pay notification (bizType/bizStatus) -> paykit WebhookEventType.
 *
 * The envelope is flat and its `data` member is a JSON *string*, not a nested
 * object, so it must be parsed a second time:
 *   { bizType, bizId, bizIdStr, bizStatus, data: "{\"merchantTradeNo\":...}" }
 *
 * Statuses (only final states are pushed):
 *   PAY        / PAY_SUCCESS     -> payment.completed
 *   PAY        / PAY_CLOSED      -> payment.expired   (unpaid orders auto-close)
 *   PAY        / PAY_FAIL        -> payment.failed    (direct-debit orders only)
 *   PAY_REFUND / REFUND_SUCCESS  -> payment.refunded
 *   PAY_REFUND / REFUND_REJECTED -> null (refund never moved money)
 *   PAYOUT     / *               -> null (not a paykit payment)
 *
 * providerRef = merchantTradeNo expanded back to the paykit transactionId. The
 * server stores provider_ref = transactionId at checkout, so this is what makes
 * the router's (provider, provider_ref) lookup hit the row.
 *
 * Currency guard: paykit credits USD. Binance orders can be denominated in a
 * crypto (USDT/BNB/...) if the merchant is not onboarded for USD pricing, and in
 * that case `totalFee` is a coin amount. Treating "0.01" USDT as 0.01 USD would
 * be a real crediting bug, so a non-USD completion is reported as
 * payment.amount_mismatch: the server quarantines it for admin reconcile
 * instead of crediting a wrong number.
 */
import type { NormalizedWebhookEvent, WebhookEventType } from "@xeko-git-1/paykit";
import { fromMerchantTradeNo } from "./merchant-trade-no.js";

export interface BinanceRefundInfo {
  readonly orderAmount?: string | number;
  readonly refundAmount?: string | number;
  readonly refundedAmount?: string | number;
  readonly refundRequestId?: string;
  readonly prepayId?: string;
  readonly payerOpenId?: string;
  readonly duplicateRequest?: string;
  readonly remainingAttempts?: number;
}

/** The inner payload after JSON-parsing the envelope's `data` string. */
export interface BinanceNotificationData {
  readonly merchantTradeNo?: string;
  readonly productType?: string;
  readonly productName?: string;
  readonly transactTime?: number;
  readonly tradeType?: string;
  readonly totalFee?: string | number;
  readonly currency?: string;
  readonly transactionId?: string;
  readonly openUserId?: string;
  readonly passThroughInfo?: string;
  readonly commission?: string | number;
  readonly refundInfo?: BinanceRefundInfo;
}

export interface BinanceNotificationEnvelope {
  readonly bizType?: string;
  readonly bizId?: number | string;
  readonly bizIdStr?: string;
  readonly bizStatus?: string;
  readonly data?: string;
}

export function mapBizStatusToEventType(
  bizType: string | undefined,
  bizStatus: string | undefined,
): WebhookEventType | null {
  if (bizType === "PAY") {
    switch (bizStatus) {
      case "PAY_SUCCESS":
        return "payment.completed";
      // The spec table says PAY_CLOSED; prose elsewhere writes PAY_CLOSE.
      // Accept both so a doc inconsistency cannot strand an order as pending.
      case "PAY_CLOSED":
      case "PAY_CLOSE":
        return "payment.expired";
      case "PAY_FAIL":
        return "payment.failed";
      default:
        return null;
    }
  }
  if (bizType === "PAY_REFUND") {
    switch (bizStatus) {
      case "REFUND_SUCCESS":
        return "payment.refunded";
      // Rejected refunds never moved funds — no ledger reversal to write.
      case "REFUND_REJECTED":
        return null;
      default:
        return null;
    }
  }
  return null;
}

/** Decimal coin/fiat string or number -> micros string. Undefined when unusable. */
function toMicros(amount: string | number | undefined): string | undefined {
  if (amount === undefined || amount === null || amount === "") return undefined;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.round(n * 1_000_000)).toString();
}

export function parseBinanceNotification(
  envelope: BinanceNotificationEnvelope,
): NormalizedWebhookEvent | null {
  const baseType = mapBizStatusToEventType(envelope.bizType, envelope.bizStatus);
  if (baseType === null) return null;

  // `data` is a JSON-encoded string inside the envelope.
  let data: BinanceNotificationData;
  try {
    data = envelope.data ? (JSON.parse(envelope.data) as BinanceNotificationData) : {};
  } catch {
    return null;
  }

  if (!data.merchantTradeNo) return null;
  const providerRef = fromMerchantTradeNo(data.merchantTradeNo);

  const currency = typeof data.currency === "string" ? data.currency.toUpperCase() : undefined;
  const amountMicros = toMicros(data.totalFee);

  // Non-USD denomination means totalFee is a coin amount, not dollars. Quarantine
  // rather than credit a number that is not the ledger's unit.
  let type: WebhookEventType = baseType;
  if (baseType === "payment.completed" && currency !== "USD") {
    type = "payment.amount_mismatch";
  }

  const refundInfo = data.refundInfo;
  // Only reverse a refund in the ledger when the order was denominated in USD.
  // A coin-denominated order was never credited (it quarantined above), so there
  // is nothing to debit, and debiting `refundAmount` would move coin units into
  // a USD ledger. Omitting refundAmountMicros makes the router skip the debit
  // while still recording the event for dedup/audit.
  const refundAmountMicros =
    type === "payment.refunded" && currency === "USD"
      ? (toMicros(refundInfo?.refundAmount) ?? amountMicros)
      : undefined;

  // Refunds key on prepayId, not merchantTradeNo. Surface it on completion so
  // the server persists it (provider_payment_id) for a later refund call; the
  // envelope's bizId/bizIdStr IS the prepay order id.
  const prepayId =
    refundInfo?.prepayId ??
    envelope.bizIdStr ??
    (envelope.bizId !== undefined ? String(envelope.bizId) : undefined);

  // Partial refunds repeat bizId, so refundRequestId keeps each one distinct.
  const eventId = [
    "binance",
    envelope.bizType ?? "?",
    envelope.bizIdStr ?? String(envelope.bizId ?? "0"),
    envelope.bizStatus ?? "?",
    refundInfo?.refundRequestId ?? "",
  ]
    .filter((part) => part !== "")
    .join(":");

  return {
    eventId,
    type,
    providerRef,
    ...(amountMicros !== undefined ? { amountMicros } : {}),
    ...(refundAmountMicros !== undefined ? { refundAmountMicros } : {}),
    ...(prepayId !== undefined ? { providerPaymentId: prepayId } : {}),
    // Report the currency Binance actually used so a quarantined mismatch shows
    // the admin what happened; the router needs it present to write the entry.
    currencyCode: currency ?? "USD",
    metadata: {
      bizType: envelope.bizType,
      bizId: envelope.bizIdStr ?? envelope.bizId,
      bizStatus: envelope.bizStatus,
      merchantTradeNo: data.merchantTradeNo,
      prepayId,
      binanceTransactionId: data.transactionId,
      openUserId: data.openUserId,
      totalFee: data.totalFee,
      currency: data.currency,
      commission: data.commission,
      transactTime: data.transactTime,
      tradeType: data.tradeType,
      ...(refundInfo !== undefined
        ? {
            refundRequestId: refundInfo.refundRequestId,
            refundAmount: refundInfo.refundAmount,
            refundedAmount: refundInfo.refundedAmount,
            orderAmount: refundInfo.orderAmount,
            remainingAttempts: refundInfo.remainingAttempts,
            duplicateRequest: refundInfo.duplicateRequest,
          }
        : {}),
    },
  };
}
