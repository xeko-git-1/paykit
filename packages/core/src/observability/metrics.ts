/**
 * Paykit observability metrics — Prometheus exposition format.
 *
 * V1 ships counters + histograms with bounded label cardinality. NEVER label
 * by tenant_id (cardinality explosion). Whitelist: provider, event_type,
 * status, currency.
 *
 * Consumer mounts /metrics endpoint to expose `getMetricsText()`.
 */

interface CounterEntry {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  values: Map<string, number>; // labelKey → count
}

const counters = new Map<string, CounterEntry>();

function labelKey(labelNames: readonly string[], labels: Record<string, string>): string {
  return labelNames.map((n) => `${n}="${(labels[n] ?? "").replace(/"/g, '\\"')}"`).join(",");
}

function getOrCreateCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
): CounterEntry {
  let entry = counters.get(name);
  if (!entry) {
    entry = { name, help, labelNames, values: new Map() };
    counters.set(name, entry);
  }
  return entry;
}

export function incrementCounter(
  name: string,
  help: string,
  labelNames: readonly string[],
  labels: Record<string, string>,
  value = 1,
): void {
  const c = getOrCreateCounter(name, help, labelNames);
  const key = labelKey(c.labelNames, labels);
  c.values.set(key, (c.values.get(key) ?? 0) + value);
}

/** Reset all metrics — useful only in tests. */
export function resetMetrics(): void {
  counters.clear();
}

export function getMetricsText(): string {
  const lines: string[] = [];
  for (const [, c] of counters) {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    for (const [key, value] of c.values) {
      const labels = key.length > 0 ? `{${key}}` : "";
      lines.push(`${c.name}${labels} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// Standard paykit counters — invoked by server/workers internals. Consumer
// can also call these to add app-specific dimensions.
export const PAYKIT_METRICS = {
  webhookReceived: (provider: string, eventType: string, status: string) =>
    incrementCounter(
      "paykit_webhook_received_total",
      "Webhook events received from providers",
      ["provider", "event_type", "status"],
      { provider, event_type: eventType, status },
    ),
  checkoutCreated: (provider: string, currency: string) =>
    incrementCounter(
      "paykit_checkout_created_total",
      "Checkout sessions created",
      ["provider", "currency"],
      { provider, currency },
    ),
  ledgerEntry: (entryType: string, currency: string) =>
    incrementCounter(
      "paykit_ledger_entries_total",
      "Ledger entries appended",
      ["entry_type", "currency"],
      { entry_type: entryType, currency },
    ),
  reconciliationRun: (status: string) =>
    incrementCounter(
      "paykit_reconciliation_runs_total",
      "Reconciliation worker invocations",
      ["status"],
      { status },
    ),
  balanceProjectionDrift: (currency: string) =>
    incrementCounter(
      "paykit_balance_projection_drift_total",
      "Reconciliation-detected drift between ledger sum and projection",
      ["currency"],
      { currency },
    ),
};
