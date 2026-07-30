/**
 * Adapts the original `onBeforeCredit` hook onto the `ScreeningService` contract.
 *
 * The hook's protocol is "throw to block the credit", which conflates two
 * outcomes the screening step has to tell apart: *this payment is not allowed*
 * and *I could not find out*. Existing tenants wrote hooks that throw for the
 * first case only, so that is the meaning preserved here: a throw maps to
 * `reject`, i.e. quarantine, terminal, no retry — the behaviour those hooks
 * already produce today.
 *
 * A hook cannot therefore express "retry me later". Tenants that need retry on an
 * inconclusive screening should supply a `ScreeningService` directly and throw
 * `ScreeningUnavailableError` from it.
 */

import type { NormalizedWebhookEvent } from "../adapters/webhook-types.js";
import type {
  ScreeningDecision,
  ScreeningRequest,
  ScreeningService,
} from "./screening-contract.js";

/** The legacy hook shape: resolves to allow the credit, throws to block it. */
export type OnBeforeCreditHook = (event: NormalizedWebhookEvent) => Promise<void>;

/**
 * `event` is the normalized event as it was persisted with the job, so the hook
 * sees the same payload the inline call would have received. It is revived from
 * JSONB, hence the cast at this boundary: the shape was written from a
 * `NormalizedWebhookEvent` and the column is paykit-owned, not caller input.
 */
export function screeningServiceFromOnBeforeCredit(hook: OnBeforeCreditHook): ScreeningService {
  return async (request: ScreeningRequest): Promise<ScreeningDecision> => {
    try {
      await hook(request.event as unknown as NormalizedWebhookEvent);
      return { verdict: "clear" };
    } catch (err) {
      return {
        verdict: "reject",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
