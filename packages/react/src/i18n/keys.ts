/**
 * i18n key catalogue with built-in English + Vietnamese strings.
 *
 * Paykit ships keys AND two bundled locales (en, vi). Consumers can either wire
 * their own i18n stack (next-intl / i18next / react-intl) by passing a `t(key)`
 * prop, or use the bundled `makeTranslator(locale)` for a zero-dependency
 * translator that covers the two first-class locales.
 *
 * PAYKIT_I18N_KEYS remains the canonical key list with English values — it is
 * the source of truth for key coverage, and every bundled locale must define
 * exactly the same keys (guarded by a test). Consumers can assert coverage of
 * their own translations against it at build time.
 */

export const PAYKIT_I18N_KEYS = {
  // Common
  "paykit.common.loading": "Loading…",
  "paykit.common.error": "Something went wrong",
  "paykit.common.empty": "No records yet",

  // Balance widget
  "paykit.balance.title": "Balance",
  "paykit.balance.currency.usd": "USD",
  "paykit.balance.currency.vnd": "VND",

  // Admin panel
  "paykit.admin.tab.transactions": "Transactions",
  "paykit.admin.tab.ledger": "Ledger",
  "paykit.admin.tab.webhooks": "Webhook events",
  "paykit.admin.tab.reconciliation": "Reconciliation",

  // Subscription panel (V2 Phase 08)
  "paykit.subscriptions.title": "Subscriptions",
  "paykit.subscriptions.filter.all": "All",
  "paykit.subscriptions.filter.statusLabel": "Status",
  "paykit.subscriptions.action.cancel": "Cancel",
  "paykit.subscriptions.action.upgrade": "Upgrade",
  "paykit.subscriptions.action.refund": "Refund",
  "paykit.subscriptions.cancel.atPeriodEndLabel": "At period end",
  "paykit.subscriptions.upgrade.priceIdLabel": "New price id",
  "paykit.subscriptions.refund.title": "Refund invoice",
  "paykit.subscriptions.refund.confirm": "Confirm refund",
} as const;

export type PaykitI18nKey = keyof typeof PAYKIT_I18N_KEYS;

/** Bundled Vietnamese strings — must cover exactly the same keys as the English catalogue. */
export const PAYKIT_I18N_VI: Record<PaykitI18nKey, string> = {
  // Common
  "paykit.common.loading": "Đang tải…",
  "paykit.common.error": "Đã có lỗi xảy ra",
  "paykit.common.empty": "Chưa có dữ liệu",

  // Balance widget
  "paykit.balance.title": "Số dư",
  "paykit.balance.currency.usd": "USD",
  "paykit.balance.currency.vnd": "VNĐ",

  // Admin panel
  "paykit.admin.tab.transactions": "Giao dịch",
  "paykit.admin.tab.ledger": "Sổ cái",
  "paykit.admin.tab.webhooks": "Sự kiện webhook",
  "paykit.admin.tab.reconciliation": "Đối soát",

  // Subscription panel
  "paykit.subscriptions.title": "Gói đăng ký",
  "paykit.subscriptions.filter.all": "Tất cả",
  "paykit.subscriptions.filter.statusLabel": "Trạng thái",
  "paykit.subscriptions.action.cancel": "Hủy",
  "paykit.subscriptions.action.upgrade": "Nâng cấp",
  "paykit.subscriptions.action.refund": "Hoàn tiền",
  "paykit.subscriptions.cancel.atPeriodEndLabel": "Vào cuối kỳ",
  "paykit.subscriptions.upgrade.priceIdLabel": "Mã giá mới",
  "paykit.subscriptions.refund.title": "Hoàn tiền hóa đơn",
  "paykit.subscriptions.refund.confirm": "Xác nhận hoàn tiền",
};

/** First-class bundled locales. Consumers may still supply their own `t(key)`. */
export type PaykitLocale = "en" | "vi";

const BUNDLED_LOCALES: Record<PaykitLocale, Record<PaykitI18nKey, string>> = {
  en: PAYKIT_I18N_KEYS,
  vi: PAYKIT_I18N_VI,
};

export type Translator = (key: string, vars?: Record<string, string>) => string;

/** Substitute {var} placeholders from a vars map. Leaves unknown placeholders intact. */
function interpolate(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
}

/**
 * Build a translator over a bundled locale. Falls back to the English value,
 * then to the raw key, so a missing translation degrades to readable text
 * rather than a blank. Supports {var} interpolation.
 */
export function makeTranslator(locale: PaykitLocale = "en"): Translator {
  const table = BUNDLED_LOCALES[locale] ?? PAYKIT_I18N_KEYS;
  return (key: string, vars?: Record<string, string>): string => {
    const k = key as PaykitI18nKey;
    const value = table[k] ?? PAYKIT_I18N_KEYS[k] ?? key;
    return interpolate(value, vars);
  };
}

/** Minimal English-only translator — useful for tests and as a fallback. */
export function defaultTranslator(key: string, vars?: Record<string, string>): string {
  const k = key as PaykitI18nKey;
  const value = PAYKIT_I18N_KEYS[k] ?? key;
  return interpolate(value, vars);
}
