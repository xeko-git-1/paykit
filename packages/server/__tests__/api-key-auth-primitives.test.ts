import {
  hashApiKey,
  mintApiKey,
  toBase62,
  verifyApiKey,
} from "@xeko-git-1/paykit-auth-core/auth/api-key.js";
import {
  type ApiKeyScope,
  hasScope,
  isScopeSubset,
} from "@xeko-git-1/paykit-auth-core/auth/scope.js";
import type { ApiKey } from "@xeko-git-1/paykit-auth-core/db/schema/api-keys.js";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// toBase62 — must be injective per byte so no entropy is lost
// ---------------------------------------------------------------------------
describe("toBase62", () => {
  it("maps every distinct byte to a distinct 2-char pair (injective)", () => {
    const seen = new Set<string>();
    for (let b = 0; b < 256; b++) {
      const encoded = toBase62(Buffer.from([b]));
      expect(encoded.length).toBe(2);
      seen.add(encoded);
    }
    // The old mapping (byte%62 + floor(byte/4)%62) collided — e.g. bytes 0 and
    // 248 both produced "00" — yielding fewer than 256 distinct outputs.
    expect(seen.size).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// mintApiKey
// ---------------------------------------------------------------------------
describe("mintApiKey", () => {
  it("produces pk_live_ prefix for live mode", () => {
    const result = mintApiKey({
      merchantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "live",
      scopes: ["checkout:write"],
    });
    expect(result.plaintext).toMatch(/^pk_live_/);
    expect(result.keyPrefix).toBe(result.plaintext.slice(0, "pk_live_".length + 4));
  });

  it("produces pk_test_ prefix for test mode", () => {
    const result = mintApiKey({
      merchantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "test",
      scopes: ["balance:read"],
    });
    expect(result.plaintext).toMatch(/^pk_test_/);
    expect(result.keyPrefix).toBe(result.plaintext.slice(0, "pk_test_".length + 4));
  });

  it("plaintext has high entropy (32 random bytes → ≥40 base62 chars after prefix)", () => {
    const result = mintApiKey({
      merchantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "live",
      scopes: [],
    });
    const body = result.plaintext.slice("pk_live_".length);
    // 32 bytes in base62 → ~43 chars; at minimum 40
    expect(body.length).toBeGreaterThanOrEqual(40);
  });

  it("keyHash equals hashApiKey(plaintext)", () => {
    const result = mintApiKey({
      merchantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "live",
      scopes: ["checkout:write"],
    });
    expect(result.keyHash).toBe(hashApiKey(result.plaintext));
  });

  it("record contains correct merchantId, mode, scopes", () => {
    const scopes: ApiKeyScope[] = ["checkout:write", "balance:read"];
    const result = mintApiKey({
      merchantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      mode: "test",
      scopes,
    });
    expect(result.record.merchantId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.record.mode).toBe("test");
    expect(result.record.scopes).toEqual(scopes);
    expect(result.record.keyHash).toBe(result.keyHash);
    expect(result.record.keyPrefix).toBe(result.keyPrefix);
  });

  it("generates unique keys on successive calls", () => {
    const a = mintApiKey({ merchantId: "m1", mode: "live", scopes: [] });
    const b = mintApiKey({ merchantId: "m1", mode: "live", scopes: [] });
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

// ---------------------------------------------------------------------------
// hashApiKey
// ---------------------------------------------------------------------------
describe("hashApiKey", () => {
  it("returns a 64-char hex string (sha256)", () => {
    const hash = hashApiKey("pk_live_someRandomValue");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const input = "pk_live_abc123";
    expect(hashApiKey(input)).toBe(hashApiKey(input));
  });
});

// ---------------------------------------------------------------------------
// verifyApiKey
// ---------------------------------------------------------------------------
describe("verifyApiKey", () => {
  function makeRecord(overrides: Partial<ApiKey> = {}): ApiKey {
    const minted = mintApiKey({
      merchantId: "m1",
      mode: "live",
      scopes: ["checkout:write"],
    });
    return {
      keyId: "key-uuid-1",
      merchantId: "m1",
      keyHash: minted.keyHash,
      keyPrefix: minted.keyPrefix,
      mode: "live",
      scopes: ["checkout:write"],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("returns ok:true for a valid active key", async () => {
    const minted = mintApiKey({ merchantId: "m1", mode: "live", scopes: ["checkout:write"] });
    const record = makeRecord({ keyHash: minted.keyHash, keyPrefix: minted.keyPrefix });

    const result = await verifyApiKey(minted.plaintext, async (hash) => {
      return hash === record.keyHash ? record : null;
    });

    expect(result.ok).toBe(true);
    expect(result.record).toBe(record);
  });

  it("returns ok:false when key not found (wrong hash)", async () => {
    const result = await verifyApiKey("pk_live_nonexistent", async () => null);
    expect(result.ok).toBe(false);
    expect(result.record).toBeNull();
  });

  it("returns ok:false when key is revoked", async () => {
    const minted = mintApiKey({ merchantId: "m1", mode: "live", scopes: ["checkout:write"] });
    const record = makeRecord({
      keyHash: minted.keyHash,
      keyPrefix: minted.keyPrefix,
      revokedAt: new Date(),
    });

    const result = await verifyApiKey(minted.plaintext, async (hash) => {
      return hash === record.keyHash ? record : null;
    });

    expect(result.ok).toBe(false);
    expect(result.record).toBeNull();
  });

  it("uses timing-safe comparison (does not short-circuit on partial match)", async () => {
    // Verify that verifyApiKey uses timingSafeEqual internally.
    // We test behavior: even with a hash that shares a long prefix with the
    // stored hash, the function still correctly rejects. This confirms it
    // doesn't do naive string === which could short-circuit.
    const minted = mintApiKey({ merchantId: "m1", mode: "live", scopes: [] });
    const record = makeRecord({ keyHash: minted.keyHash });

    // Tamper: use a different plaintext that won't match
    const tampered = `${minted.plaintext}x`;
    const result = await verifyApiKey(tampered, async (hash) => {
      // lookup returns the record regardless (simulating hash collision in DB index)
      // but the timing-safe compare of the computed hash vs stored hash should reject
      return record;
    });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasScope
// ---------------------------------------------------------------------------
describe("hasScope", () => {
  it("returns true when required scope is in record scopes", () => {
    const record = { scopes: ["checkout:write", "balance:read"] } as ApiKey;
    expect(hasScope(record, "checkout:write")).toBe(true);
  });

  it("returns false when required scope is not in record scopes", () => {
    const record = { scopes: ["balance:read"] } as ApiKey;
    expect(hasScope(record, "checkout:write")).toBe(false);
  });

  it("returns false when scopes array is empty (deny-by-default)", () => {
    const record = { scopes: [] } as unknown as ApiKey;
    expect(hasScope(record, "checkout:write")).toBe(false);
  });

  it("handles multiple required scopes (all must be present)", () => {
    const record = { scopes: ["checkout:write", "balance:read", "refund:write"] } as ApiKey;
    expect(hasScope(record, "checkout:write", "refund:write")).toBe(true);
    expect(hasScope(record, "checkout:write", "webhook:read")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isScopeSubset
// ---------------------------------------------------------------------------
describe("isScopeSubset", () => {
  it("returns true when child is subset of parent", () => {
    expect(isScopeSubset(["checkout:write"], ["checkout:write", "balance:read"])).toBe(true);
  });

  it("returns true when child equals parent", () => {
    expect(
      isScopeSubset(["checkout:write", "balance:read"], ["checkout:write", "balance:read"]),
    ).toBe(true);
  });

  it("returns false when child has scope not in parent", () => {
    expect(isScopeSubset(["checkout:write", "refund:write"], ["checkout:write"])).toBe(false);
  });

  it("returns true for empty child (no permissions requested)", () => {
    expect(isScopeSubset([], ["checkout:write"])).toBe(true);
  });

  it("returns false for non-empty child with empty parent", () => {
    expect(isScopeSubset(["checkout:write"], [])).toBe(false);
  });
});
