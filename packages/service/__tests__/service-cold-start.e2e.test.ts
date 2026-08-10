import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Service cold-start e2e (F14) — exercises the real operability path against a
 * live Postgres: migrate up → CLI bootstrap (merchant + key) → buildServiceApp
 * → authenticated /v1 calls. This is the gap the 800+ mock-DB unit tests cannot
 * cover (they never run migrations or a real Drizzle handle).
 *
 * Gated by PAYKIT_E2E_DATABASE_URL: skips locally, runs in CI where a
 * postgres:16 service is provisioned. Uses a stub adapter for the checkout HTTP
 * contract (real provider creds belong to manual sandbox runs, not CI).
 */
import type { PaymentProviderAdapter } from "@xeko-git-1/paykit";
import { migrateUp } from "@xeko-git-1/paykit-cli";
import { createMerchant, mintKey } from "@xeko-git-1/paykit-cli";
import { type DbClient, paykitDbSchema } from "@xeko-git-1/paykit-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServiceApp } from "../src/main.js";

const E2E_DB = process.env.PAYKIT_E2E_DATABASE_URL;
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "migrations");

// Stub adapter: satisfies the checkout HTTP contract without real SePay creds.
function stubSepayAdapter(): PaymentProviderAdapter {
  return {
    id: "sepay",
    supportedCurrencies: ["VND"],
    checkoutMode: "qr" as const,
    createCheckout: async () => ({
      providerSessionId: "e2e-stub-session",
      webUrl: "https://sandbox.sepay.vn/pay/e2e",
      qrUrl: "https://sandbox.sepay.vn/qr/e2e",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    parseWebhookPayload: async () => null,
    verifyWebhookSignature: async () => true,
    refund: async () => ({ state: "unsupported" as const, reason: "stub" }),
    fetchTransactions: async () => [],
  };
}

const maybe = E2E_DB ? describe : describe.skip;

maybe("service cold-start e2e (real Postgres)", () => {
  let pool: Pool;
  let db: DbClient;
  let merchantId: string;
  let apiKey: string;

  beforeAll(async () => {
    // 1. Migrate a fresh schema to HEAD using the real runner.
    const client = new Client({ connectionString: E2E_DB });
    await client.connect();
    const manifest = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "manifest.json"), "utf8"));
    const result = await migrateUp(client, manifest, MIGRATIONS_DIR);
    await client.end();
    expect(result.skipped).toBe(false);

    // 2. Real Drizzle handle WITH schema (relational query API must work).
    pool = new Pool({ connectionString: E2E_DB });
    db = drizzle(pool, { schema: paykitDbSchema }) as unknown as DbClient;

    // 3. CLI bootstrap: merchant + key with checkout + balance scopes.
    const m = await createMerchant(db, "E2E Merchant");
    merchantId = m.merchantId;
    const minted = await mintKey(db, {
      merchantId,
      scopes: ["checkout:write", "balance:read"],
      mode: "test",
    });
    apiKey = minted.plaintext;
    expect(apiKey).toMatch(/^pk_test_/);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  function app() {
    return buildServiceApp({
      db,
      providers: [stubSepayAdapter()],
      jwtSecretLoader: async () => "e2e-secret-that-is-at-least-32-bytes-long!!",
      pool,
    });
  }

  it("authenticated checkout with SePay amountVnd returns 2xx + typed DTO", async () => {
    const a = await app();
    const res = await a.request(
      new Request("http://localhost/v1/checkouts", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "sepay", amountVnd: 50_000 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiVersion).toBe("2026-05-31");
    expect(body.data.provider).toBe("sepay");
    expect(body.data.transactionId).toBeTruthy();
    expect(body.data.webUrl).toContain("sepay");
  });

  it("balances endpoint works against the real relational query API (db.query)", async () => {
    const a = await app();
    const res = await a.request(
      new Request("http://localhost/v1/balances", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("missing scope → 403", async () => {
    // Mint a key WITHOUT balance:read, then hit /v1/balances.
    const limited = await mintKey(db, {
      merchantId,
      scopes: ["checkout:write"],
      mode: "test",
    });
    const a = await app();
    const res = await a.request(
      new Request("http://localhost/v1/balances", {
        headers: { Authorization: `Bearer ${limited.plaintext}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("no key → 401", async () => {
    const a = await app();
    const res = await a.request(new Request("http://localhost/v1/balances"));
    expect(res.status).toBe(401);
  });
});
