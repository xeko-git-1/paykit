/**
 * <SubscriptionTable> — pure presentational component. Parent owns fetch
 * state + per-row actions slot.
 */
import type * as React from "react";

export interface SubscriptionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly priceId: string;
  readonly customerId: string;
  readonly currentPeriodEnd: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly latestInvoiceId: string | null;
  readonly currencyCode: string;
}

export interface SubscriptionTableProps {
  readonly rows: readonly SubscriptionRow[];
  readonly renderActions: (row: SubscriptionRow) => React.ReactNode;
}

export function SubscriptionTable(props: SubscriptionTableProps): React.ReactElement {
  return (
    <table className="paykit-subs-table">
      <thead>
        <tr>
          <th>id</th>
          <th>tenant</th>
          <th>status</th>
          <th>price</th>
          <th>period end</th>
          <th>actions</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.id} data-row-id={row.id}>
            <td>
              <code>{row.id}</code>
            </td>
            <td>
              <code>{row.tenantId}</code>
            </td>
            <td>{row.status}</td>
            <td>{row.priceId}</td>
            <td>{row.currentPeriodEnd}</td>
            <td>{props.renderActions(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
