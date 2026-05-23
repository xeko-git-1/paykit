/**
 * i18n key catalogue with English fallback strings.
 *
 * Paykit ships keys but no translations — consumers wire next-intl / i18next /
 * react-intl by passing a `t(key)` prop to every component.
 *
 * This file is the canonical source of paykit string keys. Consumer's i18n
 * loader can use it to assert key coverage at build time.
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
} as const;

export type PaykitI18nKey = keyof typeof PAYKIT_I18N_KEYS;

export type Translator = (key: string, vars?: Record<string, string>) => string;

/** Minimal English-only translator — useful for tests and as a fallback. */
export function defaultTranslator(key: string, _vars?: Record<string, string>): string {
  const k = key as PaykitI18nKey;
  return PAYKIT_I18N_KEYS[k] ?? key;
}
