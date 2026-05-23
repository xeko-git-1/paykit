/**
 * ProviderRegistry — instance-per-paykit (NOT global singleton).
 *
 * Each createPaykit() call constructs its own registry from the adapter array.
 * Asserts unique `id` at register-time (throws on collision). Forbidden chars
 * in id: `/`, `?`, `#`, ` ` — id appears in webhook URL `/webhooks/{id}`.
 *
 * Multi-instance pattern: 'stripe:eu', 'stripe:us' — colons allowed.
 */
import type { PaymentProviderAdapter } from "./adapter.js";

const FORBIDDEN_ID_CHARS = /[\/\s?#]/;

export class ProviderRegistry {
  private readonly adapters: PaymentProviderAdapter[] = [];
  private readonly byId = new Map<string, PaymentProviderAdapter>();

  register(adapter: PaymentProviderAdapter): void {
    if (!adapter.id || adapter.id.length === 0) {
      throw new Error("ProviderRegistry: invalid adapter id (empty)");
    }
    if (FORBIDDEN_ID_CHARS.test(adapter.id)) {
      throw new Error(
        `ProviderRegistry: invalid adapter id '${adapter.id}' — must not contain /, ?, #, or whitespace`,
      );
    }
    if (this.byId.has(adapter.id)) {
      throw new Error(`ProviderRegistry: adapter id '${adapter.id}' already registered`);
    }
    this.byId.set(adapter.id, adapter);
    this.adapters.push(adapter);
  }

  get(id: string): PaymentProviderAdapter | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): readonly PaymentProviderAdapter[] {
    return this.adapters;
  }

  size(): number {
    return this.adapters.length;
  }
}
