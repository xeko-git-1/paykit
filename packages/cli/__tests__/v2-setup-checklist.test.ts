/**
 * Phase 09 — V2 setup checklist coverage test (Val S4 Q1, RT F1, F7).
 *
 * Verifies the docs file enumerates the 10 required Stripe events. If any
 * event is dropped from the docs, this test fails so the operator-facing
 * checklist stays in lockstep with code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = readFileSync(
  resolve(__dirname, "..", "..", "..", "docs", "v2-setup-checklist.md"),
  "utf8",
);

const REQUIRED_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "credit_note.created",
  "customer.deleted",
] as const;

describe("V2 setup checklist (RT F1, F7, Val S4 Q1)", () => {
  for (const event of REQUIRED_EVENTS) {
    it(`lists Stripe event ${event}`, () => {
      expect(DOC).toContain(event);
    });
  }

  it("documents required migrations 004-009", () => {
    expect(DOC).toMatch(/004_customers/);
    expect(DOC).toMatch(/005_subscriptions/);
    expect(DOC).toMatch(/006_subscription_events/);
    expect(DOC).toMatch(/007_idempotency_records/);
    expect(DOC).toMatch(/008_runtime_config/);
    expect(DOC).toMatch(/009_ledger_v2_columns/);
  });

  it("documents canary auto-flip wiring (Val S4 Q3)", () => {
    expect(DOC).toMatch(/PAYKIT_V2_WEBHOOK_STRICT=false/);
    expect(DOC).toMatch(/webhook_strict_v2/);
    expect(DOC).toMatch(/expires_at = deploy_time \+ 24h/);
  });

  it("documents per-instance webhook URL (RT F7)", () => {
    expect(DOC).toMatch(/\/webhooks\/stripe-subscription/);
    expect(DOC).toMatch(/no shared secret across adapter instances/);
  });

  it("documents customer backfill (RT F13)", () => {
    expect(DOC).toMatch(/npx paykit backfill-customers --provider stripe-subscription/);
  });

  it("documents AdminGuard requirement (RT F5)", () => {
    expect(DOC).toMatch(/adminGuard configured in createPaykit\(\)/);
  });

  it("documents extended refund endpoint (RT F12)", () => {
    expect(DOC).toMatch(/\/admin\/billing\/refund-invoice/);
  });
});
