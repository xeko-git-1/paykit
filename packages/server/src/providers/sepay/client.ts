/**
 * SePay payment client — VietQR initiation + webhook signature verification.
 *
 * SePay uses bank-transfer-based QR payments (no card processing).
 * Webhook signature: HMAC-SHA256(rawPayload, secretKey) → hex digest.
 * Rotation: `secretKey` accepts string or string[]; verify tries each
 * with constant-time compare; first match wins.
 *
 * Brand prefix: defaults to "PAYKIT" — included in QR description so the
 * bank transfer's `content` field carries the orderId. Customizable via
 * `brandPrefix` config to match consumer's brand.
 */
import { createHmac } from "node:crypto";

export interface SePayConfig {
  readonly apiKey: string;
  readonly secretKey: string | readonly string[];
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankBin: string;
  readonly brandPrefix?: string;
}

export interface SePayCheckoutResult {
  readonly orderId: string;
  readonly qrUrl: string;
  readonly amount: number;
  readonly expiresAt: Date;
}

export interface SePayWebhookPayload {
  readonly id: string;
  readonly gateway: string;
  readonly transactionDate: string;
  readonly accountNumber: string;
  readonly subAccount: string | null;
  readonly code: string | null;
  readonly content: string;
  readonly transferType: "in" | "out";
  readonly description: string;
  readonly transferAmount: number;
  readonly referenceCode: string;
  readonly accumulated: number;
}

const QR_EXPIRY_MS = 30 * 60 * 1000;

export class SePayClient {
  private readonly config: SePayConfig;
  private readonly secrets: readonly string[];
  private readonly brandPrefix: string;

  constructor(config: SePayConfig) {
    this.config = config;
    this.secrets = Array.isArray(config.secretKey)
      ? (config.secretKey as readonly string[])
      : [config.secretKey as string];
    this.brandPrefix = config.brandPrefix ?? "PAYKIT";
  }

  generateQrUrl(orderId: string, amountVnd: number): SePayCheckoutResult {
    const description = `${this.brandPrefix} ${orderId}`;
    const qrUrl = `https://img.vietqr.io/image/${this.config.bankBin}-${this.config.accountNumber}-qr_only.png?amount=${amountVnd}&addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(this.config.accountName)}`;
    const expiresAt = new Date(Date.now() + QR_EXPIRY_MS);
    return { orderId, qrUrl, amount: amountVnd, expiresAt };
  }

  /**
   * Verify HMAC-SHA256 signature in constant time against any configured secret.
   * Returns true on first match; false if all fail or signature is empty/wrong-length.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (signature === "") return false;
    let matched = false;
    let validSecretChecked = false;
    for (const secret of this.secrets) {
      // An empty HMAC key yields an attacker-computable digest — skip to prevent forgery.
      if (!secret || secret.trim() === "") continue;
      validSecretChecked = true;
      const expected = createHmac("sha256", secret).update(payload).digest("hex");
      if (expected.length !== signature.length) continue;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
      }
      if (diff === 0) matched = true;
    }
    // Fail closed: if no valid secret was available, verification must not succeed.
    if (!validSecretChecked) return false;
    return matched;
  }

  /**
   * Extract order ID from SePay transfer description/content. Match is
   * case-insensitive and uses the brand prefix configured on the client.
   */
  extractOrderId(content: string): string | null {
    const escaped = this.brandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s+([A-Za-z0-9-]+)`, "i");
    const match = content.match(re);
    return match?.[1] ?? null;
  }
}

export function createSePayClient(config: SePayConfig): SePayClient {
  return new SePayClient(config);
}
