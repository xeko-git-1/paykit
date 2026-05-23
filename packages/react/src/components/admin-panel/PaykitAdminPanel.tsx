/**
 * <PaykitAdminPanel> — 4-tab admin shell (Transactions, Ledger, Webhooks,
 * Reconciliation). Each tab fetches paginated data from /admin/billing/*.
 *
 * Phase 11 will populate full table components per tab. V1 ships the
 * navigation shell + i18n contract + render boundary.
 */
import * as React from "react";
import { type Translator, defaultTranslator } from "../../i18n/keys.js";

type Tab = "transactions" | "ledger" | "webhooks" | "reconciliation";

const TABS: ReadonlyArray<{ readonly id: Tab; readonly labelKey: string }> = [
  { id: "transactions", labelKey: "paykit.admin.tab.transactions" },
  { id: "ledger", labelKey: "paykit.admin.tab.ledger" },
  { id: "webhooks", labelKey: "paykit.admin.tab.webhooks" },
  { id: "reconciliation", labelKey: "paykit.admin.tab.reconciliation" },
];

export interface PaykitAdminPanelProps {
  readonly apiBase: string;
  readonly t?: Translator;
}

export function PaykitAdminPanel(props: PaykitAdminPanelProps): React.ReactElement {
  const { apiBase, t = defaultTranslator } = props;
  const [active, setActive] = React.useState<Tab>("transactions");

  return (
    <div className="paykit-admin-panel" data-api-base={apiBase}>
      <nav className="paykit-admin-panel__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={
              active === tab.id
                ? "paykit-admin-panel__tab paykit-admin-panel__tab--active"
                : "paykit-admin-panel__tab"
            }
            onClick={() => setActive(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </nav>
      <section className="paykit-admin-panel__content" role="tabpanel" data-active={active}>
        {/* Phase 11 will render full table per tab. For V1 we expose hooks
            and the boundary; see paykit/react/src/components/* for tables. */}
        <p className="paykit-admin-panel__placeholder">
          {t("paykit.common.loading")} ({active})
        </p>
      </section>
    </div>
  );
}
