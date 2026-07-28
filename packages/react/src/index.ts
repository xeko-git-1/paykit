// @vibecc/paykit-react — admin UI components. Tailwind classes, t(key) i18n.

export {
  PaykitAdminPanel,
  type PaykitAdminPanelProps,
} from "./components/admin-panel/PaykitAdminPanel.js";
export {
  type BalanceRow,
  PaykitBalanceWidget,
  type PaykitBalanceWidgetProps,
} from "./components/balance-widget/PaykitBalanceWidget.js";
export {
  CancelButton,
  type CancelButtonProps,
  RefundModal,
  type RefundModalProps,
  SubscriptionPanel,
  type SubscriptionPanelFetchClient,
  type SubscriptionPanelProps,
  type SubscriptionRow,
  type SubscriptionStatusFilter,
  SubscriptionTable,
  type SubscriptionTableProps,
  UpgradeModal,
  type UpgradeModalProps,
} from "./components/subscriptions/index.js";
export {
  PAYKIT_I18N_KEYS,
  PAYKIT_I18N_VI,
  type PaykitI18nKey,
  type PaykitLocale,
  defaultTranslator,
  makeTranslator,
  type Translator,
} from "./i18n/keys.js";
export { formatMicros } from "./lib/format-money.js";

export const PAYKIT_REACT_VERSION = "0.2.0-alpha.1";
