/**
 * CheckoutMode — how the checkout flow is presented to end-user.
 *
 * - 'redirect': consumer redirects user to provider-hosted page (Stripe Checkout, VNPay portal)
 * - 'qr': consumer renders a QR code for cross-device or scan-from-bank-app (SePay VietQR)
 * - 'deeplink': consumer opens provider's mobile app via custom URL scheme (Momo, ZaloPay)
 *
 * Adapters MAY support combinations — e.g., Momo returns webUrl + mobileDeeplink + qrUrl.
 * `checkoutMode` indicates the PRIMARY mode for the adapter.
 */
export type CheckoutMode = "redirect" | "qr" | "deeplink";

import type { CurrencyCode } from "../types/money.js";

export interface CreateCheckoutInput {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly amountMicros: bigint;
  readonly currencyCode: CurrencyCode;
  readonly returnUrl?: string;
  readonly ipnUrl?: string;
  readonly customerEmail?: string;
  readonly orderInfo?: string;
}

export interface CheckoutResult {
  readonly webUrl: string;
  readonly expiresAt: Date;
  readonly mobileDeeplink?: string;
  readonly qrUrl?: string;
  readonly providerSessionId?: string;
}
