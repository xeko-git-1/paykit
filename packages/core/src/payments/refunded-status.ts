/**
 * How much of a payment has been returned, and what that makes the payment.
 *
 * This lived in three places and disagreed with itself. The webhook path set
 * `refunded` unconditionally, so a $1 refund of a $100 payment read downstream as
 * fully refunded — and, because the refund gate refuses further refunds on a
 * `refunded` payment, the remaining $99 became unrefundable. The admin path did
 * compare against the captured amount, and the reconciler had its own third copy.
 *
 * So the comparison lives here, once, as pure arithmetic over micros: no database,
 * no provider, nothing to mock. Callers supply the captured amount and the total
 * successfully refunded, and every path reaches the same verdict.
 */

/** The refund-derived states a payment can be in. */
export type RefundedPaymentStatus = "completed" | "partially_refunded" | "refunded";

/**
 * The status a payment should hold given what has actually been refunded.
 *
 * `refundedMicros` is the sum of refunds that SUCCEEDED — refunds still in flight
 * must not count, or a payment reads as refunded before the money has moved and a
 * later failure leaves that reading behind.
 *
 * Both arguments are non-negative micros. A refunded total at or above the
 * captured amount is `refunded` rather than an error: providers do occasionally
 * return a rounding cent more than was captured, and treating that as a defect
 * would strand the payment in `partially_refunded` forever.
 *
 * @param capturedMicros amount captured on the payment; must be > 0
 * @param refundedMicros sum of succeeded refunds; must be >= 0
 */
export function refundedPaymentStatus(
  capturedMicros: bigint,
  refundedMicros: bigint,
): RefundedPaymentStatus {
  if (refundedMicros <= 0n) return "completed";
  if (refundedMicros >= capturedMicros) return "refunded";
  return "partially_refunded";
}

/**
 * Whether a payment in `status` can still be refunded.
 *
 * `partially_refunded` deliberately can: that is the whole point of tracking it
 * separately. The amount still available is a separate question, answered under a
 * row lock by the refund gate — this only rules out the states where no refund is
 * possible at all.
 */
export function isRefundableStatus(status: string): boolean {
  return status === "completed" || status === "partially_refunded";
}
