# Payment orchestration hardening — kết quả

Nhánh tích hợp: `hardening/payment-orchestration` (51 commit trên `main`, 131 file,
+13.617/−776). Chưa merge vào `main`.

Trạng thái gate trên đúng nhánh tích hợp, chạy thật:

| Lệnh | Kết quả |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | exit 0 — **1412 pass / 23 skip / 148 file** (không có Postgres) |
| `pnpm test` + `PAYKIT_E2E_DATABASE_URL` | exit 0 — **1397 pass / 0 skip** (đo trước khi thêm 027) |
| `pnpm lint` | exit 1 — **214 error** |

`pnpm lint` fail là trạng thái có từ trước, không phải do workstream này: baseline
lúc bắt đầu là 230–238 error trên cùng script (`biome check packages`). 219 là thấp
hơn baseline. Mọi file mới/đã sửa trong workstream đều lint sạch — kiểm riêng 26 file
F5: `Checked 26 files. No fixes applied.` Không suppress rule nào, không nới `any`,
không giảm coverage.

Test lúc bắt đầu session: 1078 pass. Hiện tại 1374, +23 file test mới.

---

## 12 mục tiêu — trạng thái

| # | Mục tiêu | Trạng thái | Nằm ở đâu |
|---|---|---|---|
| 1 | Idempotency checkout end-to-end | Xong | `claimCheckout`/`finalizeCheckout`, migration 025 |
| 2 | Webhook inbox bền, chịu được webhook đến trước khi link checkout | Xong | migration 026, `webhook-delivery-processor.ts` |
| 3 | Semantics refund một phần / nhiều lần | Xong | bảng `refunds`, `refundedPaymentStatus` |
| 4 | Map refund Stripe đúng | Xong | `stripe-adapter/src/webhook-events.ts` |
| 5 | Advisory lock an toàn dưới pool | Xong | `advisory-lock.ts` pin vào 1 connection |
| 6 | Pagination/timeout/retry/status cho reconcile | Xong | migration 023 (status) + 027 (keyset cursor + batch ceiling) |
| 7 | Invariant tiền tệ / số tiền / trạng thái | Xong | migration 019+020, `usd-native.ts`, `amount-guards.ts` |
| 8 | Không gọi compliance khi đang giữ tx/row lock | Xong | `screening_jobs` + park, migration 021 |
| 9 | Fencing token cho idempotency claim | Xong | migration 024, `claim_token` + `claim_generation` |
| 10 | Test đủ các failure window | Phần lớn | 23 file test mới; xem "Còn thiếu" |
| 11 | Giữ pattern/convention repo | Xong | guarded UPDATE, repo-per-domain, kebab-case, manifest migration |
| 12 | Không hack / monkey patch / nợ kỹ thuật | Xong | không có suppress, không có test bị tắt |

Cả 12 mục đã xong. Giới hạn còn lại nằm ở phần "Còn thiếu".

---

## Lỗi mất tiền đã sửa

Bốn lỗi dưới đây đều verify được từ source, không phải suy đoán.

### 1. Webhook đến trước `provider_ref` ⇒ mất tiền vĩnh viễn

`webhook_events` có PK `(provider, event_id)` và router INSERT nó làm câu lệnh **đầu
tiên** của transaction business. Một row mang hai nghĩa cùng lúc: "đã thấy" và "đã
xử lý". Mọi `return` sớm vì lý do business — quan trọng nhất là *không tìm thấy
payment nào có provider_ref này* — vẫn commit row dedup, trả 200, provider ngừng
retry, và redelivery sau đó bị PK từ chối.

Khách đã trả tiền, ledger trống, payment đứng mãi. Không log, không metric, không
đường replay.

```mermaid
flowchart TD
    A[Webhook đến] --> B[INSERT webhook_events<br/>trong tx business]
    B --> C{Có payment khớp<br/>provider_ref?}
    C -->|Không| D[return sớm]
    D --> E[COMMIT — row dedup đã ghi]
    E --> F[200 OK]
    F --> G[Provider ngừng retry]
    G --> H[Redelivery bị PK chặn]
    H --> I[Tiền mất vĩnh viễn]
    C -->|Có| J[Credit ledger]

    style I fill:#7f1d1d,color:#fff
    style E fill:#7f1d1d,color:#fff
```

Sửa: tách nhận và xử lý thành hai transaction. Nhận commit riêng; state của row nói
xử lý tới đâu.

```mermaid
stateDiagram-v2
    [*] --> received: recordDelivery<br/>(commit riêng)
    received --> processing: claim (guarded UPDATE + lease)
    processing --> processed: work + mark trong CÙNG tx
    processing --> unmatched: chưa có payment khớp
    processing --> failed: xử lý throw
    unmatched --> processing: retry theo backoff
    failed --> processing: retry theo backoff
    unmatched --> dead_letter: hết attempt
    failed --> dead_letter: hết attempt
    processing --> processing: lease hết hạn<br/>(worker chết) → reclaim
    dead_letter --> unmatched: requeue (operator)
    processed --> [*]

    note right of processed
        CHECK buộc phải có
        matched_transaction_id
    end note
```

Điểm then chốt: `markDeliveryProcessed` nằm **trong** transaction làm việc, nên
"đánh dấu xong" và "thật sự xong" không thể lệch nhau. Rollback mang cả hai đi.

### 2. Refund một phần đặt payment thành `refunded`

Đường webhook và đường admin tính tổng đã refund từ hai nguồn khác nhau, và một
refund một phần đủ để đặt status `refunded` — payment đọc như đã hoàn toàn bộ dù
mới hoàn một phần. Ledger dùng `providerRef` làm `source_id`, nên refund thứ hai
trên cùng payment bị UNIQUE constraint gộp vào refund thứ nhất: **tiền hoàn lần 2
không bao giờ vào ledger.**

Sửa: bảng `refunds` với identity riêng (`provider_refund_id`), `source_id` của ledger
đổi sang `refund:<id>`, và một hàm duy nhất `refundedPaymentStatus(captured, refunded)`
quyết định status cho cả hai đường.

```mermaid
flowchart LR
    A[refund event] --> B{có providerRefundId?}
    B -->|có| C["source_id = refund:{id}"]
    B -->|không| D["source_id = refund:ref:{providerRef}"]
    C --> E[ledger entry riêng<br/>mỗi refund]
    D --> E
    E --> F[SUM succeeded<br/>từ ledger]
    F --> G{refunded vs captured}
    G -->|= 0| H[completed]
    G -->|< captured| I[partially_refunded]
    G -->|>= captured| J[refunded]
```

### 3. Advisory lock session-level qua connection pool

`pg_advisory_lock` là session-level, nhưng hai query độc lập qua `pg.Pool` có thể
rơi vào hai connection khác nhau — lock lấy ở connection A, unlock gọi trên
connection B. Lock không bao giờ được thả, hoặc hai reconcile chạy song song.

Sửa: `acquireReconcileLock` lấy connection từ `db.$client` và pin cả lock lẫn unlock
vào đúng connection đó; unlock thất bại thì `client.release(true)` để destroy
connection thay vì trả về pool với lock còn treo.

### 4. Checkout crash giữa lúc gọi provider ⇒ session mồ côi

Thứ tự cũ: commit payment row → gọi provider → ghi `provider_ref` về. Chết ở giữa
để lại một checkout session sống ở provider mà DB này không gọi tên được. Webhook
của nó khớp zero row → chính là lỗi #1.

Sửa: claim trước, gọi provider sau.

```mermaid
sequenceDiagram
    participant C as Client
    participant R as Checkout route
    participant DB as Postgres
    participant P as Provider

    C->>R: POST /checkout (Idempotency-Key)
    R->>DB: BEGIN
    R->>DB: consume discount
    R->>DB: claimCheckout → provider_creating
    Note over DB: row là bằng chứng bền<br/>rằng session CÓ THỂ tồn tại
    R->>DB: COMMIT
    R->>P: createCheckout()
    Note over R,P: ngoài mọi transaction —<br/>không giữ pooled connection
    P-->>R: session + URLs
    R->>DB: finalizeCheckout → awaiting_payment<br/>+ checkout_result_json
    R-->>C: 200 + webUrl

    Note over R,DB: Crash sau claim: row nằm ở<br/>provider_creating cho reconcile,<br/>không phải session mồ côi
```

Claim là insert-first `ON CONFLICT DO NOTHING`: hai request đồng thời cùng key cho ra
**một** checkout — bên thua đọc row của bên thắng, thay vì ăn unique-violation 500
làm key đó không dùng lại được bao giờ.

Mất claim thì throw để rollback cả transaction — nếu return bình thường, discount đã
consume sẽ commit và promo của khách bị tiêu cho một checkout không hề được tạo.

---

## Reconciliation

```mermaid
flowchart TD
    A[Cron tick] --> B{acquireReconcileLock<br/>pin 1 connection}
    B -->|lock đang giữ| C["status=skipped<br/>summary=null"]
    B -->|lấy được| D[INSERT run: running]
    D --> E[Từng adapter]
    E --> F[fetch + diff]
    F --> G{Kết quả}
    G -->|mọi adapter fail| H[status=failed]
    G -->|một số fail| I[status=partial]
    G -->|tất cả OK| J[status=completed]
    H --> K[completeRun — đóng row]
    I --> K
    J --> K
    C --> L[Không tạo run row]

    style C fill:#1e3a5f,color:#fff
```

Trước đây `skipped` bị gộp thành `completed`, nên một lock giữ suốt đọc như
"reconcile thành công, không có discrepancy". Bốn status giờ phân biệt được, và `run`
được hoist ra ngoài `try` với catch đóng row — trước đó một throw để lại row đứng
`running` mãi.

---

## Package dependency sau refactor

```mermaid
flowchart BT
    core["@vibecc/paykit (core)<br/>zero workspace deps"]
    authcore["paykit-auth-core<br/>DB, repos, schema"]
    server["paykit-server<br/>HTTP + services"]
    workers["paykit-workers<br/>reconcile"]
    adapters["adapters ×9"]
    cli["paykit-cli"]
    service["paykit-service"]

    authcore --> core
    server --> core
    server --> authcore
    workers --> core
    adapters --> core
    cli --> core
    cli --> authcore
    service --> server

    style core fill:#1e3a5f,color:#fff
```

Ranh giới này ràng buộc một quyết định thật: `drainWebhookInbox` **không** đặt ở
`packages/workers` như thiết kế ban đầu. `workers` chỉ depend core, không có
auth-core, nên không đọc được repo inbox — thêm dependency đó sẽ phá test
`no-cross-imports.test.ts`. Drain vì thế nằm cạnh `drainScreeningJobs` trong
`packages/server/src/services`, cùng dạng "gọi từ cron", export qua barrel.

---

## Migration đã thêm

| # | Slug | Nội dung |
|---|---|---|
| 019 | `money_integer_micros` | `NUMERIC(20,6)` → `NUMERIC(30,0)` + pre-check fail-loud |
| 020 | `money_and_currency_invariants` | CHECK amount > 0 / <> 0 + ISO-4217 shape |
| 021 | `screening_jobs` | status `screening_pending` + queue table |
| 022 | `refunds` | bảng `refunds` + `partially_refunded` + backfill 2 nguồn |
| 023 | `reconciliation_run_status` | thêm `partial`, `skipped` |
| 024 | `idempotency_claim_token` | `claim_token` + `claim_generation` (fencing) |
| 025 | `checkout_lifecycle` | `provider_creating`, `awaiting_payment`, `checkout_result_json` |
| 026 | `webhook_inbox` | bảng inbox + 4 partial index + backfill |
| 027 | `reconciliation_cursor` | keyset cursor + index `(provider, created_at, transaction_id)` |

### Reconcile phân trang được (027)

Snapshot cũ là một `SELECT` không `LIMIT` cho cả window. Window đủ lớn thì process
chết, và run chết giữa đường không nhớ đã đi tới đâu — lần sau chạy lại từ đầu và
chết đúng chỗ đó. Window quá lớn để xong trong một lần thì **không bao giờ** xong được.

Hai chi tiết phải đúng, cả hai đều đã đo trên Postgres 16 thật:

**Keyset hai cột, không phải `created_at >`.** Timestamp không unique. Seed 5 payment
với 3 cái cùng timestamp: keyset trả đủ 5/5 đúng một lần, còn predicate một cột chỉ
thấy 1 — **bỏ mất 2 payment**. Bỏ sót payment là điều duy nhất reconciler không được
phép làm, vì nó chính là thứ reconciler tồn tại để phát hiện.

**Index phải dẫn bằng `provider`.** Bản đầu tôi viết index `(created_at,
transaction_id)`; `EXPLAIN` cho thấy planner đi index khác rồi **Sort** — tức sort lại
mỗi trang, tệ hơn cả cái select không giới hạn mà nó thay thế. Sửa thành
`(provider, created_at, transaction_id)` thì thành **Index Only Scan**, không còn sort.

Chi tiết dễ sai nhất lại không phải phân trang mà là differ: nó đối chiếu hai chiều
và báo `paykit_missing` cho provider record không có row paykit. Nếu diff một trang
paykit với **toàn bộ** danh sách provider thì mọi record ngoài trang đó bị báo thiếu —
hàng nghìn discrepancy bịa ra mỗi batch, tệ hơn không reconcile vì nó chôn vùi
discrepancy thật. Nên mỗi batch chỉ diff với những record mà trang đó có thể khớp, và
phần không trang nào nhận được diff một lần ở cuối, khi "không có trong paykit" đúng
nghĩa là vậy.

Provider dừng ở batch ceiling làm run thành `partial`, không phải `completed`: không
có gì fail, nhưng một phần window chưa được xem.

### Rollback đã verify trên Postgres thật

Không chỉ apply xuôi. Seed dữ liệu vào **mọi** state mà down migration phải fold
(`provider_creating`, `awaiting_payment`, inbox row `unmatched`, cursor có position),
rồi chạy down 027 → 026 → 025 → 024 → 023 → 022. Cả 6 exit 0, và sau đó:

- Payment fold hết về `pending`, không còn status nào ngoài vocabulary cũ.
- `webhook_inbox`, `reconciliation_cursors`, `refunds` bị drop; `webhook_events` **còn
  nguyên** — đúng như thiết kế, vì đó là đường lùi của 026.
- CHECK khôi phục thật sự chặn: INSERT `provider_creating` sau rollback bị reject.
- Index `paykit_pt_reconcile_keyset_idx` bị dọn cùng bảng, không để lại index không
  ai đọc.

Điểm dễ sai nhất ở down migration là thứ tự: fold dữ liệu **trước** khi restore CHECK
hẹp hơn. Làm ngược lại thì CHECK fail ngay trên row đang giữ status mới. Thứ tự này
được assert trong shape test và giờ đã chạy thật với dữ liệu ở đúng các state đó.

Mọi migration có `.up.sql`, `.down.sql`, entry trong `manifest.json`, mirror
byte-identical sang `packages/cli/migrations` (assert bằng test), và một shape test
riêng. Tên file và comment SQL không tham chiếu số phase hay mã finding.

---

## Bảo mật

Ràng buộc user đặt ra, và chỗ thực thi:

- **Không log/lưu secret.** `raw_payload` đi qua `redactRawBody` trước khi ghi: Stripe
  `sk_live_`/`sk_test_`, `whsec_`, Bearer token, số dạng thẻ, email. Có 12 test riêng
  (`webhook-payload-redaction.test.ts`).
- **Hash lấy trên bytes gốc, lưu cột riêng.** Nếu hash tính từ bản đã redact thì hai
  secret khác nhau sẽ redact ra cùng text và hash giống nhau — body bị đổi sẽ lọt.
  Test assert đúng tính chất này.
- **Không lưu secret trong idempotency response cache.** Không thay đổi; cache vẫn
  chỉ giữ response body của chính API.
- **Body quá lớn bị cắt** (64 KiB) nhưng hash vẫn phủ toàn bộ.
- **Payload có retention.** `sweepInboxPayloads` xoá `raw_payload` của row đã settle
  quá 30 ngày, giữ lại row. Chỉ quét row terminal — xoá payload của delivery còn nợ
  retry sẽ phá chính khả năng retry.
- **Listing không kéo payload.** `listDeliveriesByState` select cột tường minh, không
  có `raw_payload`/`normalized_payload`, để endpoint operator không thành bulk export.
- **Không có gì chưa xác thực vào được inbox.** Verify signature/parse xảy ra *trước*
  `recordDelivery`. Ngược lại thì bất kỳ ai cũng cắm được row vào một bảng bền.
- **Provider error không leak ra client.** Checkout thất bại trả 502 với message
  cố định; test assert message của provider không xuất hiện trong response.

Không có secret, dotenv, hay credential nào được commit.

---

## Còn thiếu — nói thẳng

**Đã verify trên Postgres 17 thật.** Cả 26 migration apply sạch theo đúng thứ tự
manifest lên database trống. `webhook-inbox-pg.e2e.test.ts` (14 test) chạy repo inbox
thật qua `pg.Pool` và assert những thứ mock không chứng minh được:

- Hai `claimNextDelivery` đồng thời cho ra **đúng một** winner — đo bằng
  `Promise.all`, không phải suy ra từ pattern.
- Lease hết hạn thì row được reclaim, `processing_attempts` lên 2 — worker chết
  không làm delivery đứng mãi.
- Cả 4 CHECK constraint thật sự reject: `processed` không có
  `matched_transaction_id`, `unmatched` mang `processed_at`, `dead_letter` thiếu
  `processed_at`, state sai chính tả.
- Vòng `unmatched → failed → dead_letter → requeue` đi hết không vi phạm CHECK nào
  (requeue phải clear `processed_at`, nếu không constraint chặn).
- `sweepInboxPayloads` xoá payload của row đã settle và **không** chạm row còn nợ retry.
- `listDeliveriesByState` không trả về `rawPayload`/`normalizedPayload`.

Với `PAYKIT_E2E_DATABASE_URL` trỏ vào DB trống: **1397 pass, 0 skip, 145 file** —
cả ba pg e2e (inbox, cold-start, discount savepoint) cùng chạy.

**`webhook_events` vẫn còn.** Router payment không dùng nữa, nhưng
`/admin/webhook-events` và pipeline subscription vẫn đọc. Giữ lại có chủ đích: down
migration của 026 cần chỗ đó còn dữ liệu để quay về. Nghĩa là pipeline subscription
**chưa** được hưởng inbox — nó vẫn có đúng lỗi #1. Chưa nằm trong scope 12 mục tiêu,
nhưng là nợ đã biết.

---

## Chạy được ngay sau deploy

Không cần cấu hình gì thêm. `paykit-service` tự chạy cả hai drain in-process
(`startBackgroundDrains`, mặc định 15 giây/tick): inbox drain, screening drain, và
sweep payload theo retention.

Ban đầu tôi để đây là "yêu cầu deploy" trong báo cáo. Đó là sai hướng: một deploy
mặc định sẽ để delivery `unmatched` treo mãi và payment `screening_pending` không bao
giờ được xử lý — đúng lỗi mất tiền mà inbox tồn tại để xoá, chỉ khác là giờ nhìn thấy
trong bảng. Một yêu cầu vận hành không ai đọc thì không phải bảo vệ.

In-process vì claim là guarded UPDATE: nhiều replica tick đồng thời chia việc chứ
không nhân đôi, nên không cần coordination. Ai muốn dùng scheduler ngoài thì đặt
`intervalMs: 0` và gọi drain đã export.

Ba tính chất của loop đều có test: tick throw thì log và loop vẫn sống (một lỗi DB
tạm không được phép kết thúc mọi xử lý nền), tick chậm không stack lên chính nó, và
`stop()` thật sự dừng trước khi pool đóng.

Metric mới nên gắn alert: `paykit_webhook_dead_letter_total` (tiền có thể đã chuyển ở
provider mà không khớp được gì ở đây — cần người xem),
`paykit_webhook_payload_mismatch_total` (một event_id với hai body khác nhau).
