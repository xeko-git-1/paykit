/**
 * <RefundModal> — collects amountMicros + reason for invoice refund (RT F12).
 *
 * Validates: amountMicros > 0 (digits only), reason length 3..500. Server
 * additionally enforces tenant-of-invoice match + ledger UNIQUE source_id.
 */
import * as React from "react";
import type { Translator } from "../../i18n/keys.js";

export interface RefundModalProps {
  readonly t: Translator;
  readonly invoiceId: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: { amountMicros: string; reason: string }) => Promise<void>;
}

export function RefundModal(props: RefundModalProps): React.ReactElement {
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const validAmount = /^\d+$/.test(amount) && BigInt(amount || "0") > 0n;
  const validReason = reason.trim().length >= 3 && reason.length <= 500;
  const canSubmit = validAmount && validReason;

  return (
    <div className="paykit-subs-modal" role="dialog" aria-modal="true">
      <h3>{props.t("paykit.subscriptions.refund.title")}</h3>
      <p>
        invoice: <code>{props.invoiceId}</code>
      </p>
      <label>
        amountMicros
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          data-testid="refund-amount"
        />
      </label>
      <label>
        reason
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="refund-reason"
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={props.onCancel}>
        ×
      </button>
      <button
        type="button"
        disabled={!canSubmit || pending}
        onClick={async () => {
          setPending(true);
          try {
            await props.onSubmit({ amountMicros: amount, reason });
          } catch (err) {
            setError(err instanceof Error ? err.message : "refund failed");
          } finally {
            setPending(false);
          }
        }}
      >
        {props.t("paykit.subscriptions.refund.confirm")}
      </button>
    </div>
  );
}
