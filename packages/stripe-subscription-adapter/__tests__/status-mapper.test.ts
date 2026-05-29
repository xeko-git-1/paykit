import { describe, expect, it } from "vitest";
import { mapStripeStatus } from "../src/status-mapper.js";

describe("mapStripeStatus — 8 known Stripe statuses (RT F3)", () => {
  const known = [
    ["active", "active"],
    ["trialing", "trialing"],
    ["past_due", "past_due"],
    ["canceled", "canceled"],
    ["incomplete", "incomplete"],
    ["unpaid", "unpaid"],
    ["incomplete_expired", "incomplete_expired"],
    ["paused", "paused"],
  ] as const;

  for (const [stripe, paykit] of known) {
    it(`maps ${stripe} → ${paykit} (no fallback)`, () => {
      const r = mapStripeStatus(stripe);
      expect(r.status).toBe(paykit);
      expect(r.fallback).toBe(false);
      expect(r.raw).toBe(stripe);
    });
  }
});

describe("mapStripeStatus — unknown status fallback (RT F3)", () => {
  it("falls back to 'unpaid' and flags fallback=true so observability can alert", () => {
    const r = mapStripeStatus("trial_will_end_soon");
    expect(r.status).toBe("unpaid");
    expect(r.fallback).toBe(true);
    expect(r.raw).toBe("trial_will_end_soon");
  });

  it("retains the raw value for STATUS_UNKNOWN log payload", () => {
    const r = mapStripeStatus("future_state_v3");
    expect(r.raw).toBe("future_state_v3");
  });
});
