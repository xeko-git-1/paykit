/**
 * <UpgradeModal> — collects newPriceId, validates min length before submit.
 */
import * as React from "react";
import type { Translator } from "../../i18n/keys.js";

export interface UpgradeModalProps {
  readonly t: Translator;
  readonly onCancel: () => void;
  readonly onSubmit: (newPriceId: string) => Promise<void>;
}

export function UpgradeModal(props: UpgradeModalProps): React.ReactElement {
  const [priceId, setPriceId] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const valid = priceId.trim().length >= 3;

  return (
    <dialog className="paykit-subs-modal" open aria-modal="true">
      <label>
        {props.t("paykit.subscriptions.upgrade.priceIdLabel")}
        <input
          type="text"
          value={priceId}
          onChange={(e) => setPriceId(e.target.value)}
          data-testid="upgrade-priceid"
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={props.onCancel}>
        ×
      </button>
      <button
        type="button"
        disabled={!valid || pending}
        onClick={async () => {
          setPending(true);
          try {
            await props.onSubmit(priceId.trim());
          } catch (err) {
            setError(err instanceof Error ? err.message : "upgrade failed");
          } finally {
            setPending(false);
          }
        }}
      >
        {props.t("paykit.subscriptions.action.upgrade")}
      </button>
    </dialog>
  );
}
