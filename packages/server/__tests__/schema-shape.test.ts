import { describe, expect, it } from "vitest";
import {
  balanceProjections,
  ledgerEntries,
  paymentTransactions,
  reconciliationRuns,
  webhookEvents,
} from "@xeko-git-1/paykit-auth-core/db/schema/index.js";

describe("paykit schema shape", () => {
  it("payment_transactions has expected columns", () => {
    const cols = Object.keys(paymentTransactions);
    expect(cols).toContain("transactionId");
    expect(cols).toContain("tenantId");
    expect(cols).toContain("ownerId");
    expect(cols).toContain("provider");
    expect(cols).toContain("amountMicros");
    expect(cols).toContain("currencyCode");
    expect(cols).toContain("status");
    expect(cols).toContain("providerRef");
    expect(cols).toContain("idempotencyKey");
    expect(cols).toContain("metadataJson");
    expect(cols).not.toContain("workspaceId");
    expect(cols).not.toContain("organizationId");
  });

  it("ledger_entries has multi-currency-aware columns", () => {
    const cols = Object.keys(ledgerEntries);
    expect(cols).toContain("entryId");
    expect(cols).toContain("tenantId");
    expect(cols).toContain("ownerId");
    expect(cols).toContain("entryType");
    expect(cols).toContain("amountMicros");
    expect(cols).toContain("currencyCode");
    expect(cols).toContain("metadataJson");
  });

  it("balance_projections has compound PK columns", () => {
    const cols = Object.keys(balanceProjections);
    expect(cols).toContain("tenantId");
    expect(cols).toContain("currencyCode");
    expect(cols).toContain("currentBalanceMicros");
  });

  it("webhook_events has compound PK columns", () => {
    const cols = Object.keys(webhookEvents);
    expect(cols).toContain("provider");
    expect(cols).toContain("eventId");
    expect(cols).toContain("recordedAt");
  });

  it("reconciliation_runs has expected columns", () => {
    const cols = Object.keys(reconciliationRuns);
    expect(cols).toContain("runId");
    expect(cols).toContain("startedAt");
    expect(cols).toContain("completedAt");
    expect(cols).toContain("status");
    expect(cols).toContain("summaryJson");
  });
});
