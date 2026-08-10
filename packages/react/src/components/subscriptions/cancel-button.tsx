/**
 * <CancelButton> — confirms before invoking cancel callback.
 */
import * as React from "react";
import type { Translator } from "../../i18n/keys.js";

export interface CancelButtonProps {
  readonly t: Translator;
  readonly onConfirm: (atPeriodEnd: boolean) => Promise<void>;
}

export function CancelButton(props: CancelButtonProps): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const [atPeriodEnd, setAtPeriodEnd] = React.useState(true);
  const [pending, setPending] = React.useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}>
        {props.t("paykit.subscriptions.action.cancel")}
      </button>
    );
  }

  return (
    // Inline confirmation inside a table row, not a modal: it does not trap
    // focus or block the rest of the table, so a grouping element describes it
    // honestly where `dialog` would promise semantics this markup never gives.
    // `fieldset` is that grouping element natively, so no ARIA role is needed.
    <fieldset className="paykit-subs-cancel-confirm" aria-label="confirm cancel">
      <label>
        <input
          type="checkbox"
          checked={atPeriodEnd}
          onChange={(e) => setAtPeriodEnd(e.target.checked)}
        />{" "}
        {props.t("paykit.subscriptions.cancel.atPeriodEndLabel")}
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            await props.onConfirm(atPeriodEnd);
          } finally {
            setPending(false);
            setConfirming(false);
          }
        }}
      >
        {props.t("paykit.subscriptions.action.cancel")}
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        ×
      </button>
    </fieldset>
  );
}
