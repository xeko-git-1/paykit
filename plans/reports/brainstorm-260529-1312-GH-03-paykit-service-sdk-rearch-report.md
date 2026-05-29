# Brainstorm — Paykit V4: Tái kiến trúc thành Service + SDK (Payment Orchestrator drop-in)

> Date: 2026-05-29 · Branch: feat/v3-phase-03-nowpayments-adapter
> Status: **Design approved** (định hướng), chưa code · Next: V3 close-out → `/ck:plan` cho V4

---

## 1. Problem statement

Câu hỏi gốc: *"Kit hiện tại đã đủ tính năng như các project lớn về payment chưa? Có thể add vào mọi project và support đầy đủ không?"*

**Trả lời ngắn:**
- **Tính năng:** chưa — mạnh ở ledger/multi-provider/refund/reconciliation, nhưng thiếu mảng billing nâng cao (metered, dunning, tax, customer portal, payouts/marketplace, dispute, webhook-out).
- **Portability:** chưa — kiến trúc "locked" (README:39) khóa chặt **Hono + Drizzle + Postgres + TypeScript**. "Mọi project" hiện chỉ = "mọi project TS+Hono+Postgres".

**Quyết định người dùng (chốt trong phiên):**
1. Định vị: **Payment orchestrator drop-in** (mọi project, mọi ngôn ngữ).
2. Đối tượng: **Open-source / thư viện public**.
3. Thị trường: **Đa khu vực / đa tiền tệ**.
4. Kiến trúc: **A — Standalone Service + thin SDK**.
5. Auth: **Cả hai — API key (server-to-server) + JWT (dashboard/frontend)**.
6. Scope: **Hoàn thiện + publish V3 trước, rồi V4 = tái kiến trúc.**

---

## 2. Hiện trạng (tài sản giữ lại — "moat")

Verified qua scout:

- **Ledger append-only đa ví** (USD + VND song song) — `ledger-entries.ts`.
- **Idempotency 3 lớp:** webhook dedup `(adapterId,eventId)`, `idempotency_records`, và `UNIQUE(provider, source_id, entry_type)` chống double-credit — `ledger-entries.ts:6-9`, `webhook-router.ts:165-185`.
- **Adapter contract generic** (`PaymentProviderAdapter`) — sync verify + async `resolveWebhook` (fetch-back cho provider không ký) — `adapter.ts:27-63`.
- **8 adapters:** Stripe (one-off + subscription), SePay, VNPay, Momo, ZaloPay, NowPayments, BitPay. **VN providers + crypto là điểm mạnh hiếm** — Hyperswitch/Kill Bill/Medusa đều yếu mảng này.
- **Refund 3 mode:** sync / 2-step poll (ZaloPay, `pending_refunds`) / `pending_webhook` (crypto).
- **Vận hành:** reconciliation worker, observability (metrics/SLO/redaction), secret rotation, `onBeforeCredit` OFAC hook, `quarantine`/`underpaid`/`amount_mismatch` states, CLI migrate (advisory-lock, multi-instance) + doctor, React admin 4-tab + i18n.
- **Tách DB sẵn:** schema `paykit.*` riêng app DB (README:43) — **đây là lý do service hóa khả thi với chi phí trung bình thay vì rewrite.**

---

## 3. So sánh với "project lớn" (gap analysis)

Tham chiếu orchestrator OSS cùng hạng: **Hyperswitch** (Rust), **Kill Bill** (Java), **Medusa payment module** (JS). Cả 3 đều là **service + SDK**, không cái nào là "lib nhúng đa ngôn ngữ" (bất khả thi kỹ thuật).

| Nhóm | Thiếu so với Stripe/Adyen/Paddle | Mức |
|---|---|---|
| Billing nâng cao | Metered/usage, invoicing + **dunning/smart-retry**, tax (VAT/Stripe Tax), pricing engine | Lớn |
| Payment method | Lưu thẻ/SetupIntent/mandate, 3DS/SCA tường minh, customer portal | Lớn |
| Marketplace | Payouts / Connect / split | Chặn use-case |
| Risk/Dispute | Fraud scoring (mới có OFAC), chargeback/dispute lifecycle | TB–Lớn |
| Outbound | **Webhook-out** (event ra ngoài, retry+sign), frontend SDK | TB |
| Provider | Polar/Paddle/Creem/PayPal/Braintree (planned) | Tùy market |
| Tiền tệ | Chỉ USD+VND, không zero-decimal (JPY/KRW), không FX | TB |

Với định vị **orchestrator** (không phải billing-suite), ưu tiên cao nhất: **webhook-out + currency registry + multi-tenancy/auth** — đó chính là phần V4 re-arch tạo ra.

---

## 4. [BLOCKER MỚI] V3 close-out: async-refund hỏng ở 2 chỗ

Plan V3 hiện tại (`260529-1117-GH-03`) chỉ bắt 1 bug. Scout phát hiện bug thứ 2 nghiêm trọng hơn:

**Bug A (plan đã bắt):** `parseNpIpn` (`webhook-events.ts:102-121`) không set `refundAmountMicros` → router `payment.refunded` guard (`webhook-router.ts:194`) early-return → IPN refund bị skip.

**Bug B (PLAN BỎ SÓT — verified ~90%):**
- Plan phase-01 ghi *"No new migration (011 already ships the enum value)"*.
- **Migration 011 KHÔNG tồn tại.** Chỉ có `001`..`010`.
- `010` CHECK constraint: `status IN ('pending','completed','failed','refunded','expired','quarantine')` — **thiếu `refund_pending_webhook`**.
- Nhưng `refund-route.ts:194` `UPDATE SET status='refund_pending_webhook'`.
- → UPDATE bị **Postgres CHECK constraint chặn tại DB**, luồng chết trước cả khâu webhook. Fix Bug A vô nghĩa nếu chưa fix Bug B.

**Punch-list V3 (sửa lại):**
1. **[MỚI] Tạo migration `011_refund_pending_webhook_status`** — drop + re-add CHECK constraint thêm `refund_pending_webhook`. Cập nhật `010`→`011` references trong code/comment.
2. Fix `parseNpIpn` set `refundAmountMicros` (= `actually_paid ?? price_amount`).
3. Adapter unit tests assert `refundAmountMicros`.
4. **Server-integration regression test** (DB thật, không mock): admin refund → `refund_pending_webhook` (UPDATE phải pass constraint) → NP `refunded` IPN → đúng 1 `refund` ledger entry + status `refunded`.
5. BitPay adapter (reuse luồng đã fix).
6. Sync README/docs về đúng thực tế.
7. Publish `0.3.0`.

**Open question V3:** NowPayments `refunded` IPN trả amount là **delta** hay **echo** `price_amount`? Nếu echo → partial-refund over-debit. V3 GA ship **full-refund-only**, defer partial.

---

## 5. V4 — Kiến trúc Service + SDK

### 5.1 Nguyên lý
Service hóa = đổi cách app nói chuyện với paykit: **gọi hàm in-process → gọi HTTP**. DB đã tách sẵn nên ledger/adapter/reconciliation **giữ nguyên ~95%**.

```
   TRƯỚC (V3 embedded)                       SAU (V4 service)
App (TS+Hono)                          App (any lang)
+------------------+                   +-------------+
| import paykit    |                   | thin SDK    |
|  routes()        |   ==become==>     |  TS/Py/Go/  |
|  TenantResolver()|                   |  PHP        |
|  SecretProvider()|                   +------+------+
+------------------+                          | HTTPS + API key
                                       +------v-----------+ webhook-out
adapters/ledger/recon ----GIỮ---->     | Paykit Service   |--HMAC-->App
                                       | (same core)      |
                                       | owns Postgres    |
                                       +--------+---------+
                                                +-> Stripe/SePay/NowPayments/...
```

### 5.2 4 điểm host-injection → nội tại hóa trong service

| Hiện tại (embedded) | V4 (service) | Độ khó |
|---|---|---|
| `TenantResolver` (host inject hàm) | **API-key auth + bảng merchants/api_keys** | Cao (component lớn nhất) |
| `SecretProvider` (host inject creds) | **Per-merchant credential vault** (envelope encryption / KMS) | Cao |
| `PaykitEventHandlers` (callback in-proc) | **Webhook-out** (retry + HMAC sign + delivery log + replay-protect) | Cao |
| `routes()` mount vào Hono host | **Public versioned API `/v1/*`** + OpenAPI + rate-limit | TB |
| React admin mount vào app | **Dashboard standalone** + auth riêng | TB |
| Money USD+VND hardcoded | **Currency registry** (zero-decimal, FX, tax theo vùng) | TB (cross-cutting) |

### 5.3 Auth model (đã chốt: API key + JWT)

- **API key (server-to-server):** prefix `pk_live_`/`pk_test_`, lưu **hashed** (argon2/sha256) trong `api_keys`, scope theo merchant + permission. SDK gắn header `Authorization: Bearer pk_...`. Hỗ trợ rotation (nhiều key active) + revoke.
- **JWT (dashboard/frontend):** short-lived, issue sau login dashboard; dùng cho admin UI standalone + endpoint frontend-facing (vd lấy balance hiển thị cho end-user). Scope hẹp hơn API key.
- **Tách rõ 2 plane:** server-to-server tuyệt đối không dùng JWT; frontend tuyệt đối không thấy API key.

### 5.4 Schema mới (V4)

- `merchants` — tenant gốc của service (thay `TenantResolver`).
- `api_keys` — hashed key, scope, last_used, revoked_at.
- `merchant_provider_credentials` — creds từng provider, **encrypted at rest** (envelope: DEK mã hóa bởi KMS master key).
- `webhook_endpoints` — URL + signing secret per merchant.
- `webhook_deliveries` — outbound log: payload, attempts, next_retry_at, status, response_code.
- `currencies` — code, minor_unit (0/2/3 decimal), rounding rule.
- (Tùy chọn) `fx_rates`, `tax_rules` — V4.3.

### 5.5 Phasing V4

| Phase | Title | Nội dung | Phụ thuộc |
|---|---|---|---|
| **V4.0** | Service shell + Auth | Docker image, `merchants`+`api_keys`, JWT issuer, public `/v1/*`, OpenAPI spec, rate-limit. **Keystone.** | — |
| **V4.1** | Credential vault | `merchant_provider_credentials`, envelope encryption (KMS), provider-onboarding API, migrate `SecretProvider` logic vào service | V4.0 |
| **V4.2** | Webhook-out | `webhook_endpoints`+`webhook_deliveries`, retry (exp backoff), HMAC sign, replay-protect, dashboard tab | V4.0 |
| **V4.3** | Currency registry + tax/FX | `currencies` table, refactor money layer (bỏ hardcode), zero-decimal, FX hook, tax rule | V4.0 |
| **V4.4** | SDK gen + Dashboard standalone | OpenAPI → TS/Python/Go/PHP thin clients; tách React admin thành app riêng có auth | V4.0–4.3 |

---

## 6. Rủi ro (nói thẳng)

1. **Auth là tim re-arch** — sai = lỗ hổng toàn hệ thống. Không phải "thêm middleware". Cần threat-model riêng (`/ck:security`).
2. **Credential vault = giữ secret người khác** → trách nhiệm pháp lý/bảo mật tăng vọt. Bắt buộc KMS envelope, không plaintext. OSS public càng phải chuẩn.
3. **Webhook-out reliability** — bài toán phân tán: at-least-once, retry storm, ordering, replay. Cần delivery log + idempotency key cho consumer.
4. **PCI scope** — phải khóa cứng từ design: service **không bao giờ nhận PAN/thẻ**, chỉ nhận token/redirect. Sai chỗ này = rơi vào PCI-DSS đầy đủ.
5. **2 surface drift** (nếu sau này thêm embed-mode) — V4 chọn service-only để tránh; embed-mode để post-V4 nếu có nhu cầu.
6. **OSS maintenance** — service + multi-lang SDK = maintenance burden lớn hơn lib. Cân nhắc generate SDK từ OpenAPI (không viết tay) để giảm tải.

---

## 7. Success metrics

- **V3:** migration 011 tồn tại + green; regression test fail trên `main` cũ, pass sau fix; NP refund IPN ghi đúng 1 ledger entry; publish `0.3.0` lên npm.
- **V4.0:** app non-Node (curl/Python) tạo checkout qua `/v1/checkouts` chỉ bằng API key; OpenAPI spec validate.
- **V4.2:** webhook-out giao thành công với retry khi consumer 5xx; HMAC verify được ở phía consumer.
- **V4.3:** charge JPY (zero-decimal) + VND + USD cùng chạy đúng minor-unit.
- **V4.4:** ít nhất 2 SDK (TS + Python) generate từ OpenAPI, demo gọi được.

---

## 8. Next steps

1. **Trước mắt:** đóng băng phiên brainstorm. V3 close-out theo punch-list §4 (đã có plan, **cần thêm migration 011 vào plan**).
2. Sau publish V3 → `/ck:plan` cho V4.0 (service shell + auth), truyền report này làm context.
3. V4.0 nên kèm `/ck:security` threat-model cho auth + credential vault trước khi code.

---

## 9. Open questions

1. **[V3 blocking partial-refund]** NP `refunded` IPN: amount là delta hay echo `price_amount`? → quyết định partial-refund support.
2. **[V4]** Service deploy model mặc định: single Docker container (app+worker chung) hay tách app/worker/migrate? (ảnh hưởng V4.0 packaging)
3. **[V4]** KMS provider mặc định cho credential vault: AWS KMS / Vault / hay pluggable interface giữ như `SecretProvider` cũ? (ảnh hưởng V4.1)
4. **[V4]** Dashboard standalone: build mới hay tái dùng React admin 4-tab hiện tại + thêm auth layer? (ảnh hưởng V4.4 effort)
5. **[V4]** Có giữ embed-mode (lib) song song service không, hay service-only? (phiên này nghiêng service-only — cần xác nhận khi vào V4 plan)
