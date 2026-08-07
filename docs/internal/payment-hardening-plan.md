# Payment Orchestration Hardening — Plan

> Trạng thái: **đang implement.** Money model (§4) và compliance boundary (§3.6) đã landed trên
> integration branch; phần còn lại theo thứ tự ở §8.
> Base: `feat/v3-phase-03-nowpayments-adapter` @ `50bdd25`.
> Integration branch: `hardening/payment-orchestration`.

Tài liệu này là contract cho công việc còn lại. §7 mô tả ownership theo workstream — ranh giới đó
vẫn đúng khi làm tuần tự một mình, chỉ khác là không cần worktree song song: mỗi workstream là một
nhóm commit trên integration branch, theo thứ tự ở §8.

---

## 1. Kiến trúc hiện tại

### 1.1 Package graph (workspace `packages/*`, pnpm)

```
core (@vibecc/paykit)            — types, adapter contract, errors, money, metrics. Zero deps.
  ↑
auth-core (@vibecc/paykit-auth-core) — Drizzle schema + repos + auth primitives. Zero deps (peer: drizzle).
  ↑
server (@vibecc/paykit-server)   — Hono routes, refund-core, webhook router, createPaykit.
  ↑                                 deps: core, auth-core, zod
  ├── service (@vibecc/paykit-service) — standalone /v1 API + auth planes + config. deps: server, cli, adapters
  └── workers (@vibecc/paykit-workers) — reconciler. deps: core (imports server types at runtime)

adapters (stripe|sepay|vnpay|momo|zalopay|nowpayments|bitpay|cryptomus|binance)
  — zero deps, implement PaymentProviderAdapter from core. Never import server/auth-core.
```

`packages/core/__tests__/no-cross-imports.test.ts` giữ ràng buộc adapter ⇏ server. Phải duy trì.

### 1.2 Database

Schema `paykit`, migration runner: `packages/cli` + `migrations/manifest.json` (advisory lock
`paykit.migrate`, id tuần tự `001`…`018`). `packages/cli/migrations/` là bản copy build-time
(`copy:migrations` script) — không sửa tay.

Bảng liên quan: `payment_transactions`, `ledger_entries`, `balance_projections`,
`webhook_events`, `pending_refunds`, `idempotency_records`, `reconciliation_runs`, `discounts`.

Money: mọi cột tiền là `NUMERIC(20,6)` mang nghĩa **integer micros** — mismatch có chủ đích
gây ra pattern `.split(".")[0]` rải rác (§2, F9).

### 1.3 Transaction boundaries hiện tại

| Flow | Boundary | Network call trong tx? |
|---|---|---|
| Checkout (`checkout-router.ts`) | tx1: discount consume + insert row → commit. Sau đó `adapter.createCheckout()`, rồi UPDATE providerRef (không tx). | Không, nhưng có 2 failure window không recover được |
| Webhook (`webhook-router.ts`) | Một tx duy nhất: dedup insert → `SELECT FOR UPDATE` payment row → `onBeforeCredit()` → ledger → status | **Có** — `onBeforeCredit` là external screening, chạy khi đang giữ row lock |
| Refund (`refund-core.ts`) | tx1 reserve (FOR UPDATE) → commit → `adapter.refund()` ngoài lock → tx2 finalize | Không — pattern này đúng, giữ lại |
| Reconcile (`v15-orchestrator.ts`) | Không tx bao ngoài; advisory lock qua `db.execute()` trên pool | Có, nhưng không giữ lock DB |

### 1.4 Invariants đang được bảo vệ (giữ nguyên, không phá)

- `UNIQUE (provider, source_id, entry_type) WHERE source_id IS NOT NULL` trên `ledger_entries`
  → chống double-credit khi provider resend. (migration 009)
- `UNIQUE (tenant_id, idempotency_key)` trên `payment_transactions` → chống cross-tenant key replay.
- `PRIMARY KEY (provider, event_id)` trên `webhook_events` → dedup event.
- `UNIQUE (provider, idempotency_key)` trên `pending_refunds`.
- `PRIMARY KEY (tenant_id, currency_code)` trên `balance_projections` → multi-wallet.
- Refund reserve-then-reconcile: `remaining = original + Σcommitted + Σreserved` tính dưới
  `FOR UPDATE` ⇒ concurrent refund không vượt captured. (`refund-core.ts:161-183`)
- `settlement-amount-guard.ts`: rail payer-controlled phải so requested vs received trước credit.

---

## 2. Failure windows đã xác định (verified bằng source, không suy đoán)

Xếp theo severity. Mỗi dòng có citation `file:line` để agent tra lại.

### F1 — Refund thứ hai bị mất hoàn toàn khỏi ledger *(severity: money loss, cao nhất)*
`webhook-router.ts:276` dùng `sourceId: evt.providerRef` (= payment/session ref) làm idempotency
source cho ledger refund. UNIQUE `(provider, source_id, entry_type)` khiến refund partial **thứ hai**
của cùng payment trùng row refund thứ nhất → `inserted=false` → `applyDelta` **không chạy**
(`:284`) → tiền không bị trừ khỏi balance, nhưng response vẫn 200. Refund thứ 3, 4… cũng vậy.

### F2 — Partial refund đặt payment thành `refunded`
`webhook-router.ts:303` gọi `updateTransactionStatus(..., "refunded")` vô điều kiện, không so
refund amount với captured amount. Refund $1 trên payment $100 → payment coi như hoàn toàn.
Enum status không có `partially_refunded` (migration 010/011).

### F3 — Stripe refund delta dùng cumulative amount
`stripe-adapter/src/adapter.ts` case `charge.refunded`: `refundAmountMicros = charge.amount_refunded`.
Stripe docs xác nhận `Charge.amount_refunded` là **running total**, còn `Refund.amount` là số của
một refund đơn lẻ ([Charge object](https://docs.stripe.com/api/charges/object),
[Refund object](https://docs.stripe.com/api/refunds/object)). Refund partial thứ hai báo cumulative
⇒ delta sai. Docs của chính Stripe chỉ hướng: `charge.refunded` trả về Charge, "Listen to
`refund.created` for information about the refund"
([events](https://docs.stripe.com/api/events/types)).

### F4 — Stripe refund webhook không match được row (kể cả Dashboard refund)
Adapter dùng `providerRef = charge.metadata?.checkoutSessionId ?? charge.id`. Nhưng `createCheckout`
chỉ set metadata trên **Checkout Session**, không set `payment_intent_data.metadata`. Metadata
KHÔNG tự propagate Session → Charge; chỉ PaymentIntent copy metadata sang Charge tại thời điểm tạo
charge (one-time snapshot), và Checkout chỉ set PI metadata qua `payment_intent_data[metadata]`
([Payment Intents](https://docs.stripe.com/payments/payment-intents),
[Session create](https://docs.stripe.com/api/checkout/sessions/create)). Vậy
`charge.metadata.checkoutSessionId` luôn undefined → fallback `charge.id`, nhưng DB lưu session id
⇒ `webhook-router.ts:143` `if (!row) return;` **im lặng bỏ event** — và dedup row đã insert ở `:128`
nên event vĩnh viễn không retry được (xem F5).

### F5 — Webhook inbox không tồn tại: "đã nhận" = "đã xử lý"
`webhook-router.ts:126-143`: `tryRecordWebhookEvent` insert dedup row **trước**, cùng transaction;
nếu không tìm thấy payment row thì `return` → tx commit kèm dedup row. `webhook_events` chỉ có
`(provider, event_id, recorded_at)` — không state, không payload, không attempt counter, không retry
worker. Event mất là mất hẳn. Window này thật vì checkout persist `providerRef` **sau** khi gọi
provider (F6), nên webhook có thể đến trước.

### F6 — Checkout không idempotent end-to-end
`checkout-router.ts`:
- `:123` chỉ replay khi `existing.providerRef !== null`. Nếu row có nhưng providerRef null (crash
  giữa insert và update), request 2 rơi xuống `createTransaction` → vi phạm
  `UNIQUE (tenant_id, idempotency_key)` → 500, không recover.
- Replay response `:124-129` có shape **khác** response gốc `:209-219`: mất `webUrl`, `qrUrl`,
  `mobileDeeplink`, `expiresAt`. Client retry không dùng được.
- Hai request đồng thời cùng key: cả hai miss lookup `:122`, cả hai `createTransaction` → một cái
  500. Không có claim, không truyền idempotency key sang PSP ⇒ có thể tạo 2 PSP session.
- `:189-207` UPDATE providerRef ngoài mọi transaction; provider thành công + UPDATE fail ⇒ session
  tồn tại ở PSP mà DB không biết ref → webhook không match mãi.
- `/v1` router (`service/src/v1/router.ts:133-177`) **không đọc Idempotency-Key** cho checkout.

### F7 — Idempotency fencing: claim cũ ghi đè claim mới
`idempotency.repo.ts:150-172` `finalizeIdempotency` chỉ guard `state='in_flight'`, **không guard
ownership**. Kịch bản: A claim → handler của A vượt TTL 120s → B reclaim (`:101-121` set lại
`in_flight` với bodyHash của B) → A finalize → UPDATE của A **match row của B** và ghi response của
A lên đó. Comment `:146-148` khẳng định điều này không xảy ra — sai. `releaseIdempotency`
(`:179-192`) cùng lỗi: A xóa claim in_flight của B ⇒ request thứ ba re-run mutation. Cần
`claim_token` / generation.

### F8 — Session advisory lock qua pooled connections
`workers/src/reconcile/advisory-lock.ts:15-26`: `pg_try_advisory_lock` (session-scoped) phát qua
`db.execute()` trên Drizzle **pool**. Acquire và release rơi vào 2 backend khác nhau.
PostgreSQL docs §13.3 xác nhận: session-level lock chỉ giải phóng khi unlock tường minh hoặc session
kết thúc, và không tôn trọng transaction semantics
([Advisory Locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS)).
Hệ quả: (a) unlock chạy sai backend → trả false, lock leak tới khi backend đó chết; (b) connection
leak lock đó được checkout lại → *session đã giữ lock* nên re-acquire **thành công giả** (docs: một
session đang giữ lock luôn thành công ở request tiếp theo) ⇒ hai reconciler chạy song song.

### F9 — Fractional micros + silent truncation
Cột micros là `NUMERIC(20,6)` (`payment-transactions.ts:18`, `ledger-entries.ts:19`,
`pending-refunds.ts:31`) nhưng mọi chỗ đọc đều `.split(".")[0]`: `refund-core.ts:98,169,176,352`;
`v15-orchestrator.ts:199,220,248,249`; `core/money/micros.ts:12`; `differ.ts:61`;
`react/lib/format-money.ts:14`. Nếu bất kỳ đường nào ghi phần thập phân, tiền bị cắt âm thầm.
Không có CHECK `amount_micros > 0` ở bất kỳ bảng tiền nào.

### F10 — External compliance call khi đang giữ row lock
`webhook-router.ts:204-220`: `await deps.onBeforeCredit(evt)` nằm trong `db.transaction()` và **sau**
`SELECT … FOR UPDATE` (`:141`). Screening (Chainalysis/TRM) giữ row lock suốt latency + timeout của
HTTP call. Multi-instance: webhook resend cùng payment sẽ block trên lock đó.

### F11 — Reconciliation status model & pagination
`v15-orchestrator.ts`: `summary.status` hardcode `"completed"` (`:128`) trong khi `runStatus` tính
riêng (`:121`); `lock_held` trả `status: "failed"` (`:66`) — báo lỗi giả cho contention;
`completeRun` collapse `partial → "failed"` (`:145`) nên mất phân biệt; **query refund status bằng
cách gọi lại command `adapter.refund()`** (`:197`); không cursor/checkpoint; không per-provider
timeout; `paykitRows` select không giới hạn (`:74-79`) → unbounded memory; `pollPendingRefunds`
không có lock per-row ⇒ hai worker double-poll cùng reservation.

### F12 — Refund áp lên payment chưa từng được credit
`webhook-router.ts:264` case `payment.refunded` không guard `row.status` (khác với `completed`
`:148`, `expired` `:311`, `failed` `:322`). Payment đang `pending` vẫn nhận ledger debit.

### F13 — Currency không được verify chéo
Webhook credit dùng `evt.currencyCode` (`:230,241`) chứ không so với `row.currencyCode`. Refund
tương tự (`:271,285`). Payment VND + event USD → ledger/balance sai wallet.

### F14 — Duplicate money logic + currency dispatch sai
`checkout-router.ts:99` `currency = adapter.supportedCurrencies[0] ?? "USD"` — bỏ qua ý định caller.
`v1/router.ts:90,95` copy lại phép đổi USD/VND thay vì dùng `vndToMicros`, và
`BigInt(parsed.amountVnd) * 1_000_000n` bỏ qua integer guard của `vndToMicros`.

### F15 — Discount consume side effect và transaction commit
`apply-discount.ts` bắt lỗi `consume()` rồi **fallback full price trong cùng transaction** đã có side
effect không rõ trạng thái. `checkout-router.ts:145-176` commit tx đó luôn.

---

## 3. Target architecture

### 3.1 Quyết định thiết kế (trả lời trực tiếp các câu hỏi bắt buộc)

| Câu hỏi | Quyết định | Lý do |
|---|---|---|
| `payment_transactions` là aggregate hay attempt? | **Aggregate root.** Không tách `payment_attempts` ở đợt này. | Chưa có feature provider fallback/retry nào cần nhiều attempt trên một payment. Tách bảng bây giờ là over-engineering (YAGNI). Điều kiện kích hoạt tách sau: khi thêm provider failover hoặc retry-with-different-provider. Ghi trong ADR-0001. |
| Cần bảng `payment_attempts`? | Không. Thay vào đó thêm state `provider_creating`/`provider_created` + `provider_request_id` để đóng window F6. | Đủ để recover mà không đổi cardinality. |
| Webhook inbox giữ raw hay normalized? | **Cả hai.** `raw_payload` (redacted, bounded) + `payload_hash` + `normalized_payload`. | Raw cần để re-verify signature khi replay (adapter verify trên raw bytes). Normalized cần để match/retry mà không phải chạy lại parse. |
| Refund là aggregate riêng? | **Có — bảng `refunds` mới.** Ledger vẫn là accounting effect, không phải source of truth. | F1/F2 không sửa được nếu refund chỉ derive từ ledger: cần per-refund identity, status lifecycle, failure reason. |
| Ledger hiện tại là gì? | **Wallet/balance event ledger**, không phải double-entry accounting. `balance_projections` là ví; entry là event làm thay đổi ví. | Không có tài khoản đối ứng, không có bút toán cân. Ghi rõ trong ADR-0001 để tránh ai đó áp kỳ vọng double-entry. |
| State nào persisted, state nào derived? | Persisted: `payment_transactions.status`, `refunds.status`, `webhook_inbox.state`. Derived: `refunded_total` (SUM từ `refunds` WHERE status='succeeded'), `balance` (projection có thể rebuild từ ledger). | `refunded_total` derived tránh drift; status persisted để index/query. |
| Source of truth của refund status? | `refunds.status`. Provider webhook và reconciler đều ghi vào đó qua transition function. | |
| Provider reference nào dùng để lookup webhook? | `payment_transactions.provider_ref`. Ưu tiên match theo internal transaction id từ provider metadata trước, provider_ref sau. | |
| Internal transaction id truyền sang PSP bằng cách nào? | Stripe: **cả** `metadata` (Session) **và** `payment_intent_data.metadata` (→ PaymentIntent → Charge → resolve được từ refund event). Provider khác: field order/reference id sẵn có (NowPayments `order_id`, v.v. — đã đúng). | Verified: metadata không tự chảy Session→Charge. Xem ADR-0003. |
| Migrate dữ liệu cũ? | Backfill `refunds` từ `pending_refunds` + `ledger_entries` refund rows. `pending_refunds` giữ lại read-only một release rồi mới drop. | §9. |

### 3.2 Payment state machine (mở rộng, không rename state cũ)

```
                        ┌──────────────────────────────────────────┐
                        ▼                                          │
created(pending) ──► provider_creating ──► awaiting_payment ──► screening_pending
                            │                    │                   │
                            │                    │                   ├──► credited(completed)
                            ▼                    ▼                   └──► quarantine
                         failed              expired
                                                                 credited
                                                                    │
                                                    ┌───────────────┼───────────────┐
                                                    ▼               ▼               ▼
                                          partially_refunded ──► refunded   refund_pending_webhook
```

Tương thích ngược: giữ nguyên tên `pending`, `completed`, `failed`, `expired`, `refunded`,
`quarantine`, `refund_pending_webhook`. **Thêm**: `provider_creating`, `awaiting_payment`,
`screening_pending`, `partially_refunded`.

`pending` giữ nghĩa cũ cho row lịch sử; row mới dùng `provider_creating` → `awaiting_payment`.
Mọi đọc phải coi `pending` ≡ `awaiting_payment` trong một release (compat shim ở transition module).

Transition tập trung tại `packages/auth-core/src/domain/payment-status.ts` (mới):
allowed-transition map + conditional UPDATE theo expected state. Không còn `updateTransactionStatus`
nhận string tự do.

### 3.3 Webhook inbox lifecycle

```
received ──► processing ──► processed
   │             │  ▲
   │             │  └── retry (next_retry_at, backoff+jitter)
   │             ├──► failed ──► dead_letter (attempts >= max)
   └──► unmatched ──┘   (không tìm được payment row; replay được)
```

Event chỉ `processed` sau khi business transaction commit thành công. Dedup theo
`(provider, event_id)` **không** làm mất khả năng retry: dedup row là inbox row, state của nó quyết
định có xử lý lại hay không. `payload_hash` khác trên cùng `event_id` → ghi cảnh báo + metric, không
ghi đè raw cũ.

### 3.4 Refund lifecycle

```
requested ──► submitted ──► succeeded          (ledger debit + balance delta, một lần duy nhất)
    │            │  └────► failed              (không đụng ledger, giải phóng headroom)
    │            └───────► pending_webhook
    └──► rejected (gate: exceeds remaining / not refundable / currency mismatch)
```

Ledger `source_id` cho refund = **internal `refunds.refund_id`** (ổn định, không phụ thuộc quirk
provider). `UNIQUE (provider, provider_refund_id)` trên `refunds` để map webhook → refund row.
`NormalizedRefundEvent` mới trong core mang `providerRefundId` + delta (không cumulative).

### 3.5 Reconciliation

- Advisory lock: `pg_advisory_xact_lock` trong một transaction được pin connection, hoặc checkout
  `pg.Client` riêng. Quyết định + chứng minh trong ADR-0002.
- Contract adapter tách: `createRefund` (command) / `getRefund` (query) / `listTransactions` /
  `listRefunds`, optional theo capability. Bỏ hẳn việc gọi `refund()` để query status.
- Cursor/checkpoint per provider, bounded page, per-provider timeout, backoff+jitter.
- Run status: `completed` | `partial` | `failed` | `skipped` — không collapse. `skipped` cho lock
  contention (không phải lỗi).

### 3.6 Compliance boundary

```
webhook tx1:  inbox row → match payment → status=screening_pending → COMMIT   (không network call)
worker:       external screening (retry, timeout, idempotent theo transaction_id)
      tx2:    screening_pending → credited | quarantine  (+ audit row)
```

`onBeforeCredit` giữ signature public nhưng được gọi từ worker, không từ trong DB transaction.
Breaking change về **thời điểm** gọi → document ở §10 và ADR-0004.

---

## 4. Money model

Đổi cột micros `NUMERIC(20,6)` → `NUMERIC(30,0)`.

Lý do chọn `NUMERIC(30,0)` thay vì `BIGINT`: `BIGINT` max ≈ 9.22e18 micros ≈ 9.22e12 đơn vị tiền —
đủ cho USD nhưng VND micros vượt trần nhanh hơn 1000×, và `NUMERIC(30,0)` giữ được kiểu decimal
string mà Drizzle/`pg` đang round-trip (không phá code đọc hiện tại). Trade-off: numeric chậm hơn
bigint — không đáng kể ở khối lượng này.

Migration bắt buộc:
1. Pre-check: `SELECT count(*) WHERE amount_micros <> trunc(amount_micros)` trên mọi bảng tiền.
   Nếu > 0 → **RAISE EXCEPTION**, không tự truncate.
2. `ALTER … TYPE NUMERIC(30,0)`.
3. Thêm CHECK: `amount_micros > 0` (payment_transactions, refunds), `amount_micros <> 0`
   (ledger_entries — refund là số âm), `currency_code ~ '^[A-Z]{3}$'`.
4. Down migration có, nhưng ghi rõ: revert type là non-destructive, revert CHECK là non-destructive;
   không có dữ liệu nào bị mất khi rollback.

Sau khi đổi type, xóa toàn bộ `.split(".")[0]`: thay bằng một helper duy nhất trong
`core/money/micros.ts` (`parseMicros` throw trên input không hợp lệ, không trả 0 âm thầm).

---

## 5. Public API compatibility

Không được phá:
- Barrel exports của `core`, `auth-core`, `server`, `workers` (có test:
  `core/__tests__/package-exports.test.ts`, `barrel-exports.test.ts`, `v15-barrel.test.ts`).
- `PaymentProviderAdapter` shape — thêm method **optional** thôi (`getRefund?`, `listRefunds?`).
  9 adapter hiện có không được buộc sửa (`core/__tests__/adapter-interface.test.ts`).
- OpenAPI spec `/v1` (`service/__tests__/openapi-spec.test.ts`, `sdk/__tests__/spec-snapshot.test.ts`)
  — thêm field mới được, xóa/rename thì không.
- Error `code` hiện có phải giữ; code mới thêm vào taxonomy `core/errors`.
- HTTP status mapping của refund route (`admin-refund-route-characterization.test.ts` đang lock).

Thay đổi có breaking behaviour (phải document, không im lặng):
1. Checkout replay response giờ **đủ field** (trước đây thiếu) — thêm field, không xóa.
2. `payment.refunded` partial không còn set `refunded` → set `partially_refunded`. Consumer đọc
   status phải xử lý state mới.
3. `onBeforeCredit` gọi từ worker thay vì inline webhook → latency của hook không còn block webhook
   response; nhưng credit không còn đồng bộ với webhook 200.
4. Webhook trả 200 khi `unmatched` (trước đây cũng 200 nhưng mất event) — semantics giống, hành vi
   nội bộ khác.

---

## 6. Migration allocation (khóa trước để tránh collision)

Bảng dưới đây phản ánh **trạng thái thật của repo**, không phải phân bổ dự kiến ban đầu. Ba id đã
đổi nội dung so với bản thiết kế, mỗi lần vì cùng một lý do: một status mới và bảng mà status đó dựa
vào không tách được thành hai migration.

- `021`: `screening_pending` đi cùng bảng `screening_jobs` (thiết kế ban đầu đặt status ở `026`) —
  thêm status mà không có bảng thì payment không có nơi nào để chờ verdict.
- `022`: `refunds` + `partially_refunded` (thiết kế đặt bảng ở `026`, status ở `022`) — không có
  amount per-refund thì không có gì để so với captured amount, nên status không biểu diễn được.
- `023`: `reconciliation_run_status` (thiết kế đặt ở `027`) — kéo lên vì cùng workstream với `022`
  và không phụ thuộc migration nào ở giữa. Hai cột `cursor_json` / `provider` **không** nằm trong
  `023`: chưa có code nào đọc chúng, và thêm cột không ai dùng là đúng loại schema drift phần
  pagination sẽ phải sửa lại. Chúng đi cùng migration của pagination.

`provider_creating` và `awaiting_payment` chưa landed — chúng thuộc workstream checkout
idempotency (F6), không phải refund.

| id | slug | trạng thái | nội dung |
|---|---|---|---|
| 019 | `money_integer_micros` | **đã landed** | `NUMERIC(20,6)` → `NUMERIC(30,0)` + pre-check fail-loud |
| 020 | `money_and_currency_invariants` | **đã landed** | CHECK amount > 0 / <> 0 + ISO-4217 shape trên mọi cột currency khóa ví |
| 021 | `screening_jobs` | **đã landed** | status `screening_pending` + bảng `screening_jobs` |
| 022 | `refunds` | **đã landed** | bảng `refunds` + UNIQUE + status `partially_refunded` + backfill từ `pending_refunds`/ledger |
| 023 | `reconciliation_run_status` | **đã landed** | thêm `partial`, `skipped` vào CHECK |
| 024 | `payment_status_lifecycle` | còn lại | thêm `provider_creating`, `awaiting_payment` vào CHECK |
| 025 | `idempotency_claim_token` | còn lại | `claim_token uuid`, `claim_generation int`, index |
| 026 | `checkout_provider_request` | còn lại | `provider_request_id`, `provider_created_at` trên payment_transactions |
| 027 | `webhook_inbox` | còn lại | bảng `webhook_inbox` + index + backfill từ `webhook_events` |
| 028 | `reconciliation_cursor` | còn lại | `cursor_json`, `provider` + index (đi cùng pagination) |

Mỗi migration: `NNN_<domain_slug>.up.sql` + `.down.sql` + entry trong `migrations/manifest.json`.
**Không** đưa số phase / mã finding vào tên file hay comment SQL (rule
`.claude/rules/review-audit-self-decision.md` §5).

Chú ý conflict: `manifest.json` là file duy nhất **mọi agent** phải sửa. Quy tắc: mỗi agent chỉ
append đúng entry của mình, đúng vị trí theo id tăng dần. Orchestrator resolve conflict ở đây bằng
tay (union, sort theo id) — đây là trường hợp duy nhất được phép.

---

## 7. Worktree ownership

Foundation của Agent 0 **phải merge trước** vì nó tách `webhook-router.ts` (424 dòng, vượt giới hạn
200) thành các handler module riêng — nếu không, Agent 1/3/5 cùng sửa một file.

### Agent 0 — foundation (`hardening/architecture`, `../paykit-architecture`)
Owns:
- `docs/internal/payment-hardening-plan.md`, `docs/adr/*`
- `packages/auth-core/src/domain/payment-status.ts` **(mới)** — transition map + conditional update
- `packages/server/src/routes/webhooks/handlers/*.ts` **(mới)** — tách từ `webhook-router.ts`:
  `payment-completed.ts`, `payment-refunded.ts`, `payment-terminal.ts`, `payment-anomaly.ts`
- `packages/server/src/routes/webhooks/webhook-router.ts` — **chỉ** rút xuống dispatch shell
- `packages/core/src/adapters/refund-types.ts` — thêm `NormalizedRefundEvent`
- `packages/core/src/adapters/adapter.ts` — thêm optional `getRefund`/`listRefunds`
- `migrations/020_*`
Không implement business logic mới. Chỉ move + contract.

### Agent 1 — webhook inbox (`hardening/webhook-inbox`, `../paykit-webhook`)
Owns: `auth-core/src/db/schema/webhook-inbox.ts`, `auth-core/src/db/repos/webhook-inbox.repo.ts`,
`server/src/routes/webhooks/webhook-router.ts` (dispatch + inbox lifecycle),
`server/src/routes/webhooks/inbox-matcher.ts` (mới), `workers/src/webhook-retry/*` (mới),
`migrations/023_*`, test tương ứng.
Blocked by: Agent 0.

### Agent 2 — checkout idempotency (`hardening/checkout-idempotency`, `../paykit-checkout`)
Owns: `auth-core/src/db/repos/idempotency.repo.ts`,
`auth-core/src/db/schema/idempotency-records.ts`,
`server/src/routes/checkout/checkout-router.ts`, `server/src/routes/checkout/checkout-service.ts`
(mới — logic dùng chung cho embedded + `/v1`), `service/src/v1/router.ts` (chỉ block `/checkouts`),
`server/src/routes/subscriptions/idempotency-middleware.ts`, `migrations/021_*`, `022_*`.
Blocked by: Agent 0, Agent 5 (money helper).

### Agent 3 — refund model (`hardening/refund-model`, `../paykit-refund`)
Owns: `auth-core/src/db/schema/refunds.ts`, `auth-core/src/db/repos/refund.repo.ts`,
`server/src/services/refund-core.ts`,
`server/src/routes/webhooks/handlers/payment-refunded.ts`,
`stripe-adapter/src/adapter.ts` (refund + webhook mapping + `payment_intent_data`),
`migrations/024_*`.
Blocked by: Agent 0, Agent 5.

### Agent 4 — reconciliation (`hardening/reconciliation`, `../paykit-reconcile`)
Owns: `workers/src/reconcile/advisory-lock.ts`, `workers/src/reconcile/v15-orchestrator.ts`,
`workers/src/reconcile/orchestrator.ts`, `workers/src/reconcile/summary.ts`,
`workers/src/reconcile/cursor.ts` (mới), `auth-core/src/db/repos/reconciliation.repo.ts`,
`auth-core/src/db/schema/reconciliation-runs.ts`, `migrations/025_*`.
Blocked by: Agent 0, Agent 3 (`getRefund` contract).

### Agent 5 — invariants / money / compliance (`hardening/domain-invariants`, `../paykit-invariants`)
Owns: `core/src/money/*`, `core/src/types/money.ts`, `core/src/errors/index.ts`,
`server/src/routes/webhooks/handlers/payment-completed.ts` (currency guard + screening handoff),
`server/src/routes/checkout/apply-discount.ts`, `workers/src/screening/*` (mới),
`auth-core/src/db/schema/screening-jobs.ts`, `migrations/019_*`, `026_*`.
Blocked by: Agent 0. **Merge sớm** — Agent 2/3/4 phụ thuộc money helper.

### Agent 6 — tests (`hardening/failure-tests`, `../paykit-tests`)
Owns: `packages/*/__tests__/**` mới, `e2e/**`, test harness dùng chung
(`packages/server/__tests__/_harness/*`). Không sửa business logic ngoài test seam được orchestrator
phê duyệt. Bắt đầu **sau** khi ADR + public interface chốt (sau Agent 0 merge), chạy song song với
2/3/4/5 ở phần contract test.

### Agent 7 — integration (`hardening/integration`, `../paykit-integration`)
Chỉ merge + resolve conflict + fix integration. Không design lại feature.

---

## 8. Merge order

Thực tế đã đi khác kế hoạch ban đầu: workstream money và compliance được làm trước (không cần
foundation của Agent 0, vì cả hai chỉ thêm nhánh vào `payment.completed` chứ không tách file), và
phần còn lại làm **tuần tự trên integration branch** thay vì mỗi workstream một branch. Lý do: chi
phí merge của branch-per-workstream chỉ đáng bỏ ra khi các workstream chạy song song thật sự.

```
✅ 1. money invariants        (019, 020 — micros integer + CHECK; đã merge)
✅ 2. compliance screening    (021 — screening_jobs + boundary; đã merge)
   3. payment status lifecycle(022 — mở rộng CHECK; nền cho partial refund + checkout state)
   4. checkout idempotency    (023, 024 — claim token + provider request)
   5. webhook inbox           (025 — inbox thay INSERT-first dedup)
   6. refund model            (026 — bảng refunds + Stripe mapping)
   7. reconciliation          (027 — advisory lock pinned + cursor + run status)
   8. duplicate money logic + discount consume ordering
   9. failure tests trên Postgres thật
```

Sau mỗi bước: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — chỉ tiếp tục khi build và
typecheck exit 0, test pass, và lint **không tăng** so với baseline 238.

---

## 9. Migration & backfill strategy

**019 (money)** — pre-check fail-loud. Nếu môi trường nào có fractional micros, migration dừng và
báo rõ bảng/số row; vận hành phải quyết định trước khi tiếp tục. Không auto-truncate.

**023 (webhook_inbox)** — backfill từ `webhook_events`: mỗi row cũ → inbox row
`state='processed'`, `raw_payload=NULL`, `normalized_payload=NULL`, `processed_at=recorded_at`.
Giữ `webhook_events` một release (dedup cũ vẫn hoạt động) → drop ở release sau. Không drop trong
đợt này.

**024 (refunds)** — backfill 2 nguồn:
1. `pending_refunds` → `refunds` (map state: queued→requested, processing→submitted,
   completed→succeeded, failed→failed, timed_out→failed + `failure_code='reconcile_timeout'`).
2. `ledger_entries WHERE entry_type='refund'` không có `refunds` row tương ứng → tạo row
   `status='succeeded'` với `provider_refund_id` từ `metadata_json->>'providerRefundId'`
   (nullable — refund lịch sử có thể không có).
`pending_refunds` giữ read-only; `refund-core.ts` ghi vào `refunds`, đọc remaining từ `refunds`.

**020/025 (CHECK enum)** — pattern giống 010/011: `DROP CONSTRAINT IF EXISTS` rồi `ADD CONSTRAINT`
với tập giá trị mở rộng. Idempotent, rollback được.

**Rollback**: mọi migration có `.down.sql`. 019 down là widen type (an toàn). 023/024 down drop
bảng mới — mất inbox/refund row **tạo sau khi migrate**; document là destructive-on-rollback, và
rollback chỉ được làm khi chưa có traffic mới. 021/022/025/026 down là drop column/table mới, an toàn.

---

## 10. Test strategy

Framework: vitest (root `vitest.config.ts`, include `packages/**/__tests__/**`). CI: `.github/workflows/ci.yml`
— matrix node 20/22 chạy typecheck/lint/build/test với mock DB; job `service-cold-start` chạy
Postgres 16 thật, gate bằng `PAYKIT_E2E_DATABASE_URL`.

**Vấn đề đã biết**: test hiện tại mock repo module (`vi.mock`) nên **không** kiểm chứng được
`FOR UPDATE`, advisory lock, ON CONFLICT, CHECK constraint. Concurrency/locking bắt buộc phải test
trên Postgres thật.

Agent 6 phải:
1. Mở rộng job `service-cold-start` (hoặc thêm job `integration-pg`) chạy toàn bộ test gate bằng
   `PAYKIT_E2E_DATABASE_URL`. Không mock transaction/lock behaviour.
2. Provider contract test suite dùng chung, adapter opt-in theo capability: create checkout, stable
   provider ref, provider-side idempotency, signature verify/reject, event normalization, duplicate
   webhook, refund, partial refund, pagination, timeout, currency/amount normalization.
3. Fault injection tại các điểm: before DB tx, after insert, before provider call, after provider
   success, before provider_ref persist, after inbox insert, before/after ledger insert, before
   balance projection update, after refund provider success, before refund finalize, during cursor
   update.
4. Invariant assertion sau mỗi fault: không double credit/debit, không mất webhook, refund total
   ≤ captured, projection rebuild được từ ledger, event chưa xong vẫn retry được, replay trả cùng
   logical result, tenant A không thấy dữ liệu tenant B.
5. Migration test: apply từ schema cũ (`001`→HEAD) trên DB trắng + rollback test cho migration
   reversible.

---

## 11. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Migration 019 fail ở môi trường có fractional micros | Cao | Pre-check fail-loud; chạy query kiểm tra trên prod snapshot trước |
| 8 workstream, 6 branch sửa `manifest.json` | Trung bình | Allocation khóa trước ở §6; orchestrator resolve union+sort |
| `webhook-router.ts` bị 3 agent cần | Trung bình | Agent 0 tách file trước, merge đầu tiên |
| Test hiện tại mock DB → sửa lock mà test vẫn pass giả | Cao | Agent 6 bắt buộc dùng PG thật cho concurrency; không nhận PR lock nào chỉ có unit test mock |
| `onBeforeCredit` đổi thời điểm gọi (breaking) | Trung bình | ADR-0004 + document ở upgrade guide; giữ signature |
| Backfill `refunds` từ ledger thiếu `provider_refund_id` | Thấp | Cột nullable; reconciler bù dần |
| `pending` ≡ `awaiting_payment` trong 1 release | Trung bình | Compat shim ở transition module + test cả hai giá trị |
| 018 chưa commit (`packages/cli/migrations/*` untracked + manifest modified) | Thấp | Commit hoặc regenerate bằng `pnpm --filter cli build` trước khi tạo worktree — nếu không, worktree mới thiếu bản copy |

---

## 12. Điều khoản chưa quyết (cần user chốt trước khi implement)

1. **Scope thực tế**: 8 workstream × (migration + code + test PG thật) là khối lượng rất lớn.
   Có làm full một lượt, hay cắt thành 2 đợt (đợt 1: F1–F8 money-critical; đợt 2: compliance +
   reconciliation polish)?
2. **`NUMERIC(30,0)` vs `BIGINT`** cho micros — tôi chọn `NUMERIC(30,0)` (§4). User có ràng buộc nào
   khác (ví dụ tương thích tool BI đang đọc cột này) không?
3. **Drop `pending_refunds`**: giữ 1 release rồi drop, hay drop luôn ở 024?
4. **Playwright MCP không có trong session này** — research đã dùng WebFetch/WebSearch trực tiếp lên
   docs chính thức (Stripe, PostgreSQL 16). Nguồn ghi trong ADR. Nếu bắt buộc phải qua Playwright
   MCP thì cần bật MCP đó trước.
