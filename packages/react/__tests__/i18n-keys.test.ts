import { describe, expect, it } from "vitest";
import { PAYKIT_I18N_KEYS, defaultTranslator } from "../src/i18n/keys.js";

describe("paykit-react i18n key catalogue", () => {
  it("exports key catalogue with English fallbacks", () => {
    expect(PAYKIT_I18N_KEYS["paykit.balance.title"]).toBe("Balance");
    expect(PAYKIT_I18N_KEYS["paykit.common.loading"]).toBe("Loading…");
    expect(PAYKIT_I18N_KEYS["paykit.admin.tab.transactions"]).toBe("Transactions");
  });

  it("includes 4 admin tab labels", () => {
    expect(PAYKIT_I18N_KEYS["paykit.admin.tab.transactions"]).toBeTruthy();
    expect(PAYKIT_I18N_KEYS["paykit.admin.tab.ledger"]).toBeTruthy();
    expect(PAYKIT_I18N_KEYS["paykit.admin.tab.webhooks"]).toBeTruthy();
    expect(PAYKIT_I18N_KEYS["paykit.admin.tab.reconciliation"]).toBeTruthy();
  });

  it("defaultTranslator returns English value", () => {
    expect(defaultTranslator("paykit.balance.title")).toBe("Balance");
  });

  it("defaultTranslator returns key as fallback for unknown key", () => {
    expect(defaultTranslator("paykit.unknown.key")).toBe("paykit.unknown.key");
  });
});
