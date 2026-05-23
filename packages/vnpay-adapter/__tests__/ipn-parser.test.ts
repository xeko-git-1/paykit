import { describe, expect, it } from "vitest";
import { paramsToWebhookEvent, parseFormUrlencoded } from "../src/ipn-parser.js";

describe("parseFormUrlencoded", () => {
  it("parses VNPay-style form-urlencoded body", () => {
    const body = "vnp_TxnRef=tx-1&vnp_Amount=10000000&vnp_ResponseCode=00";
    const result = parseFormUrlencoded(body);
    expect(result.vnp_TxnRef).toBe("tx-1");
    expect(result.vnp_Amount).toBe("10000000");
    expect(result.vnp_ResponseCode).toBe("00");
  });

  it("decodes percent-encoded values", () => {
    const body = "vnp_OrderInfo=Don%20hang%20%23123";
    const result = parseFormUrlencoded(body);
    expect(result.vnp_OrderInfo).toBe("Don hang #123");
  });

  it("converts + to space in values", () => {
    const body = "vnp_OrderInfo=hello+world";
    const result = parseFormUrlencoded(body);
    expect(result.vnp_OrderInfo).toBe("hello world");
  });
});

describe("paramsToWebhookEvent", () => {
  it("maps vnp_ResponseCode='00' → payment.completed with VND-native amount", () => {
    const event = paramsToWebhookEvent({
      vnp_TxnRef: "tx-1",
      vnp_Amount: "10000000", // 100,000 VND × 100
      vnp_ResponseCode: "00",
      vnp_TransactionNo: "12345",
      vnp_BankCode: "NCB",
    });
    expect(event?.type).toBe("payment.completed");
    expect(event?.providerRef).toBe("tx-1");
    expect(event?.eventId).toBe("vnpay:tx-1:12345");
    expect(event?.amountMicros).toBe("100000000000"); // 100,000 VND × 1M micros
    expect(event?.currencyCode).toBe("VND");
  });

  it("maps vnp_ResponseCode='24' (cancelled) → null (skip)", () => {
    const event = paramsToWebhookEvent({
      vnp_TxnRef: "tx-2",
      vnp_Amount: "10000000",
      vnp_ResponseCode: "24",
    });
    expect(event).toBeNull();
  });

  it("maps other codes (07/09/etc.) → payment.failed", () => {
    const event = paramsToWebhookEvent({
      vnp_TxnRef: "tx-3",
      vnp_Amount: "10000000",
      vnp_ResponseCode: "07",
    });
    expect(event?.type).toBe("payment.failed");
    expect((event?.metadata as { vnp_ResponseCode?: string })?.vnp_ResponseCode).toBe("07");
  });

  it("missing vnp_TxnRef → null", () => {
    const event = paramsToWebhookEvent({ vnp_ResponseCode: "00" });
    expect(event).toBeNull();
  });

  it("invalid vnp_Amount → no amountMicros field", () => {
    const event = paramsToWebhookEvent({
      vnp_TxnRef: "tx-4",
      vnp_Amount: "not-a-number",
      vnp_ResponseCode: "00",
    });
    expect(event?.amountMicros).toBeUndefined();
  });
});
