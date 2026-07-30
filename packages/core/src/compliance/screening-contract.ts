/**
 * Compliance screening contract.
 *
 * A tenant plugs in a sanctions/AML screening service (Chainalysis, TRM, Elliptic)
 * and paykit asks it whether a received payment may be credited. The call is an
 * outbound HTTP request to a third party, so its latency is unbounded from
 * paykit's point of view — which is exactly why it is modelled as its own step
 * with an explicit verdict rather than as a hook that throws.
 *
 * The three verdicts are deliberately distinct because they lead to three
 * different places:
 *   - `clear`         → credit the payment.
 *   - `reject`        → quarantine; terminal, no retry (the answer will not change).
 *   - `manual_review` → quarantine and surface for a human; also no retry.
 *
 * An *inconclusive* screening is not a verdict and has no member here: the
 * service throwing (timeout, 5xx, unusable body) means paykit does not know, so
 * the job is retried. Absence of an answer must never read as permission —
 * mapping a failed call to `clear` is how a sanctioned payment gets credited
 * during an outage.
 */

/** Verdict a screening service returns for one payment. */
export type ScreeningDecision =
  | { readonly verdict: "clear"; readonly reason?: string }
  | { readonly verdict: "reject"; readonly reason: string }
  | { readonly verdict: "manual_review"; readonly reason: string };

/** What the screening service is told about the payment being screened. */
export interface ScreeningRequest {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly amountMicros: string;
  readonly currencyCode: string;
  /** The normalized provider event, as captured when the payment arrived. */
  readonly event: Record<string, unknown>;
}

/**
 * Tenant-supplied screening service.
 *
 * Throwing is the correct way to signal "no answer" — it holds the payment and
 * schedules a retry. Implementations should apply their own timeout; paykit also
 * bounds the call so a service that never returns cannot stall the queue.
 */
export type ScreeningService = (request: ScreeningRequest) => Promise<ScreeningDecision>;
