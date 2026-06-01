/**
 * CLI bootstrap tests — operator path for merchant create, apikey mint, jwt mint.
 *
 * Verifies the invariants that make the bootstrap safe and consistent with the
 * HTTP plane: scope validation, per-merchant cap (F10), created_by attribution,
 * and a jwt that verifies against the same secret the service loads.
 */
import { verify } from "hono/jwt";
import { JWT_AUDIENCE, JWT_ISSUER } from "@vibecc/paykit-server";
import { describe, expect, it } from "vitest";
import { createMerchant, mintJwt, mintKey } from "../src/lib/bootstrap.js";
import { createInMemoryDb, createInMemoryStore } from "./helpers/in-memory-paykit-db.js";

describe("bootstrap: merchant create", () => {
  it("creates a merchant and returns its id", async () => {
    const store = createInMemoryStore();
    const db = createInMemoryDb(store);
    const { merchantId } = await createMerchant(db, "Acme Co");
    expect(merchantId).toBeTruthy();
    expect(store.merchants).toHaveLength(1);
    expect(store.merchants[0]!.name).toBe("Acme Co");
  });

  it("rejects an empty name", async () => {
    const db = createInMemoryDb(createInMemoryStore());
    await expect(createMerchant(db, "   ")).rejects.toThrow(/empty/);
  });
});

describe("bootstrap: apikey mint", () => {
  function seededDb() {
    const store = createInMemoryStore({
      merchants: [{ merchantId: "m-1", name: "Acme", status: "active" }],
    });
    return { store, db: createInMemoryDb(store) };
  }

  it("mints a key with valid scopes, prefixed pk_, and records created_by", async () => {
    const { store, db } = seededDb();
    const res = await mintKey(db, {
      merchantId: "m-1",
      scopes: ["checkout:write", "balance:read"],
      mode: "live",
    });
    expect(res.plaintext).toMatch(/^pk_live_/);
    expect(res.scopes).toEqual(["checkout:write", "balance:read"]);
    expect(store.api_keys).toHaveLength(1);
    expect(store.api_keys[0]!.createdBy).toBe("cli:operator");
  });

  it("rejects unknown scopes (deny-by-default)", async () => {
    const { db } = seededDb();
    await expect(
      mintKey(db, { merchantId: "m-1", scopes: ["checkout:write", "bogus:scope"], mode: "live" }),
    ).rejects.toThrow(/unknown scope/);
  });

  it("rejects when the merchant does not exist", async () => {
    const db = createInMemoryDb(createInMemoryStore());
    await expect(
      mintKey(db, { merchantId: "missing", scopes: ["checkout:write"], mode: "live" }),
    ).rejects.toThrow(/merchant not found/);
  });

  it("enforces the per-merchant active-key cap (F10, same as HTTP)", async () => {
    const store = createInMemoryStore({
      merchants: [{ merchantId: "m-1", name: "Acme", status: "active" }],
      api_keys: Array.from({ length: 10 }, (_, i) => ({
        keyId: `k-${i}`,
        merchantId: "m-1",
        keyHash: `h-${i}`,
        keyPrefix: "pk_live_x",
        mode: "live",
        scopes: ["checkout:write"],
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      })),
    });
    const db = createInMemoryDb(store);
    await expect(
      mintKey(db, { merchantId: "m-1", scopes: ["checkout:write"], mode: "live" }),
    ).rejects.toThrow(/max 10/);
  });
});

describe("bootstrap: jwt mint", () => {
  it("mints an admin JWT that verifies against the seeded runtime_config secret", async () => {
    const store = createInMemoryStore({
      merchants: [{ merchantId: "m-1", name: "Acme", status: "active" }],
    });
    const db = createInMemoryDb(store);

    const { token } = await mintJwt(db, { merchantId: "m-1", ttlSeconds: 900 });

    // The loader seeds the secret into runtime_config on first call.
    const secretRow = store.runtime_config.find((r) => r.key === "jwt_signing_secret");
    expect(secretRow).toBeDefined();

    const payload = (await verify(token, secretRow!.value as string, "HS256")) as Record<
      string,
      unknown
    >;
    expect(payload.iss).toBe(JWT_ISSUER);
    expect(payload.aud).toBe(JWT_AUDIENCE);
    expect(payload.sub).toBe("m-1");
    expect(payload.scopes).toContain("key:manage");
  });

  it("rejects a non-positive ttl", async () => {
    const store = createInMemoryStore({
      merchants: [{ merchantId: "m-1", name: "Acme", status: "active" }],
    });
    const db = createInMemoryDb(store);
    await expect(mintJwt(db, { merchantId: "m-1", ttlSeconds: 0 })).rejects.toThrow(/ttl/);
  });
});
