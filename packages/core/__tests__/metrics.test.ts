import { beforeEach, describe, expect, it } from "vitest";
import {
  PAYKIT_METRICS,
  getMetricsText,
  incrementCounter,
  resetMetrics,
} from "../src/observability/metrics.js";

describe("paykit metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("increments and exposes counter in Prometheus format", () => {
    incrementCounter("test_counter_total", "Test counter", ["provider"], { provider: "stripe" });
    incrementCounter("test_counter_total", "Test counter", ["provider"], { provider: "stripe" });
    incrementCounter("test_counter_total", "Test counter", ["provider"], { provider: "sepay" });
    const text = getMetricsText();
    expect(text).toContain('test_counter_total{provider="stripe"} 2');
    expect(text).toContain('test_counter_total{provider="sepay"} 1');
    expect(text).toContain("# HELP test_counter_total Test counter");
    expect(text).toContain("# TYPE test_counter_total counter");
  });

  it("PAYKIT_METRICS.webhookReceived increments paykit_webhook_received_total", () => {
    PAYKIT_METRICS.webhookReceived("stripe", "checkout.session.completed", "ok");
    const text = getMetricsText();
    expect(text).toMatch(
      /paykit_webhook_received_total\{provider="stripe",event_type="checkout\.session\.completed",status="ok"\} 1/,
    );
  });

  it("PAYKIT_METRICS.ledgerEntry increments paykit_ledger_entries_total", () => {
    PAYKIT_METRICS.ledgerEntry("credit", "USD");
    PAYKIT_METRICS.ledgerEntry("refund", "USD");
    PAYKIT_METRICS.ledgerEntry("credit", "VND");
    const text = getMetricsText();
    expect(text).toMatch(/paykit_ledger_entries_total\{[^}]*entry_type="credit"[^}]*\} 1/);
    expect(text).toMatch(/paykit_ledger_entries_total\{[^}]*entry_type="refund"[^}]*\} 1/);
  });

  it("escapes label values containing quotes", () => {
    incrementCounter("custom_total", "Custom", ["msg"], { msg: 'has "quote"' });
    expect(getMetricsText()).toContain('msg="has \\"quote\\""');
  });

  it("does NOT label by tenant_id (cardinality protection)", () => {
    // Verify by inspecting the standard paykit counters' label whitelist.
    PAYKIT_METRICS.checkoutCreated("stripe", "USD");
    const text = getMetricsText();
    expect(text).not.toContain("tenant_id=");
  });
});
