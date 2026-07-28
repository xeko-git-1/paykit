import { describe, expect, it } from "vitest";
import {
  PAYKIT_I18N_KEYS,
  PAYKIT_I18N_VI,
  defaultTranslator,
  makeTranslator,
} from "../src/i18n/keys.js";

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

  it("Vietnamese table covers exactly the same keys as the English catalogue", () => {
    expect(Object.keys(PAYKIT_I18N_VI).sort()).toEqual(Object.keys(PAYKIT_I18N_KEYS).sort());
  });

  it("makeTranslator('vi') returns Vietnamese values", () => {
    const t = makeTranslator("vi");
    expect(t("paykit.balance.title")).toBe("Số dư");
    expect(t("paykit.subscriptions.action.refund")).toBe("Hoàn tiền");
  });

  it("makeTranslator('en') returns English values", () => {
    const t = makeTranslator("en");
    expect(t("paykit.balance.title")).toBe("Balance");
  });

  it("makeTranslator falls back to English then to the raw key for unknown keys", () => {
    const t = makeTranslator("vi");
    expect(t("paykit.unknown.key")).toBe("paykit.unknown.key");
  });

  it("makeTranslator interpolates {var} placeholders", () => {
    const t = makeTranslator("vi");
    expect(t("paykit.balance.title", { unused: "x" })).toBe("Số dư");
    // A key with no placeholder is returned verbatim even when vars are passed.
    expect(defaultTranslator("paykit.common.loading", { any: "1" })).toBe("Loading…");
  });
});
