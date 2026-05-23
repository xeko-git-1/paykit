import { describe, expect, it } from "vitest";
import {
  buildAppTransId,
  buildCreateCanonical,
  buildRefundCanonical,
  signWithKey1,
  signWithKey2,
  verifyCallbackMac,
} from "../src/signature.js";

describe("buildAppTransId", () => {
  it("formats YYMMDD_<id> in UTC+7 (Vietnam timezone)", () => {
    const localUtc = new Date("2026-05-23T15:30:00Z");
    // UTC 15:30 + 7 = 22:30 in Vietnam (still 23 May)
    expect(buildAppTransId("abc123", localUtc)).toBe("260523_abc123");
  });

  it("crosses date boundary at UTC 17:00 → next day in Vietnam", () => {
    const localUtc = new Date("2026-05-23T17:30:00Z");
    // UTC 17:30 + 7 = 00:30 next day (24 May)
    expect(buildAppTransId("xyz", localUtc)).toBe("260524_xyz");
  });

  it("zero-pads month and day", () => {
    const earlyJan = new Date("2026-01-05T05:00:00Z");
    expect(buildAppTransId("zz", earlyJan)).toBe("260105_zz");
  });
});

describe("buildCreateCanonical", () => {
  it("uses pipe separator with order: appId|appTransId|appUser|amount|appTime|embedData|item", () => {
    const canonical = buildCreateCanonical({
      appId: "100",
      appTransId: "260523_xx",
      appUser: "user-1",
      amount: "100000",
      appTime: "1700000000",
      embedData: "{}",
      item: "[]",
    });
    expect(canonical).toBe("100|260523_xx|user-1|100000|1700000000|{}|[]");
  });
});

describe("buildRefundCanonical", () => {
  it("uses pipe separator with: appId|zpTransId|amount|description|timestamp", () => {
    const canonical = buildRefundCanonical({
      appId: "100",
      zpTransId: "zp-99",
      amount: "100000",
      description: "refund test",
      timestamp: "1700000000",
    });
    expect(canonical).toBe("100|zp-99|100000|refund test|1700000000");
  });
});

describe("signWithKey1 vs signWithKey2 (separation)", () => {
  it("key1 ≠ key2 produces DIFFERENT signatures for same canonical", () => {
    const c = "test_canonical";
    const sig1 = signWithKey1(c, "key1_secret");
    const sig2 = signWithKey2(c, "key2_secret");
    expect(sig1).not.toBe(sig2);
  });

  it("returns 64-char hex SHA256", () => {
    expect(signWithKey1("x", "k1")).toMatch(/^[0-9a-f]{64}$/);
    expect(signWithKey2("x", "k2")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyCallbackMac", () => {
  it("verifies when receivedMac was signed with the matching key2", () => {
    const data = '{"app_trans_id":"260523_abc","amount":100000}';
    const mac = signWithKey2(data, "k2_v1");
    expect(verifyCallbackMac(data, ["k2_v1"], mac)).toBe(true);
  });

  it("supports rotation array (old + new key2)", () => {
    const data = '{"app_trans_id":"260523_abc"}';
    const oldMac = signWithKey2(data, "k2_old");
    expect(verifyCallbackMac(data, ["k2_old", "k2_new"], oldMac)).toBe(true);
  });

  it("rejects when signed with key1 (red-team F: 2-key separation enforced)", () => {
    const data = '{"app_trans_id":"260523_abc"}';
    const macFromKey1 = signWithKey1(data, "k1_secret");
    expect(verifyCallbackMac(data, ["k2_secret"], macFromKey1)).toBe(false);
  });

  it("rejects empty mac", () => {
    expect(verifyCallbackMac("data", ["k2"], "")).toBe(false);
  });

  it("rejects tampered data", () => {
    const data = '{"app_trans_id":"260523_abc","amount":100000}';
    const mac = signWithKey2(data, "k2_v1");
    const tampered = '{"app_trans_id":"260523_abc","amount":999999}';
    expect(verifyCallbackMac(tampered, ["k2_v1"], mac)).toBe(false);
  });
});
