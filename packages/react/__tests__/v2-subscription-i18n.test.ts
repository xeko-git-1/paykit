import { describe, expect, it } from "vitest";
import { PAYKIT_I18N_KEYS } from "../src/i18n/keys.js";

describe("V2 subscription i18n keys (Phase 08)", () => {
  it("declares 10 subscription keys", () => {
    const subKeys = Object.keys(PAYKIT_I18N_KEYS).filter((k) =>
      k.startsWith("paykit.subscriptions."),
    );
    expect(subKeys.length).toBeGreaterThanOrEqual(10);
  });

  it("includes status filter labels", () => {
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.title"]).toBeTruthy();
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.filter.all"]).toBeTruthy();
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.filter.statusLabel"]).toBeTruthy();
  });

  it("includes per-row action labels", () => {
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.action.cancel"]).toBe("Cancel");
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.action.upgrade"]).toBe("Upgrade");
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.action.refund"]).toBe("Refund");
  });

  it("includes refund modal labels (RT F12)", () => {
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.refund.title"]).toBe("Refund invoice");
    expect(PAYKIT_I18N_KEYS["paykit.subscriptions.refund.confirm"]).toBe("Confirm refund");
  });
});
