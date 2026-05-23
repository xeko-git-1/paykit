import { describe, expect, it, vi } from "vitest";
import type { PaymentProviderAdapter } from "../src/adapters/adapter.js";
import { ProviderRegistry } from "../src/adapters/registry.js";

function fakeAdapter(id: string): PaymentProviderAdapter {
  return {
    id,
    displayName: id,
    supportedCurrencies: ["USD"],
    checkoutMode: "redirect",
    createCheckout: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    parseWebhookPayload: vi.fn(),
    refund: vi.fn(),
    fetchTransactions: vi.fn(),
  } as unknown as PaymentProviderAdapter;
}

describe("ProviderRegistry uniqueness", () => {
  it("registers an adapter and retrieves it by id", () => {
    const r = new ProviderRegistry();
    const a = fakeAdapter("stripe");
    r.register(a);
    expect(r.get("stripe")).toBe(a);
    expect(r.has("stripe")).toBe(true);
  });

  it("throws when a duplicate id is registered", () => {
    const r = new ProviderRegistry();
    r.register(fakeAdapter("stripe"));
    expect(() => r.register(fakeAdapter("stripe"))).toThrow(/already registered/i);
  });

  it("allows multiple distinct ids (e.g., multi-instance via 'stripe:eu')", () => {
    const r = new ProviderRegistry();
    r.register(fakeAdapter("stripe"));
    r.register(fakeAdapter("stripe:eu"));
    expect(r.list()).toHaveLength(2);
  });

  it("rejects ids containing forbidden URL chars (/, ?, #, space)", () => {
    const r = new ProviderRegistry();
    expect(() => r.register(fakeAdapter("bad/id"))).toThrow(/invalid/i);
    expect(() => r.register(fakeAdapter("bad id"))).toThrow(/invalid/i);
    expect(() => r.register(fakeAdapter("bad?id"))).toThrow(/invalid/i);
    expect(() => r.register(fakeAdapter(""))).toThrow(/invalid/i);
  });
});

describe("ProviderRegistry list ordering", () => {
  it("returns adapters in registration order", () => {
    const r = new ProviderRegistry();
    r.register(fakeAdapter("stripe"));
    r.register(fakeAdapter("sepay"));
    r.register(fakeAdapter("vnpay"));
    expect(r.list().map((a) => a.id)).toEqual(["stripe", "sepay", "vnpay"]);
  });
});

describe("ProviderRegistry get missing", () => {
  it("returns undefined for unknown id", () => {
    const r = new ProviderRegistry();
    expect(r.get("unknown")).toBeUndefined();
    expect(r.has("unknown")).toBe(false);
  });
});
