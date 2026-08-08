# ADR-0004 — Stripe refund mapping: dùng Refund object, không dùng `charge.amount_refunded`

- Trạng thái: Đề xuất
- Ngày: 2026-07-28
- Liên quan: [ADR-0001](0001-payment-aggregate-and-ledger-semantics.md), [ADR-0003](0003-durable-webhook-inbox-replaces-insert-first-dedup.md)

## Context

Adapter Stripe hiện chỉ xử lý `charge.refunded` (`packages/stripe-adapter/src/adapter.ts`):

```ts
case "charge.refunded": {
  const charge = event.data.object as Stripe.Charge;
  refundAmountMicros = stripeUsdAmountToMicros(charge.amount_refunded, ...)
  const checkoutSessionId =
    typeof charge.metadata?.checkoutSessionId === "string"
      ? charge.metadata.checkoutSessionId
      : charge.id;
  return {
    eventId: `refund:${event.id}`,
    type: "payment.refunded",
    providerRef: checkoutSessionId,
    refundAmountMicros,
    ...
  };
}
```

Ba lỗi độc lập, mỗi lỗi tự nó đủ làm sai sổ sách:

**1. `charge.amount_refunded` là tổng tích luỹ, bị dùng như delta.** Stripe docs mô tả field này là
"amount refunded" trên Charge và nó tăng dần theo từng refund. `charge.refunded` bắn lại mỗi lần có
partial refund mới, với `amount_refunded` lớn hơn lần trước. Ba refund $10 trên charge $30 sinh ra ba
event với `amount_refunded` = 1000, 2000, 3000. Router lấy trực tiếp làm `refundAmountMicros`
(`webhook-router.ts:266`) ⇒ ghi debit 10 + 20 + 30 = $60 cho một charge $30.

Stripe docs nói thẳng trong mô tả `charge.refunded`: *"Occurs whenever a charge is refunded, including
partial refunds. Listen to `refund.created` for information about the refund."*

**2. `providerRef` fallback về `charge.id`, không bao giờ match được.** `charge.metadata.checkoutSessionId`
không tồn tại: adapter tạo Checkout Session với `metadata` ở *cấp session*, không dùng
`payment_intent_data.metadata`. Stripe copy metadata từ PaymentIntent xuống Charge, nhưng **không** từ
Session xuống PaymentIntent — hai map metadata là độc lập. Nên `charge.metadata` rỗng, fallback dùng
`charge.id`, mà `payment_transactions.provider_ref` lưu *session id* (`cs_...`). Lookup
`(provider, provider_ref)` không khớp ⇒ theo mô hình hiện tại là im lặng bỏ event (xem ADR-0003).

Hệ quả kép: refund từ Stripe Dashboard hiện **hoàn toàn không được ghi nhận**.

**3. `source_id` của ledger dùng `providerRef` (payment/session id), không phải refund id.** Router ghi
`sourceId: evt.providerRef` cho entry refund (`webhook-router.ts:276`). UNIQUE
`(provider, source_id, entry_type)` vì thế coi *mọi* refund của cùng payment là một. Partial refund thứ
hai bị `onConflictDoNothing` chặn ⇒ tiền không bao giờ được trả về ledger. Cùng lỗi này ở
`refund-core.ts:322` (`tx:{transactionId}:{idempotencyKey}` — khá hơn vì có idempotencyKey, nhưng vẫn
không phải danh tính provider-side, nên refund tạo ngoài Paykit không dedup được với refund tạo qua API).

Ngoài ra `refund-core.ts` set `status = "refunded"` khi `-totalRefunded >= originalMicros`
(`refund-core.ts:354`) — chỗ này *đúng* — nhưng router webhook set `"refunded"` vô điều kiện
(`webhook-router.ts:303`), nên một partial refund $1 trên $100 đánh dấu cả payment là đã hoàn tiền, rồi
`refund-core.ts:109` chặn mọi refund tiếp theo với `exceeds_remaining`.

## Decision

**1. Nghe họ Refund event, không dùng `charge.refunded` làm nguồn delta.**

Xử lý `refund.created`, `refund.updated`, `refund.failed` (`data.object` là Refund). Từ Refund object:

- `refund.id` → `providerRefundId` — danh tính bền vững, dùng làm idempotency source.
- `refund.amount` → delta của *riêng* refund này.
- `refund.status` → `pending` | `succeeded` | `failed` | `canceled` (chú ý `status` nullable).
- `refund.payment_intent` / `refund.charge` → khoá đối chiếu payment.

`charge.refunded` chỉ dùng cho reconciliation (đọc `amount_refunded` như snapshot để phát hiện lệch),
không sinh ledger entry.

**2. Truyền internal transaction id xuống Charge qua `payment_intent_data.metadata`.**

Khi tạo Checkout Session, set metadata ở **cả hai** chỗ:

```ts
metadata: { paykitTransactionId, tenantId, ownerId },              // đọc ở checkout.session.completed
payment_intent_data: {
  metadata: { paykitTransactionId, tenantId, ownerId },            // theo tiền xuống PaymentIntent → Charge
},
```

Stripe docs: `payment_intent_data` là "a subset of parameters to be passed to PaymentIntent creation"
(chỉ ở `payment` mode), và PaymentIntent copy metadata sang Charge tại thời điểm tạo Charge (snapshot
một lần, update PaymentIntent sau đó không lan truyền). Nhờ đó refund webhook resolve được internal
transaction id qua Charge, kể cả refund tạo từ Dashboard.

**3. Mang `providerRefundId` trên `NormalizedWebhookEvent` (đã sửa so với bản đầu).**

Bản đầu của ADR này chọn một contract riêng `NormalizedRefundEvent` và nói rõ "không nhồi thêm field
optional vào `NormalizedWebhookEvent`". Quyết định đó bị đảo khi bắt đầu implement, vì hai lý do
kiểm chứng được trên code:

- Contract riêng cần **adapter method mới** để adapter phát ra kiểu event mới. Ràng buộc tương thích
  (plan §5) là `PaymentProviderAdapter` chỉ được thêm method **optional**, và
  `core/__tests__/adapter-interface.test.ts` chốt shape đó. Method optional nghĩa là adapter chưa port
  vẫn đi đường cũ.
- Năm adapter đang phát `payment.refunded` qua `NormalizedWebhookEvent`: stripe, nowpayments, bitpay,
  cryptomus, binance. Đường cũ chính là đường có lỗi mất tiền. Làm contract mới song song ⇒ lỗi vẫn
  còn nguyên ở mọi adapter chưa port, tức là sửa 1/5 và để 4/5 nguyên vẹn.

Nên `providerRefundId` là field optional trên `NormalizedWebhookEvent`. Một field, mọi adapter dùng
ngay được, và adapter chưa cung cấp nó thì server xử lý bảo toàn (coi như nhiều nhất một refund cho
mỗi payment) thay vì cộng dồn sai.

Các field còn lại của contract dự kiến không cần thiết: `refundAmountMicros` + `currencyCode` +
`providerRef` đã có; `internalTransactionId` nằm trong `metadata`; `status` không cần vì adapter chỉ
phát `payment.refunded` khi refund đã thật sự chuyển tiền — trạng thái trung gian là việc của bảng
`refunds`, không phải của event.

**4. Ledger `source_id` cho refund = `refund:{providerRefundId}`.** Hai partial refund khác nhau có
`refund.id` khác nhau ⇒ hai entry. Refund cùng id đến hai lần (retry, hoặc trùng giữa đường API và
đường webhook) ⇒ một entry.

**5. Chỉ `status = succeeded` mới ghi ledger.** `pending`/`requires_action` giữ reservation.
`failed`/`canceled` giải phóng reservation, không giảm balance. Refund không final ở thời điểm tạo:
`pending` có thể chuyển thành `failed` sau đó.

**6. Payment status suy ra từ tổng refund thành công**, tập trung một chỗ (xem ADR-0001):
`partially_refunded` khi `0 < Σ succeeded < captured`, `refunded` khi `Σ >= captured`.

## Alternatives considered

**A. Giữ `charge.refunded`, tự tính delta = `amount_refunded` − tổng đã ghi.** Bỏ. Cần đọc trạng thái đã
ghi để suy ra delta ⇒ event out-of-order hoặc event bị mất làm lệch vĩnh viễn, không tự chữa. Cũng không
biết refund nào trong charge tương ứng entry nào.

**B. Refetch Charge/Refund từ API mỗi lần nhận event.** Chính xác nhất, giá là một round-trip mỗi
webhook và phụ thuộc Stripe API khả dụng lúc xử lý. Không chọn làm đường chính, nhưng để dành cho
reconciliation — nơi độ trễ không quan trọng.

**C. Chỉ dùng `refund.updated` (bỏ `created`).** Ít event hơn nhưng mất thông tin thời điểm khởi tạo, và
`charge.refund.updated` chỉ phủ một số payment method — `refund.updated` mới phủ hết. Nghe cả ba rõ
ràng hơn.

## Trade-offs

- Phải đăng ký event type mới ở Stripe Dashboard/API. Tenant đang chạy chỉ subscribe `charge.refunded`
  sẽ không nhận refund event mới ⇒ cần ghi vào release notes và giữ `charge.refunded` được xử lý
  (mapping sang reconciliation, không sinh ledger) trong ít nhất một minor version.
- Payment cũ tạo trước thay đổi này không có metadata trên Charge. Refund của chúng vẫn phải resolve
  được qua `payment_intent` → session lookup; cần đường fallback, không được vỡ.
- `providerRefundId` là field optional ⇒ type system không buộc adapter nào phải điền. Adapter chưa
  điền vẫn biên dịch được và vẫn chạy như trước; refund của nó bị coi là tối đa một refund mỗi payment.
  Đây là cái giá của việc không phá adapter contract: bù lại bằng contract test đánh dấu capability,
  chứ không bằng compiler.

## Consequences

- `packages/core`: thêm `providerRefundId?` vào `NormalizedWebhookEvent`. Adapter contract không đổi.
- `packages/stripe-adapter`: thêm `payment_intent_data.metadata` khi tạo session; map họ Refund event;
  `charge.refunded` chuyển sang đường reconciliation.
- `packages/server`: webhook router xử lý refund event qua đường mới; `refund-core.ts` đổi `source_id`
  sang `refund:{providerRefundId}`; bỏ set `"refunded"` vô điều kiện.
- Migration: bảng `refunds` (xem ADR-0001) + backfill từ `pending_refunds` và ledger entry hiện có.
- Test bắt buộc: hai partial refund liên tiếp không double-count; refund từ Dashboard resolve được;
  `pending → failed` không giảm balance; cùng `refund.id` gửi hai lần chỉ một entry.

## Sources

- Code đã đọc: `packages/stripe-adapter/src/adapter.ts`,
  `packages/server/src/routes/webhooks/webhook-router.ts:264-309`,
  `packages/server/src/services/refund-core.ts:98,109,322,354`.
- Stripe — `charge.refunded`: *"Occurs whenever a charge is refunded, including partial refunds. Listen
  to `refund.created` for information about the refund."* Họ event Refund (`refund.created`,
  `refund.updated`, `refund.failed`, `charge.refund.updated` chỉ phủ một số payment method):
  https://docs.stripe.com/api/events/types
- Stripe Refund object — `amount` là của riêng refund đó; `status` ∈ pending/requires_action/succeeded/
  failed/canceled và nullable: https://docs.stripe.com/api/refunds/object
- Stripe Charge object — `amount_refunded` là tổng đã hoàn, so với `amount_captured` để biết đã hoàn hết;
  `refunds` không chắc có trong response: https://docs.stripe.com/api/charges/object
- Stripe PaymentIntent → Charge metadata copy tại thời điểm tạo charge (snapshot một lần):
  https://docs.stripe.com/payments/payment-intents
- Stripe Checkout Session `payment_intent_data.metadata` (chỉ `payment` mode):
  https://docs.stripe.com/api/checkout/sessions/create
- Stripe refund lifecycle (refund có thể fail sau khi tạo): https://docs.stripe.com/refunds
