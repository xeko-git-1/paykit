# ADR-0003 — Durable webhook inbox thay cho INSERT-first dedup

- Trạng thái: Đã triển khai (migration `026_webhook_inbox`)
- Ngày: 2026-07-28
- Liên quan: [ADR-0001](0001-payment-aggregate-and-ledger-semantics.md), [ADR-0004](0004-stripe-refund-event-mapping.md)

## Context

Mô hình hiện tại: `paykit.webhook_events` chỉ có `(provider, event_id, recorded_at)` với PK
`(provider, event_id)`. `tryRecordWebhookEvent` INSERT trước mọi thứ khác trong transaction; conflict
⇒ `recorded: false` ⇒ handler bỏ qua (`webhook-router.ts:128`).

Hai lỗ hổng, đều verify được từ source:

**1. Event đến trước khi `provider_ref` được ghi thì mất vĩnh viễn.**
Checkout ghi `provider_ref` *sau* khi `adapter.createCheckout()` trả về (`checkout-router.ts:188-207`,
`v1/router.ts:173-177`). Webhook router lookup theo `(provider, provider_ref)`
(`webhook-router.ts:132-142`). Nếu provider gửi webhook trước khi UPDATE đó commit — hoàn toàn khả thi
với ví crypto và cả Stripe khi request checkout chậm — thì:

- `tryRecordWebhookEvent` INSERT thành công ⇒ event bị đánh dấu đã xử lý.
- `if (!row) return;` ⇒ không tìm thấy transaction, thoát im lặng.
- Router trả `200 {received: true}` ⇒ provider ngừng retry.
- Lần retry sau (nếu có) gặp PK conflict ⇒ bỏ qua.

Kết quả: payment đã trả tiền, ledger không có gì, transaction đứng `pending` mãi. Không có metric, không
có log, không có đường replay.

**2. Xử lý lỗi giữa chừng cũng mất event.** Bất kỳ throw sau `tryRecordWebhookEvent` làm rollback
transaction, nên row dedup cũng rollback — điểm này *đúng*. Nhưng khi handler `return` sớm vì lý do
business (row không tồn tại, `status !== "pending"`, thiếu `amountMicros`), transaction commit với
row dedup đã ghi ⇒ event coi như xong dù chưa làm gì.

Ngoài ra `webhook_events` không có `tenant_id`, không lưu payload, không có `event_type`, nên không thể
audit, không thể replay, và admin route `/admin/webhook-events` chỉ thấy được provider + event id + thời
gian.

## Decision

Thay `webhook_events` bằng inbox có lifecycle. Bảng `paykit.webhook_inbox`:

| Cột | Ghi chú |
|---|---|
| `inbox_id` | PK |
| `provider`, `event_id` | UNIQUE `(provider, event_id)` — dedup theo nhận, không theo xử lý |
| `tenant_id` | nullable; điền khi match được transaction |
| `event_type` | loại đã normalize |
| `payload_hash` | sha256 raw body — phát hiện cùng event id khác nội dung |
| `raw_payload` | để replay; đi qua redaction hiện có trước khi ghi |
| `normalized_payload` | `NormalizedWebhookEvent` đã parse |
| `state` | `received` \| `unmatched` \| `processing` \| `processed` \| `failed` \| `dead_letter` |
| `matched_transaction_id` | nullable FK |
| `processing_attempts` | int |
| `last_error_code`, `last_error_message` | structured |
| `next_retry_at` | backoff có jitter |
| `received_at`, `processed_at` | |

Quy tắc:

1. **Ghi nhận và xử lý là hai bước tách biệt.** INSERT inbox row (state `received`) commit trước.
   Business processing là transaction thứ hai. Chỉ khi transaction đó commit thành công thì mới
   `processed`.
2. **Không tìm thấy transaction ⇒ `unmatched`, không phải `processed`.** Worker retry theo
   `next_retry_at`, giới hạn attempt, hết thì `dead_letter` + metric.
3. **Dedup theo `(provider, event_id)` không chặn retry xử lý.** Duplicate delivery của event đang
   `processing` hoặc `unmatched` không tạo row mới nhưng cũng không bị coi là đã xong.
4. **Thứ tự matching:** internal transaction id từ provider metadata → `provider_ref` → fallback riêng
   từng provider (được kiểm soát) → `unmatched`.
5. **Claim của worker phải fencing.** UPDATE có điều kiện `state = 'unmatched' AND next_retry_at <= now()`
   với `RETURNING`, hoặc `SELECT ... FOR UPDATE SKIP LOCKED` — hai worker không cùng claim một row;
   worker chết giữa đường thì `processing` hết lease được đưa lại về retry.
6. **Cùng `event_id`, khác `payload_hash`** ⇒ log + metric, không ghi đè payload cũ.

Idempotency của ledger vẫn do UNIQUE `(provider, source_id, entry_type)` bảo đảm — inbox không thay thế
lớp đó, nó chỉ bảo đảm event không bị mất và có thể chạy lại an toàn.

## Alternatives considered

**A. Vá tối thiểu: khi không tìm thấy row thì trả 500 để provider retry.** Rẻ nhất. Bỏ vì phụ thuộc
hoàn toàn vào retry policy của provider (Stripe 3 ngày, các provider khác có thể chỉ vài lần hoặc
không có), và khiến mọi lỗi tạm biến thành retry storm không kiểm soát được từ phía ta. Không có audit
trail.

**B. Ghi `provider_ref` trước khi gọi provider.** Không khả thi tổng quát: `provider_ref` là
`providerSessionId` do provider sinh ra, chưa tồn tại trước khi gọi. Có thể truyền internal
`transactionId` sang provider để làm khoá đối chiếu (và nên làm — xem ADR-0004), nhưng không loại bỏ
được nhu cầu inbox: provider vẫn có thể gửi event trước khi ta commit bất cứ gì.

**C. Queue ngoài (BullMQ/SQS).** Đúng hướng ở quy mô lớn, nhưng thêm hạ tầng bắt buộc cho một thư viện
đang chạy được với chỉ Postgres. Transactional inbox trong DB đủ cho invariant cần bảo vệ. Điều kiện
đổi: khi throughput webhook vượt khả năng polling của Postgres.

## Trade-offs

- Hai transaction thay vì một ⇒ tồn tại cửa sổ mà event đã `received` nhưng chưa xử lý. Đây là đánh đổi
  có chủ đích: cửa sổ đó *quan sát được và replay được*, khác với việc mất event.
- `raw_payload` làm bảng phình. Cần retention policy (sweep sau N ngày) — cùng dạng với
  `sweepExpired` của idempotency_records.
- Lưu raw payload có rủi ro dữ liệu nhạy cảm. Bắt buộc đi qua `redactObject` hiện có; test PCI hiện tại
  (`pci-no-raw-body-logging-guard.test.ts`) phải được mở rộng sang đường ghi DB.
- Migration phải giữ được dedup cho các event cũ: backfill `webhook_events` sang inbox với
  `state = 'processed'` để event lịch sử không bị xử lý lại.

## Consequences

- Migration mới: tạo `webhook_inbox`, backfill từ `webhook_events`, giữ bảng cũ cho tới khi
  không còn đọc (đường lùi).
- `webhook-event.repo.ts` được thay bằng repo inbox; `tryRecordWebhookEvent` giữ lại như adapter mỏng
  hoặc bị xoá — quyết định khi implement, phải giữ `/admin/webhook-events` chạy được.
- Worker mới trong `packages/workers` để reprocess `unmatched`/`failed`.
- Metrics mới: `paykit_webhook_unmatched_total`, `paykit_webhook_retry_total`,
  `paykit_webhook_dead_letter_total`, `paykit_webhook_payload_mismatch_total`.
- Webhook router không còn quyết định "processed" bên trong transaction business.

## Khi triển khai — hai chỗ lệch với thiết kế trên

**`webhook_events` và `tryRecordWebhookEvent` được giữ nguyên, không xoá.** Decision §
để mở ("giữ lại như adapter mỏng hoặc bị xoá"). Chọn giữ: `/admin/webhook-events` đọc bảng
đó, `subscription-webhook-handler.ts` có pipeline riêng vẫn dùng nó, và bảng cũ là đường lùi
của migration — down migration của `026` dựa vào chỗ đó còn dữ liệu để quay về. Router
payment không còn gọi tới nó nữa; đó là thay đổi thật sự cần thiết.

**Worker nằm ở `packages/server/src/services`, không phải `packages/workers`.** Consequences §
nói `packages/workers`. Không làm được: `workers` chỉ depend `@vibecc/paykit` (core), không có
`@vibecc/paykit-auth-core`, nên không đọc được repo inbox — và thêm dependency đó sẽ phá
ranh giới package mà `no-cross-imports.test.ts` đang giữ. `drainWebhookInbox` vì thế đặt cạnh
`drainScreeningJobs`, cùng dạng "gọi từ cron", export qua barrel của server.

Ngoài ra, dedup theo `(provider, event_id)` giữ đúng như §3, nhưng backfill từ `webhook_events`
vào `dead_letter` chứ không `processed`: CHECK `webhook_inbox_processed_has_match` buộc row
`processed` phải có `matched_transaction_id`, mà bảng cũ chưa từng ghi cột đó. `dead_letter`
là trạng thái trung thực — delivery đã đóng, và audit trail nói rõ không dựng lại được gì từ nó.
Dedup vẫn nguyên vì dedup là UNIQUE constraint, không phải state.

## Sources

- Code đã đọc: `packages/server/src/routes/webhooks/webhook-router.ts`,
  `packages/auth-core/src/db/repos/webhook-event.repo.ts`,
  `packages/auth-core/src/db/schema/webhook-events.ts`,
  `packages/server/src/routes/checkout/checkout-router.ts:188-207`,
  `packages/service/src/v1/router.ts:173-177`, `migrations/001_init.up.sql`.
- PostgreSQL 16 `SELECT ... FOR UPDATE SKIP LOCKED` (claim không tranh chấp) —
  https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE
- Stripe webhook retry (cơ sở cho việc *không* dựa vào retry của provider làm cơ chế durability duy
  nhất): https://docs.stripe.com/webhooks
