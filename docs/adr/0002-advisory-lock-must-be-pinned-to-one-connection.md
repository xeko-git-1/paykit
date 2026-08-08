# ADR-0002 — Advisory lock cho reconciliation phải pin trên một connection

- Trạng thái: Đề xuất
- Ngày: 2026-07-28
- Liên quan: [ADR-0001](0001-payment-aggregate-and-ledger-semantics.md)

## Context

`packages/workers/src/reconcile/advisory-lock.ts` acquire và release lock bằng hai lời gọi
`db.execute()` riêng biệt trên Drizzle client được khởi tạo từ `pg.Pool`:

```ts
// tryAcquireReconcileLock
await db.execute(sql`SELECT pg_try_advisory_lock(hashtext(${RECONCILE_LOCK_NAME})) AS acquired`);
// ... job chạy, nhiều query khác ...
// releaseReconcileLock
await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${RECONCILE_LOCK_NAME}))`);
```

`pg_try_advisory_lock` là **session-level**. Với pool, mỗi `db.execute()` checkout một client bất kỳ
rồi trả lại. Ba hệ quả, tất cả đều là lỗi thật:

1. **Release có thể sai session.** `pg_advisory_unlock` chạy trên connection B không giải phóng lock
   do connection A giữ. Postgres trả `false` và ghi warning; code hiện tại không đọc kết quả nên bỏ
   qua im lặng. Lock leak đến khi connection A đóng.
2. **Lock bị thừa hưởng.** Connection A quay lại pool vẫn đang giữ lock. Request kế tiếp checkout A
   và mọi `pg_try_advisory_lock` cùng key trên A đều trả `true` — Postgres luôn cho session đang giữ
   lock lấy lại lock đó. Reconciler thứ hai tưởng mình acquire được và chạy song song.
3. **Mutual exclusion không còn.** Kết hợp (1) và (2), invariant "một reconciler tại một thời điểm"
   không được bảo đảm ngay cả trong một process, càng không qua nhiều pod.

Ngoài ra `tryAcquireReconcileLock` trả `false` được orchestrator map thành `status: "failed"`
(`v15-orchestrator.ts:66`), tức lock contention bị báo là lỗi.

## Decision

1. Chuyển sang **`pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`** khi thao tác nằm gọn trong
   một transaction; lock tự release khi commit/rollback, pool không thể làm leak.

2. Với reconciliation run (chạy dài, nhiều transaction, gọi provider HTTP — **không** được giữ một
   transaction xuyên suốt), dùng **client pinned**: `pool.connect()` lấy một `pg.PoolClient`, acquire
   session lock trên chính client đó, chạy job, release trên chính client đó, `finally { client.release() }`.
   Toàn bộ SQL của run đi qua Drizzle instance bound vào client đó.

3. Lock contention không phải lỗi: trả run status `skipped`, tách khỏi `failed`.

## Alternatives considered

**A. Giữ `db.execute()` nhưng bọc trong `db.transaction()`.** Drizzle pin connection trong phạm vi
transaction, nên session lock sẽ acquire/release đúng chỗ. Bỏ vì reconciliation gọi provider HTTP API
(`adapter.fetchTransactions`) — giữ transaction mở suốt các network call là chính điều cần loại bỏ
(xem quy tắc "không network call trong transaction"). Vẫn dùng cách này cho các thao tác ngắn.

**B. Lock table với lease + fencing token.** Bảng `reconcile_locks(name, holder, lease_until, fence)`.
Mạnh hơn: khảo sát được, có TTL, không phụ thuộc connection lifetime, dò được worker chết. Nhưng
thêm bảng, thêm heartbeat, thêm migration, và cần chính xác trong xử lý clock skew. Advisory lock +
pinned client giải quyết được đúng vấn đề với ít bộ phận hơn. Điều kiện đổi sang B: khi cần quan sát
ai đang giữ lock từ ngoài process, hoặc cần lock sống lâu hơn một connection.

**C. Serializable transaction.** Không giải quyết được: bài toán là mutual exclusion của một job dài
có I/O ngoài, không phải anomaly đọc/ghi.

## Trade-offs

- Pinned client giữ một connection khỏi pool suốt run. Với pool nhỏ (default `pg` là 10) và run dài,
  đây là 10% capacity. Chấp nhận vì reconciler chạy theo cron, không phải request path; và cách khác
  là chấp nhận mutual exclusion sai.
- API của worker phải nhận `pool` (hoặc factory) chứ không chỉ `DbClient`. Đây là breaking change ở
  signature của `reconcileV15`/`reconcile` — phải document.
- `hashtext()` không đảm bảo ổn định giữa các major version Postgres. Giữ nguyên trong đợt này (đang
  hoạt động, đổi sẽ làm lock key khác đi giữa lúc deploy) nhưng ghi lại như rủi ro; nếu đổi thì phải
  đổi khi không có run nào đang chạy.

## Consequences

- `advisory-lock.ts` đổi contract: nhận `PoolClient` (hoặc trả handle có `release()`), không nhận
  `DbClient` từ pool.
- `reconcileV15` và `reconcile` phải chạy trong scope của client đã pin.
- `ReconcileV15Result.status` thêm `"skipped"`; `reconciliation_runs.status` CHECK phải nới
  (`running`, `completed`, `partial`, `failed`, `skipped`) — hiện chỉ có 3 giá trị và orchestrator
  đang collapse `partial` thành `failed` khi ghi DB.
- Test phải chạy trên Postgres thật với ≥2 connection để chứng minh: acquire ở process 1 làm process 2
  nhận `skipped`; và release đúng session (kiểm tra qua `pg_locks`).

## Sources

- PostgreSQL 16, §13.3 Explicit Locking / Advisory Locks —
  https://www.postgresql.org/docs/16/explicit-locking.html
  Xác nhận: session-level lock "không tôn trọng transaction semantics", giữ qua rollback, phải
  unlock tường minh hoặc chờ session kết thúc; transaction-level lock release ở cuối transaction và
  không có hàm unlock; một session đã giữ lock luôn thành công khi request lại lock đó.
- PostgreSQL 16, §9.27.10 Advisory Lock Functions —
  https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
- Kết luận về pooling (pooled connection không phải session boundary ⇒ lock leak + lock thừa hưởng)
  là suy ra trực tiếp từ ngữ nghĩa release ở trên, không phải trích dẫn nguyên văn.
- Code: `packages/workers/src/reconcile/advisory-lock.ts`,
  `packages/workers/src/reconcile/v15-orchestrator.ts`, `packages/service/src/main.ts` (pool wiring).
