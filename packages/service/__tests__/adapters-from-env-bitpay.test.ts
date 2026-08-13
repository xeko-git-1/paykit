/**
 * BitPay service-mode wiring — buildAdaptersFromConfig must enable BitPay when
 * the POS token is present, build the node-crypto merchant signer when the
 * private key is configured, and fail fast at boot on a malformed key (never
 * on the first refund).
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAdaptersFromConfig } from "../src/adapters-from-env.js";
import type { ServiceConfig } from "../src/config.js";

const base: ServiceConfig = {
  databaseUrl: "postgres://localhost/paykit",
  port: 3000,
  stripe: undefined,
  sepay: undefined,
  apipay: undefined,
  nowpayments: undefined,
  cryptomus: undefined,
  binance: undefined,
  bitpay: undefined,
  coinbaseCommerce: undefined,
  vnpay: undefined,
  momo: undefined,
  zalopay: undefined,
  adminSecret: undefined,
};

function secp256k1Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return privateKey.export({ type: "sec1", format: "pem" }).toString();
}

describe("buildAdaptersFromConfig — BitPay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires the bitpay adapter when the POS token is present (no signer)", async () => {
    const adapters = await buildAdaptersFromConfig({
      ...base,
      bitpay: { apiToken: "pos-token", environment: "sandbox" },
    });
    const bitpay = adapters.find((a) => a.id === "bitpay");
    expect(bitpay).toBeDefined();
    // Signer-less deployment: refund must fail loudly rather than pretend.
    const refund = await bitpay!.refund({
      transactionId: "tx1",
      providerRef: "invoice1",
      amountMicros: 1_000_000n,
      reason: "test",
      idempotencyKey: "idem-1",
    });
    expect(refund.state).toBe("failed");
    expect(refund.error?.providerCode).toBe("NO_MERCHANT_SIGNER");
  });

  it("wires the merchant signer when a private key is configured", async () => {
    // Capture the outbound refund request instead of letting it hit the network.
    const seen: Array<{ url: string; identity?: string; signature?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          identity: headers.get("x-identity") ?? undefined,
          signature: headers.get("x-signature") ?? undefined,
        });
        return new Response(JSON.stringify({ data: { id: "r1", status: "pending" } }), {
          status: 200,
        });
      }),
    );

    const adapters = await buildAdaptersFromConfig({
      ...base,
      bitpay: {
        apiToken: "pos-token",
        environment: "sandbox",
        merchantPrivateKey: secp256k1Pem(),
      },
    });
    const bitpay = adapters.find((a) => a.id === "bitpay");
    expect(bitpay).toBeDefined();

    const refund = await bitpay!.refund({
      transactionId: "tx1",
      providerRef: "invoice1",
      amountMicros: 1_000_000n,
      reason: "test",
      idempotencyKey: "idem-1",
    });
    expect(refund.error?.providerCode).not.toBe("NO_MERCHANT_SIGNER");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://test.bitpay.com/refunds");
    // The wired signer produced BitPay's merchant-facade headers.
    expect(seen[0]!.identity).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(seen[0]!.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("fails at boot on a malformed private key", async () => {
    await expect(
      buildAdaptersFromConfig({
        ...base,
        bitpay: {
          apiToken: "pos-token",
          environment: "sandbox",
          merchantPrivateKey: "not-a-key",
        },
      }),
    ).rejects.toThrow();
  });

  it("does not wire bitpay when no creds present", async () => {
    const adapters = await buildAdaptersFromConfig(base);
    expect(adapters.map((a) => a.id)).not.toContain("bitpay");
  });
});
