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
  PAYKIT_I18N_KEYS,
  type PaykitI18nKey,
  defaultTranslator,
  type Translator,
} from "./i18n/keys.js";
export { formatMicros } from "./lib/format-money.js";

export const PAYKIT_REACT_VERSION = "0.1.0-alpha.1";
