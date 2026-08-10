/**
 * NowPayments IPN signature verifier tests (Phase 03 tests #1-6).
 *
 * Tests cover:
 *   - Synthetic IPN replay (5+ payloads — real sandbox capture pending user TODO
 *     per Phase 01 decision-log; synthetic chosen per Validation Session 4)
 *   - Tampered body rejection
 *   - Missing header rejection
 *   - Secret rotation array (V1.5 invariant — RT F11)
 *   - Constant-time XOR with length pre-check (RT F14 — NOT timingSafeEqual)
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical-json.js";
import {
  NP_SIGNATURE_HEADER,
  computeNpSignature,
  verifyNpSignature,
} from "../src/webhook-verifier.js";

const SECRET = "test-ipn-secret-aaaaaaaaaa";

function signed(body: unknown, secret: string): { rawBody: string; sig: string } {
  const rawBody = JSON.stringify(body);
  const sig = computeNpSignature(canonicalize(body), secret);
  return { rawBody, sig };
}

const FIXTURES = [
  {
    payment_id: 5524759814,
    payment_status: "finished",
    order_id: "tx-fix-1",
    price_amount: 50,
    price_currency: "usd",
    actually_paid: 50,
    pay_currency: "usdcmatic",
  },
  {
    payment_id: 5524759815,
    payment_status: "partially_paid",
    order_id: "tx-fix-2",
    price_amount: 50,
    price_currency: "usd",
    actually_paid: 47.21,
    pay_currency: "btc",
  },
  {
    payment_id: 5524759816,
    payment_status: "failed",
    order_id: "tx-fix-3",
    price_amount: 50,
    price_currency: "usd",
  },
  {
    payment_id: 5524759817,
    payment_status: "expired",
    order_id: "tx-fix-4",
    price_amount: 50,
    price_currency: "usd",
  },
  {
    payment_id: 5524759818,
    payment_status: "refunded",
    order_id: "tx-fix-5",
    price_amount: 50,
    price_currency: "usd",
  },
  {
    payment_id: 5524759819,
    payment_status: "confirming",
    order_id: "tx-fix-6",
    price_amount: 50,
    price_currency: "usd",
  },
];

describe("signature-fixture-replay (synthetic — user TODO: replace with sandbox capture)", () => {
  it("verifies all 6 synthetic NP IPN fixtures against the implemented HMAC-SHA512 sorted-JSON scheme", () => {
    for (const payload of FIXTURES) {
      const { rawBody, sig } = signed(payload, SECRET);
      const ok = verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: sig }, [SECRET]);
      expect(ok).toBe(true);
    }
  });
});

describe("signature-tampered", () => {
  it("returns false when a single byte of the body is flipped", () => {
    const { rawBody, sig } = signed(FIXTURES[0], SECRET);
    const tampered = `${rawBody.slice(0, -2)}9}`;
    expect(verifyNpSignature(tampered, { [NP_SIGNATURE_HEADER]: sig }, [SECRET])).toBe(false);
  });

  it("returns false when the signature is shorter than expected (length mismatch must NOT throw)", () => {
    const { rawBody } = signed(FIXTURES[0], SECRET);
    expect(() =>
      verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: "deadbeef" }, [SECRET]),
    ).not.toThrow();
    expect(verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: "deadbeef" }, [SECRET])).toBe(false);
  });
});

describe("signature-missing-header", () => {
  it("returns false when the x-nowpayments-sig header is absent", () => {
    const { rawBody } = signed(FIXTURES[0], SECRET);
    expect(verifyNpSignature(rawBody, {}, [SECRET])).toBe(false);
  });

  it("returns false when the header value is empty string", () => {
    const { rawBody } = signed(FIXTURES[0], SECRET);
    expect(verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: "" }, [SECRET])).toBe(false);
  });

  it("rejects a signature forged with a whitespace-only secret (fail closed)", () => {
    // A blank/whitespace secret must never be used as an HMAC key: otherwise an
    // attacker who knows the body can forge a signature with that known key.
    const blank = "   ";
    const { rawBody, sig } = signed(FIXTURES[0], blank);
    expect(verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: sig }, [blank])).toBe(false);
  });
});

describe("signature-rotation (RT F11 — V1.5 invariant)", () => {
  it("accepts the second secret when the first rotation entry fails", () => {
    const oldSecret = "old-secret-rotated-out";
    const newSecret = "new-secret-active";
    const { rawBody, sig } = signed(FIXTURES[0], newSecret);
    expect(verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: sig }, [oldSecret, newSecret])).toBe(
      true,
    );
  });

  it("returns false when no secret in the rotation array matches", () => {
    const { rawBody, sig } = signed(FIXTURES[0], SECRET);
    expect(
      verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: sig }, ["wrong-1", "wrong-2", "wrong-3"]),
    ).toBe(false);
  });
});

describe("signature-constant-time-xor (RT F14 — must NOT throw on length mismatch)", () => {
  it("does not throw when received signature is much shorter than expected", () => {
    const { rawBody } = signed(FIXTURES[0], SECRET);
    expect(() =>
      verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: "ab" }, [SECRET]),
    ).not.toThrow();
  });

  it("does not throw when received signature is much longer than expected", () => {
    const { rawBody } = signed(FIXTURES[0], SECRET);
    const tooLong = "a".repeat(256);
    expect(() =>
      verifyNpSignature(rawBody, { [NP_SIGNATURE_HEADER]: tooLong }, [SECRET]),
    ).not.toThrow();
  });

  it("manual XOR matches reference HMAC-SHA512 hex for known input", () => {
    const reference = createHmac("sha512", SECRET).update("hello", "utf-8").digest("hex");
    expect(computeNpSignature("hello", SECRET)).toBe(reference);
  });
});
