# Coinbase Commerce Setup

Coinbase Commerce has no sandbox — verification runs against the production API
(`api.commerce.coinbase.com`). Charges are USD-priced; the customer pays in the
coin+chain they pick on Coinbase's hosted page. Use a small amount ($5) on a
cheap chain.

## Step 1 — Register

1. Sign up at https://beta.commerce.coinbase.com (a Coinbase account works; the
   Commerce merchant is separate).
2. *Settings → Security → API keys* → create the **API key**
   (`COINBASE_COMMERCE_API_KEY`).
3. *Settings → Notifications* → add the webhook endpoint and copy the
   **shared secret** (`COINBASE_COMMERCE_WEBHOOK_SECRET`). The secret is
   separate from the API key — the adapter refuses to boot with only one.

## Step 2 — Webhook URL (dashboard-configured!)

Unlike the other crypto providers, the webhook URL is NOT sent per-charge — it
lives in the dashboard. Point it at:

```
<PUBLIC_BASE_URL>/webhooks/coinbase-commerce
```

With a throwaway cloudflared tunnel the hostname changes every run — update the
dashboard setting each session, or use a named tunnel.

## Step 3 — Env

```
COINBASE_COMMERCE_API_KEY=<api key>
COINBASE_COMMERCE_WEBHOOK_SECRET=<shared secret>
```

## Step 4 — Verification checklist (spec unknowns flagged in the adapter)

```bash
pnpm --filter @paykit-e2e/live-verify verify -- coinbase-commerce --amount 5
```

The adapter header (`packages/coinbase-commerce-adapter/src/adapter.ts`) lists
exactly what was built from published SDKs and needs live confirmation. Record
each item in `docs/crypto-live-acceptance-tests.md`:

- [ ] Charge create succeeds (`X-CC-Api-Key` + `X-CC-Version` accepted);
      hosted page opens
- [ ] Webhook arrives; HMAC-SHA256 over the raw body verifies against the
      shared secret (`X-CC-Webhook-Signature`)
- [ ] `metadata.paykit_transaction_id` is echoed on the event, and the ledger
      credits the exact USD amount on `charge:confirmed`
- [ ] Event names: confirm `charge:delayed` / `charge:resolved` are the real
      spellings (adapter's biggest flagged unknown)
- [ ] `pricing.local` is present on webhook charges (not just the request's
      `local_price`)
- [ ] Underpay a charge deliberately: confirm the timeline `context` spelling
      for UNDERPAID and that paykit quarantines instead of crediting
- [ ] `payments[].value.local` carries the USD equivalent, not the crypto
      amount
- [ ] Refund: `POST /admin/billing/refund` answers **501** (provider has no
      refund API) — then walk the manual runbook in
      [refund-flows.md](./refund-flows.md#coinbase-commerce--no-refund-api-operator-runbook)
      and confirm the ledger adjustment lands
- [ ] Reconciliation: `GET /charges` cursor pagination lists the paid charge

After all boxes pass, update the "NOT VERIFIED END-TO-END" header in the
adapter and the README provider matrix.
