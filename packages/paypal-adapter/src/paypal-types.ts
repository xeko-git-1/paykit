/**
 * The slices of PayPal's Orders v2 / Payments v2 / Transaction Search
 * resources this adapter reads. Every field is optional: these are untrusted
 * wire shapes, and each reader checks what it relies on.
 */

export interface PaypalMoney {
  readonly currency_code?: string;
  readonly value?: string;
}

export interface PaypalLink {
  readonly href?: string;
  readonly rel?: string;
}

export interface PaypalCapture {
  readonly id?: string;
  /** COMPLETED | DECLINED | PARTIALLY_REFUNDED | PENDING | REFUNDED | FAILED */
  readonly status?: string;
  readonly amount?: PaypalMoney;
  readonly custom_id?: string;
  readonly supplementary_data?: { readonly related_ids?: { readonly order_id?: string } };
  readonly links?: readonly PaypalLink[];
}

export interface PaypalPurchaseUnit {
  readonly custom_id?: string;
  readonly amount?: PaypalMoney;
  readonly payments?: { readonly captures?: readonly PaypalCapture[] };
}

export interface PaypalOrder {
  readonly id?: string;
  /** CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED */
  readonly status?: string;
  readonly purchase_units?: readonly PaypalPurchaseUnit[];
  readonly links?: readonly PaypalLink[];
}

export interface PaypalRefund {
  readonly id?: string;
  /** CANCELLED | FAILED | PENDING | COMPLETED */
  readonly status?: string;
  readonly amount?: PaypalMoney;
  readonly custom_id?: string;
  readonly links?: readonly PaypalLink[];
}

export interface PaypalWebhookEnvelope {
  readonly id?: string;
  readonly event_type?: string;
  readonly resource?: { readonly id?: unknown };
}

export interface PaypalSearchRow {
  readonly transaction_info?: {
    readonly transaction_id?: string;
    readonly transaction_event_code?: string;
    /** S = success, P = pending, D = denied, V = reversed, F = partially refunded */
    readonly transaction_status?: string;
    readonly transaction_amount?: PaypalMoney;
    readonly custom_field?: string;
  };
}

export interface PaypalSearchResponse {
  readonly transaction_details?: readonly PaypalSearchRow[];
  readonly total_pages?: number;
  readonly last_refreshed_datetime?: string;
}
