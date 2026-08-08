# ADR-0001 — Payment aggregate boundary và ngữ nghĩa ledger

- Trạng thái: Đề xuất
- Ngày: 2026-07-28
- Liên quan: [ADR-0003](0003-durable-webhook-inbox-replaces-insert-first-dedup.md), [ADR-0004](0004-stripe-refund-event-mapping.md)

## Context

Trước khi sửa refund và checkout, phải chốt: `payment_transactions` là aggregate root hay chỉ một
payment attempt, và `ledger_entries` là accounting ledger hay wallet event log. Hai câu này quyết
định refund model và việc có cần bảng `payment_attempts` không.

Quan sát trên code hiện tại:

- `payment_transactions` mang cả ý định thanh toán (`amount_micros`, `currency_code`, `tenant_id`) và
  trạng thái vòng đời (`status`) và tham chiếu provider (`provider_ref`, `provider_payment_id`). Một
  row = một lần thanh toán, không có khái niệm "thử lại với provider khác".
- `ledger_entries` không có tài khoản đối ứng, không có bút toán cân bằng. Mỗi row là một thay đổi
  đơn phương lên `balance_projections` (PK `(tenant_id, currency_code)`), áp bằng
  `balance.repo.applyDelta`. `entry_type` là lý do thay đổi, không phải account.
- Refund hiện được suy ra từ ledger: `sumRefundsByOriginalTransaction` cộng
  `ledger_entries WHERE entry_type='refund' AND metadata_json->>'originalTransactionId' = ?`.
  Không có identity cho từng refund.

## Decision

1. **`payment_transactions` là aggregate root**, không tách `payment_attempts` trong đợt này.
   Thay vào đó bổ sung state vòng đời (`provider_creating`, `awaiting_payment`, `screening_pending`,
   `partially_refunded`) và `provider_request_id` để đóng failure window giữa DB và PSP.

2. **`ledger_entries` là wallet/balance event ledger**, không phải double-entry accounting ledger.
   `balance_projections` là projection có thể rebuild bằng cách replay ledger theo
   `(tenant_id, currency_code)`.

3. **Refund trở thành aggregate riêng** (bảng `refunds`). Ledger vẫn ghi hiệu ứng lên balance, nhưng
   source of truth cho refund status là `refunds.status`. `source_id` của ledger refund entry là
   internal `refunds.refund_id`.

## Alternatives considered

**A. Tách `payment_attempts` ngay.** Cho phép nhiều attempt (provider fallback, retry với provider
khác) trên cùng một payment intent. Bỏ vì hiện chưa có feature nào cần: không có provider failover,
không có retry-with-different-provider. Thêm bảng bây giờ là tăng cardinality và join cost để đổi
lấy khả năng chưa dùng (YAGNI). Điều kiện kích hoạt tách sau: khi thêm provider failover hoặc khi
một payment cần giữ nhiều `provider_ref` đồng thời.

**B. Giữ refund derive từ ledger.** Không sửa được hai lỗi cốt lõi: refund partial thứ hai bị UNIQUE
`(provider, source_id, entry_type)` gộp vào refund thứ nhất (mất debit), và không thể biểu diễn
refund `pending`/`failed` (ledger chỉ ghi khi thành công). Refund cần identity + lifecycle riêng.

**C. Chuyển ledger sang double-entry thật.** Đúng về mặt kế toán nhưng là viết lại toàn bộ money
layer, đổi mọi migration và mọi consumer của `balance_projections`. Ngoài scope; và bài toán cần giải
là financial correctness của refund/webhook, không phải chuẩn kế toán.

## Trade-offs

- Không có `payment_attempts` ⇒ nếu sau này cần provider fallback thì phải migration thêm. Chấp nhận:
  chi phí migration sau nhỏ hơn chi phí duy trì bảng chưa dùng.
- `refunds` là bảng thứ hai bên cạnh `pending_refunds`. Giai đoạn chuyển tiếp có hai bảng cùng tồn
  tại (một release), tăng nhầm lẫn. Giảm thiểu: `pending_refunds` chuyển read-only, mọi write đi qua
  `refunds`.
- Gọi ledger là "wallet event log" ghi rõ trong tài liệu để không ai áp kỳ vọng double-entry
  (ví dụ đòi mọi entry phải có counterparty).

## Consequences

- `refund-core.ts` tính remaining từ `refunds` (status `succeeded` + `submitted`/`requested`) thay
  vì từ ledger + `pending_refunds`.
- `payment_transactions.status` cần state `partially_refunded`; transition tập trung một chỗ
  (`auth-core/src/domain/payment-status.ts`) thay vì UPDATE string tự do rải rác.
- Reconciliation so `refunds` với provider refund list, không gọi lại command tạo refund.
- Test phải chứng minh `balance_projections` rebuild được từ `ledger_entries`.

## Sources

Rút ra từ chính codebase (không phải nguồn ngoài):

- `packages/auth-core/src/db/schema/ledger-entries.ts`, `balance-projections.ts`,
  `payment-transactions.ts`
- `packages/auth-core/src/db/repos/ledger.repo.ts` (`appendLedgerEntryIdempotent`,
  `sumRefundsByOriginalTransaction`), `balance.repo.ts` (`applyDelta`)
- `packages/server/src/services/refund-core.ts`
- `migrations/001_init.up.sql`, `migrations/009_ledger_v2_columns.up.sql`
