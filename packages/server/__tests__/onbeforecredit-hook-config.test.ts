import { describe, expectTypeOf, it } from "vitest";
import type { NormalizedWebhookEvent } from "@xeko-git-1/paykit";
import type { PaykitConfig } from "../src/server/create-paykit.js";

describe("PaykitConfig onBeforeCredit hook (Phase 0b — Val Session 2 D7)", () => {
  it("PaykitConfig accepts optional onBeforeCredit hook", () => {
    expectTypeOf<PaykitConfig>().toHaveProperty("onBeforeCredit");
  });

  it("hook signature is (evt: NormalizedWebhookEvent) => Promise<void>", () => {
    type HookType = NonNullable<PaykitConfig["onBeforeCredit"]>;
    expectTypeOf<HookType>().toEqualTypeOf<(evt: NormalizedWebhookEvent) => Promise<void>>();
  });

  it("PaykitConfig accepts optional emitMetric counter", () => {
    expectTypeOf<PaykitConfig>().toHaveProperty("emitMetric");
  });

  it("V1.5/V2 consumers without onBeforeCredit remain backwards-compatible (optional field)", () => {
    type IsOptional = undefined extends PaykitConfig["onBeforeCredit"] ? true : false;
    expectTypeOf<IsOptional>().toEqualTypeOf<true>();
  });
});
