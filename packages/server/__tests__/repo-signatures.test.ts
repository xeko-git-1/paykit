/**
 * Repo signature tests — verify each repo helper accepts both DbClient and
 * DbTransactionHandle (via DbOrTx union) and that public API surface is stable.
 *
 * Live DB integration tests are gated behind DATABASE_URL_PAYKIT_TEST and run
 * in Phase 11 against testcontainer Postgres.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { DbOrTx } from "@vibecc/paykit-auth-core/db/client.js";
import * as balanceRepo from "@vibecc/paykit-auth-core/db/repos/balance.repo.js";
import * as ledgerRepo from "@vibecc/paykit-auth-core/db/repos/ledger.repo.js";
import * as paymentRepo from "@vibecc/paykit-auth-core/db/repos/payment.repo.js";
import * as reconciliationRepo from "@vibecc/paykit-auth-core/db/repos/reconciliation.repo.js";
import * as webhookEventRepo from "@vibecc/paykit-auth-core/db/repos/webhook-event.repo.js";

describe("paymentRepo public API", () => {
  it("exposes expected helpers", () => {
    expect(typeof paymentRepo.createTransaction).toBe("function");
    expect(typeof paymentRepo.findByIdempotencyKey).toBe("function");
    expect(typeof paymentRepo.findByProviderRef).toBe("function");
    expect(typeof paymentRepo.updateTransactionStatus).toBe("function");
    expect(typeof paymentRepo.listByTenant).toBe("function");
  });

  it("createTransaction first arg accepts DbOrTx", () => {
    expectTypeOf(paymentRepo.createTransaction).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

describe("ledgerRepo public API", () => {
  it("exposes expected helpers", () => {
    expect(typeof ledgerRepo.appendLedgerEntry).toBe("function");
    expect(typeof ledgerRepo.listLedgerEntries).toBe("function");
    expect(typeof ledgerRepo.computeBalancesByTenant).toBe("function");
  });

  it("appendLedgerEntry first arg accepts DbOrTx", () => {
    expectTypeOf(ledgerRepo.appendLedgerEntry).parameter(0).toEqualTypeOf<DbOrTx>();
  });
});

describe("balanceRepo public API", () => {
  it("exposes multi-wallet helpers", () => {
    expect(typeof balanceRepo.getBalance).toBe("function");
    expect(typeof balanceRepo.listBalancesByTenant).toBe("function");
    expect(typeof balanceRepo.applyDelta).toBe("function");
  });

  it("getBalance requires currency code (multi-wallet)", () => {
    // 3rd positional param: currencyCode: string
    expectTypeOf(balanceRepo.getBalance).parameter(2).toBeString();
  });

  it("applyDelta accepts bigint delta + DbOrTx", () => {
    expectTypeOf(balanceRepo.applyDelta).parameter(0).toEqualTypeOf<DbOrTx>();
    expectTypeOf(balanceRepo.applyDelta).parameter(3).toEqualTypeOf<bigint>();
  });
});

describe("webhookEventRepo public API", () => {
  it("exposes tryRecordWebhookEvent for INSERT-first dedup", () => {
    expect(typeof webhookEventRepo.tryRecordWebhookEvent).toBe("function");
    expect(typeof webhookEventRepo.listEvents).toBe("function");
  });
});

describe("reconciliationRepo public API", () => {
  it("exposes start/complete/list helpers", () => {
    expect(typeof reconciliationRepo.startRun).toBe("function");
    expect(typeof reconciliationRepo.completeRun).toBe("function");
    expect(typeof reconciliationRepo.listRuns).toBe("function");
  });
});
