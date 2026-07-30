/**
 * The legacy `onBeforeCredit` hook adapted onto the screening contract.
 *
 * The mapping is the backward-compatibility guarantee: tenants wrote hooks whose
 * only protocol is "throw to block the credit", and that has always meant *this
 * payment is not allowed* — a terminal decision. So a throw maps to `reject`, not
 * to a retry.
 *
 * The distinction matters in the failure direction. If a throw were treated as
 * "no answer" and retried, a hook that blocks a sanctioned payment would keep
 * being asked and the payment would sit in limbo instead of being quarantined.
 * Conversely a hook must never be able to produce a credit by failing, which is
 * why there is no path from a throw to `clear`.
 */
import { describe, expect, it, vi } from "vitest";
import type { NormalizedWebhookEvent } from "../src/adapters/webhook-types.js";
import { screeningServiceFromOnBeforeCredit } from "../src/compliance/index.js";

const EVENT = {
  type: "payment.completed",
  eventId: "evt-1",
  providerRef: "prov-ref-1",
  amountMicros: "750000000",
  currencyCode: "VND",
  metadata: {},
} as unknown as Record<string, unknown>;

function request(event: Record<string, unknown> = EVENT) {
  return {
    transactionId: "a0000000-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    provider: "sepay",
    amountMicros: "750000000",
    currencyCode: "VND",
    event,
  };
}

describe("screeningServiceFromOnBeforeCredit", () => {
  it("maps a resolving hook to a clear verdict", async () => {
    const service = screeningServiceFromOnBeforeCredit(async () => {});
    await expect(service(request())).resolves.toEqual({ verdict: "clear" });
  });

  it("maps a throwing hook to reject, carrying the message as the reason", async () => {
    const service = screeningServiceFromOnBeforeCredit(async () => {
      throw new Error("sanctioned wallet");
    });
    await expect(service(request())).resolves.toEqual({
      verdict: "reject",
      reason: "sanctioned wallet",
    });
  });

  it("never resolves to clear when the hook throws", async () => {
    // The property that matters more than the exact reason string: a hook cannot
    // produce a credit by failing.
    for (const thrown of [new Error("boom"), "string failure", undefined, null]) {
      const service = screeningServiceFromOnBeforeCredit(async () => {
        throw thrown;
      });
      const decision = await service(request());
      expect(decision.verdict).not.toBe("clear");
    }
  });

  it("stringifies a non-Error throw rather than losing the reason", async () => {
    const service = screeningServiceFromOnBeforeCredit(async () => {
      throw "blocked by policy";
    });
    await expect(service(request())).resolves.toEqual({
      verdict: "reject",
      reason: "blocked by policy",
    });
  });

  it("never maps a throw to manual_review — a hook cannot request one", async () => {
    // manual_review is reserved for services that ask for a human. Routing hook
    // failures there would silently move existing tenants' blocked payments out
    // of the quarantine flow they already operate.
    const service = screeningServiceFromOnBeforeCredit(async () => {
      throw new Error("nope");
    });
    const decision = await service(request());
    expect(decision.verdict).toBe("reject");
  });

  it("passes the persisted event through to the hook unchanged", async () => {
    // The hook sees what the inline call would have seen. The event is revived
    // from JSONB, so this is the boundary where the original shape has to survive.
    const seen: NormalizedWebhookEvent[] = [];
    const service = screeningServiceFromOnBeforeCredit(async (evt) => {
      seen.push(evt);
    });
    await service(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "payment.completed",
      providerRef: "prov-ref-1",
      amountMicros: "750000000",
    });
  });

  it("calls the hook exactly once per screening", async () => {
    const hook = vi.fn(async () => {});
    const service = screeningServiceFromOnBeforeCredit(hook);
    await service(request());
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
