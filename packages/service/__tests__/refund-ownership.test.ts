/**
 * Refund ownership tests (F4) — verifies that merchant A cannot refund
 * transactions belonging to merchant B, preventing IDOR attacks.
 */
import { describe, expect, it } from "vitest";
import { buildV1TestApp, createMockDbState } from "./helpers/build-v1-test-app.js";
import type { PaykitAuthContext } from "@vibecc/paykit-server";

describe("/v1/refunds ownership enforcement", () => {
  const merchantAAuth: PaykitAuthContext = {
    merchantId: "merchant-A",
    tenant: { tenantId: "merchant-A", ownerId: "merchant-A" },
    scopes: ["refund:write"],
    plane: "api_key",
  };

  const merchantBTx = {
    transactionId: "a0000000-0000-4000-8000-000000000099",
    tenantId: "merchant-B", // belongs to merchant B
    ownerId: "merchant-B",
    provider: "sepay",
    amountMicros: "5000000000",
    currencyCode: "VND",
    status: "completed",
    providerRef: "prov-ref-99",
    createdAt: new Date(),
    updatedAt: new Date(),
    idempotencyKey: null,
    metadataJson: {},
  };

  const merchantATx = {
    transactionId: "b0000000-0000-4000-8000-000000000001",
    tenantId: "merchant-A", // belongs to merchant A
    ownerId: "merchant-A",
    provider: "sepay",
    amountMicros: "5000000000",
    currencyCode: "VND",
    status: "completed",
    providerRef: "prov-ref-01",
    createdAt: new Date(),
    updatedAt: new Date(),
    idempotencyKey: null,
    metadataJson: {},
  };

  it("merchant A refunding merchant B's transaction returns 404 (ownership rejection)", async () => {
    const dbState = createMockDbState();
    dbState.transactions.push(merchantBTx);

    const { app } = buildV1TestApp({ auth: merchantAAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/refunds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-ownership-test-1",
        },
        body: JSON.stringify({
          transactionId: merchantBTx.transactionId,
          amountMicros: "1000000",
          reason: "cross-tenant refund attempt",
        }),
      }),
    );

    // Must return 404 — not 200 or 403 — to avoid leaking existence of other merchants' txs
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("merchant A refunding own transaction succeeds", async () => {
    const dbState = createMockDbState();
    dbState.transactions.push(merchantATx);
    dbState.ledgerEntries = []; // no prior refunds

    const { app } = buildV1TestApp({ auth: merchantAAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/refunds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-ownership-test-2",
        },
        body: JSON.stringify({
          transactionId: merchantATx.transactionId,
          amountMicros: "1000000",
          reason: "legitimate self-refund",
        }),
      }),
    );

    // Should succeed (2xx) — the refund-core processes it
    expect(res.status).toBeLessThan(300);
    const body = await res.json();
    expect(body.apiVersion).toBeDefined();
  });

  it("merchant B balance is NOT debited and no ledger entry is written on cross-tenant refund", async () => {
    const dbState = createMockDbState();
    dbState.transactions.push(merchantBTx);
    dbState.balances.push({
      tenantId: "merchant-B",
      currencyCode: "VND",
      currentBalanceMicros: "10000000000",
      updatedAt: new Date(),
    });

    const { app } = buildV1TestApp({ auth: merchantAAuth, dbState });
    const res = await app.request(
      new Request("http://localhost/v1/refunds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-ownership-test-3",
        },
        body: JSON.stringify({
          transactionId: merchantBTx.transactionId,
          amountMicros: "1000000",
          reason: "attempted drain",
        }),
      }),
    );

    // The request must be rejected at the ownership gate (404), BEFORE any
    // refund processing. The balance assertion alone is vacuous (the mock never
    // mutates balance), so the load-bearing check is that the refund path never
    // ran: no ledger entry was inserted. Remove the ownership guard and this
    // fails because executeRefund would write a refund_debit entry.
    expect(res.status).toBe(404);
    expect(dbState.ledgerEntries).toHaveLength(0);
    const bBalance = dbState.balances.find((b) => b.tenantId === "merchant-B");
    expect(bBalance?.currentBalanceMicros).toBe("10000000000");
  });
});
