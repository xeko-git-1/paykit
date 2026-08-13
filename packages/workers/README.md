# @xeko-git-1/paykit-workers

Reconciliation worker that compares paykit's ledger against provider records.
Designed to run on cron or BullMQ — not a long-running daemon.

## Entry point

```ts
import { reconcileV15 } from "@xeko-git-1/paykit-workers";

const result = await reconcileV15(
  { db, registry },
  { since: new Date(Date.now() - 24 * 60 * 60 * 1000) },
);
```

`reconcileV15` walks every adapter in the registry, verifies the window, and
writes a run row with a summary the audit trail can answer questions from.

## Per-provider coverage

Not every rail exposes the same API, so the reconciler runs each provider in
one of three modes (the run summary names which):

- **window listing** — the adapter lists settled transactions by date range
  (`fetchTransactions`); both directions are diffed. Stripe, SePay, and the
  crypto adapters that expose listing run here. SePay's default HTTP fetcher is
  `createSepayHttpPull` / `createSepayHttpFetcher` against
  `my.sepay.vn/userapi/transactions/list`.
- **per-row** — no date-range listing, but a per-reference status API
  (`queryTransaction`): VNPay `querydr`, Momo query, ZaloPay `/v2/query`. Every
  paykit row in the window is verified one call at a time. One-way: money
  settled at the provider with no paykit row cannot be discovered this way, and
  the summary lists these providers under `perRowProviders`.
- **not reconcilable** — neither API exists (Binance Pay). Skipped and named
  under `notReconcilableProviders`; check via the merchant dashboard.

See `docs/integration-guide.md` § "Reconciliation matrix" for the full table.

## License

Proprietary.
