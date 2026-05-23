/**
 * <PaykitBalanceWidget> — fetches the current user's per-currency balance.
 *
 * IMPORTANT: does NOT accept tenantId prop (red-team F12 — server-side
 * TenantResolver is the only source of tenant identity).
 *
 * Tailwind CSS classes only; no styling lib peer dep.
 */
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { type Translator, defaultTranslator } from "../../i18n/keys.js";
import { formatMicros } from "../../lib/format-money.js";

export interface BalanceRow {
  readonly currencyCode: "USD" | "VND";
  readonly currentBalanceMicros: string;
  readonly updatedAt: string;
}

export interface PaykitBalanceWidgetProps {
  readonly apiBase: string;
  readonly t?: Translator;
  readonly locale?: string;
  readonly fetchClient?: typeof fetch;
}

interface BalanceResponse {
  readonly data: { readonly balances: readonly BalanceRow[] };
}

export function PaykitBalanceWidget(props: PaykitBalanceWidgetProps): React.ReactElement {
  const { apiBase, t = defaultTranslator, locale, fetchClient = fetch } = props;
  const query = useQuery<BalanceResponse>({
    queryKey: ["paykit", "balance", apiBase],
    queryFn: async () => {
      const res = await fetchClient(`${apiBase}/balance`, { credentials: "include" });
      if (!res.ok) throw new Error(`paykit /balance returned ${res.status}`);
      return (await res.json()) as BalanceResponse;
    },
  });

  if (query.isLoading) {
    return (
      <div className="paykit-balance-widget paykit-balance-widget--loading">
        {t("paykit.common.loading")}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="paykit-balance-widget paykit-balance-widget--error" role="alert">
        {t("paykit.common.error")}
      </div>
    );
  }
  const balances = query.data?.data.balances ?? [];
  if (balances.length === 0) {
    return (
      <div className="paykit-balance-widget paykit-balance-widget--empty">
        {t("paykit.common.empty")}
      </div>
    );
  }

  return (
    <div className="paykit-balance-widget">
      <h3 className="paykit-balance-widget__title">{t("paykit.balance.title")}</h3>
      <ul className="paykit-balance-widget__list">
        {balances.map((b) => (
          <li
            key={b.currencyCode}
            className="paykit-balance-widget__item"
            data-currency={b.currencyCode}
          >
            <span className="paykit-balance-widget__currency">{b.currencyCode}</span>
            <span className="paykit-balance-widget__amount">
              {formatMicros(b.currentBalanceMicros, b.currencyCode, locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
