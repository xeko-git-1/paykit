/**
 * <SubscriptionPanel> — V2 admin shell. Single sortable table + status filter
 * dropdown (RT 15d simplified from 4 tabs). Per-row actions: cancel, upgrade,
 * refund (if latest_invoice_id present per RT F12).
 *
 * Calls admin endpoints from Phase 05. Idempotency-Key generated client-side
 * via crypto.randomUUID() per action attempt.
 */
import * as React from "react";
import { type Translator, defaultTranslator } from "../../i18n/keys.js";
import { CancelButton } from "./cancel-button.js";
import { RefundModal } from "./refund-modal.js";
import { type SubscriptionRow, SubscriptionTable } from "./subscription-table.js";
import { UpgradeModal } from "./upgrade-modal.js";

const STATUS_OPTIONS = [
  "all",
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
  "unpaid",
  "incomplete_expired",
  "paused",
] as const;

export type SubscriptionStatusFilter = (typeof STATUS_OPTIONS)[number];

export interface SubscriptionPanelFetchClient {
  list(params: { status?: string; tenantId?: string }): Promise<{ subscriptions: SubscriptionRow[] }>;
  cancel(id: string, atPeriodEnd: boolean, idempotencyKey: string): Promise<void>;
  upgrade(id: string, newPriceId: string, idempotencyKey: string): Promise<void>;
  refund(input: {
    invoiceId: string;
    amountMicros: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface SubscriptionPanelProps {
  readonly client: SubscriptionPanelFetchClient;
  readonly t?: Translator;
}

export function SubscriptionPanel(props: SubscriptionPanelProps): React.ReactElement {
  const { client, t = defaultTranslator } = props;
  const [filter, setFilter] = React.useState<SubscriptionStatusFilter>("all");
  const [rows, setRows] = React.useState<SubscriptionRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [upgrading, setUpgrading] = React.useState<SubscriptionRow | null>(null);
  const [refunding, setRefunding] = React.useState<SubscriptionRow | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const params: { status?: string } = {};
      if (filter !== "all") params.status = filter;
      const res = await client.list(params);
      setRows(res.subscriptions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [client, filter]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="paykit-subs-panel">
      <header className="paykit-subs-panel__header">
        <h2>{t("paykit.subscriptions.title")}</h2>
        <label className="paykit-subs-panel__filter">
          {t("paykit.subscriptions.filter.statusLabel")}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as SubscriptionStatusFilter)}
            data-testid="status-filter"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "all" ? t("paykit.subscriptions.filter.all") : opt}
              </option>
            ))}
          </select>
        </label>
      </header>

      {loading ? <p>{t("paykit.common.loading")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && !error && rows.length === 0 ? <p>{t("paykit.common.empty")}</p> : null}

      <SubscriptionTable
        rows={rows}
        renderActions={(row) => (
          <div className="paykit-subs-panel__actions">
            <CancelButton
              t={t}
              onConfirm={async (atPeriodEnd) => {
                await client.cancel(row.id, atPeriodEnd, randomKey());
                await refresh();
              }}
            />
            <button type="button" onClick={() => setUpgrading(row)}>
              {t("paykit.subscriptions.action.upgrade")}
            </button>
            {row.latestInvoiceId ? (
              <button type="button" onClick={() => setRefunding(row)}>
                {t("paykit.subscriptions.action.refund")}
              </button>
            ) : null}
          </div>
        )}
      />

      {upgrading ? (
        <UpgradeModal
          t={t}
          onCancel={() => setUpgrading(null)}
          onSubmit={async (newPriceId) => {
            await client.upgrade(upgrading.id, newPriceId, randomKey());
            setUpgrading(null);
            await refresh();
          }}
        />
      ) : null}

      {refunding && refunding.latestInvoiceId ? (
        <RefundModal
          t={t}
          invoiceId={refunding.latestInvoiceId}
          onCancel={() => setRefunding(null)}
          onSubmit={async ({ amountMicros, reason }) => {
            await client.refund({
              invoiceId: refunding.latestInvoiceId!,
              amountMicros,
              reason,
              idempotencyKey: randomKey(),
            });
            setRefunding(null);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function randomKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `paykit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
