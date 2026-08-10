---
title: "Fix NowPayments async-refund resolution + BitPay adapter (V3 Phase 02) + docs sync"
description: "Repair the broken pending_webhook→refunded webhook path, then build BitPay on the now-working infra, then sync stale README/docs."
status: completed
priority: P1
effort: 9h
branch: feat/v3-phase-03-nowpayments-adapter
tags: [v3, crypto, refund, nowpayments, bitpay, bugfix, docs]
created: 2026-05-29
blocks: [260529-1312-GH-03-v4-service-shell-and-auth]
---

# V3 — NowPayments refund-resolution fix + BitPay adapter + docs sync

## Context

V3 Phase 03 shipped `@xeko-git-1/paykit-nowpayments` with a `refund_pending_webhook`
payment state (migration 011). Analysis found the **resolution half of that flow
is broken**: the generic webhook router requires `evt.refundAmountMicros` on
`payment.refunded` (webhook-router.ts:178) but `parseNpIpn` never populates it
(webhook-events.ts:102-121). Net effect: a NowPayments `refunded` IPN is silently
skipped — status stays stuck at `refund_pending_webhook`, no ledger refund entry.
This is a financial-correctness regression in shipped code.

BitPay (V3 Phase 02) is documented as pending but has **no package** — only
doc/comment references. It would share the identical resolution path, so the bug
must be fixed first or BitPay inherits it.

## Phases

| Phase | Title | Priority | Effort | Status | Depends on |
|---|---|---|---|---|---|
| 01 | [Fix NowPayments async-refund resolution + regression test](phase-01-fix-nowpayments-refund-webhook-resolution.md) | P1 | 3h | completed | — |
| 02 | [BitPay adapter (V3 Phase 02)](phase-02-bitpay-adapter.md) | P2 | 4.5h | completed | 01 |
| 03 | [README + docs reality sync (V1.5/V2/V3)](phase-03-readme-and-docs-reality-sync.md) | P3 | 1.5h | completed | — |

## Sequencing rationale

- **01 first (keystone):** P0 correctness bug in the path BitPay will reuse. Fixing
  it on a single adapter + adding a server-integration regression test de-risks all
  future async-refund providers.
- **02 after 01:** BitPay mirrors NowPayments' package shape and reuses the
  `pending_webhook` server branch — only safe to build once resolution works.
- **03 anytime:** independent doc hygiene; README still says "V1 development".

## Key dependencies

- Migration 011 (`refund_pending_webhook`) already shipped — no new migration for 01.
- BitPay (02) likely needs **no** new migration (reuses 010 `quarantine` + 011 state).
- `appendLedgerEntryIdempotent` UNIQUE(provider, source_id, entry_type) — the
  race-protection primitive both admin-sync and webhook paths rely on.

## File-ownership map (no overlap across phases)

- 01: `packages/nowpayments-adapter/src/webhook-events.ts`, its `__tests__/`, new
  server-integration test under `packages/server/__tests__/` (or `e2e/`).
- 02: new `packages/bitpay-adapter/**` only.
- 03: `README.md`, `docs/*.md` only.

## Open questions

See per-phase files; the load-bearing one is NowPayments' refund-IPN amount field
(phase-01) — needs NowPayments IPN doc confirmation for partial-refund correctness.
