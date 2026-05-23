// Adapter contract barrel — V1.5 adapter registry pattern.
export type { PaymentProviderAdapter } from "./adapter.js";
export type {
  CheckoutMode,
  CheckoutResult,
  CreateCheckoutInput,
} from "./checkout-types.js";
export type { ProviderTxnRecord } from "./provider-txn-record.js";
export type {
  RefundInput,
  RefundResult,
  RefundState,
} from "./refund-types.js";
export type {
  NormalizedWebhookEvent,
  WebhookEventType,
} from "./webhook-types.js";
export { ProviderRegistry } from "./registry.js";
