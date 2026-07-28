# GH-03 — Mở rộng crypto / thanh toán quốc tế cho paykit

Ngày: 2026-07-24 · Researcher · Trạng thái: DONE_WITH_CONCERNS
Ngữ cảnh: monorepo paykit (Hono + Drizzle + Postgres). Adapter contract: `packages/core/src/adapters/adapter.ts`.

---

## Tóm tắt (executive summary)

- **Rẻ nhất — làm được NGAY hôm nay:** BEP20/TRC20/ERC20/Polygon USDT accept được qua adapter NowPayments hiện có, chỉ cần set `payCurrency` (`usdtbsc` / `usdttrc20` / `usdterc20` / `usdtmatic` — đã verify live tại `/v1/currencies`). Không cần code mới. **Nhưng** cần fix 1 bug providerRef round-trip trước (xem phần dưới) + cần cấu hình per-tenant/per-chain.
- **Adapter tiếp theo nên build:** **Cryptomus** (S/M effort). Multi-chain USDT gốc (bsc/tron/eth/polygon), webhook signed (MD5 body+API key), `order_id` echo lại đúng trong webhook → round-trip sạch, sandbox có. Fit contract paykit tốt nhất trong nhóm gateway.
- **Lift lớn nhất — nên tránh giai đoạn này:** Accept USDT on-chain trực tiếp (tự watch ví, RPC/node, confirmations, block scanner). Đây là project riêng, KHÔNG map gọn vào `PaymentProviderAdapter` (không có "checkout" redirect, webhook phải tự xây từ block-scanner). YAGNI — dùng aggregator.
- **Binance Pay:** khả thi về mặt API (RSA-SHA256 signed webhook, có refund, `merchantTradeNo` round-trip tốt) nhưng **không có public sandbox** (phải xin trial account qua support) → rủi ro dev/test cao. Là merchant-account model (off-chain, nội bộ Binance), KHÁC hẳn on-chain. Effort M.
- **Coinbase Commerce:** chỉ còn Base + USDC (đã pivot khỏi multi-chain cũ), **không có refund API**, không phù hợp mục tiêu "BEP20/nhiều chain". Deprioritize cho use case này.

---

## Đã làm được gì với code hiện tại

**Câu hỏi cốt lõi: BEP20/TRC20 USDT accept được TODAY chỉ bằng set NowPayments `payCurrency` không?**

**Về mặt API: CÓ.** Adapter `packages/nowpayments-adapter/src/adapter.ts` đã có field optional `config.payCurrency` (dòng 39-40, 133) → gắn thẳng vào `body.pay_currency` khi tạo invoice. Codes đã verify live (`curl /v1/currencies`, 2026-07-24):

| Chain | pay_currency code (verified live) |
|---|---|
| BEP20 (BNB Smart Chain) | `usdtbsc` |
| TRC20 (Tron) | `usdttrc20` |
| ERC20 (Ethereum) | `usdterc20` |
| Polygon | `usdtmatic` |
| + arb/op/sol/ton/celo… | `usdtarb`, `usdtop`, `usdtsol`, `usdtton`, `usdtcelo`… |

Lưu ý: NowPayments dùng suffix mạng (`bsc`, `matic`) chứ KHÔNG dùng `bep20`/`erc20` làm code. `usdterc20`/`usdttrc20` là ngoại lệ có sẵn (legacy). BEP20 = `usdtbsc` (KHÔNG phải `usdtbep20`).

**Còn thiếu / vướng để dùng thật:**

1. **[BUG — chặn đường] providerRef round-trip mismatch của NowPayments.** Verified:
   - Checkout: `createCheckout` trả `providerSessionId: String(json.id)` (= NP invoice id, dạng số) — `packages/nowpayments-adapter/src/adapter.ts:155`.
   - Server lưu: `providerRef = checkoutResult.providerSessionId ?? created.transactionId` → lưu **invoice id** — `packages/server/src/routes/checkout/checkout-router.ts:188`.
   - Webhook: `parseNpIpn` trả `providerRef: payload.order_id` (= `transactionId`) — `packages/nowpayments-adapter/src/webhook-events.ts:111`.
   - Router tra: `WHERE provider='nowpayments' AND providerRef = evt.providerRef` (= order_id) — `packages/server/src/routes/webhooks/webhook-router.ts:136`.
   - → Lưu invoice id, tra bằng order_id ⇒ **`if (!row) return;` — webhook không tìm thấy row, payment KHÔNG BAO GIỜ credit.** (confidence ~85%; chưa chạy được test integration NP để xác nhận runtime, nhưng đọc code thì lookup lệch rõ ràng.)
   - Đây có thể là lý do adapter đang ở branch `feat/v3-phase-03-nowpayments-adapter` (chưa merge/chưa verify sandbox). **Phải fix trước khi bật USDT bằng payCurrency.** Hướng fix: hoặc bỏ `providerSessionId` để server fallback về `transactionId` (khớp `order_id`) — nhưng khi đó refund mất `payment_id`; hoặc webhook trả `providerRef = payment_id` và store payment_id — nhưng checkout chưa biết payment_id (chỉ có invoice id). Cần quyết định thiết kế (xem câu hỏi mở #1).

2. **Config chỉ có 1 payCurrency toàn cục.** `adapters-from-env.ts:46-52` KHÔNG truyền `payCurrency`. Muốn cho khách chọn chain (BEP20 vs TRC20…) tại checkout thì phải: (a) bỏ trống `payCurrency` → để trang NowPayments cho khách tự chọn coin/chain (đơn giản nhất, KISS), hoặc (b) đăng ký nhiều adapter instance với `id` khác nhau (`config.id`, đã hỗ trợ dòng 103) mỗi cái 1 chain — nhiều việc hơn. Khuyến nghị (a).

3. **`supportedCurrencies: ["USD"]`** — checkout luôn tính giá bằng USD rồi NP quy đổi ra USDT. OK cho use case, không phải blocker.

**Kết luận:** Về code, chỉ thiếu (1) fix bug round-trip + (2) 1 dòng truyền/bỏ `payCurrency` trong `adapters-from-env.ts`. Sau đó BEP20 USDT chạy được, KHÔNG cần adapter mới.

---

## Bảng so sánh provider

| Provider | Model | Chains / USDT variants | Checkout flow | Webhook auth | Refund | Sandbox | Effort viết adapter | providerRef round-trip |
|---|---|---|---|---|---|---|---|---|
| **NowPayments** *(đã có)* | Aggregator | Nhiều — `usdtbsc`(BEP20), `usdttrc20`, `usdterc20`, `usdtmatic`, +arb/op/sol/ton… | redirect (invoice_url) | HMAC-SHA512 body + IPN secret (signed) | Async qua webhook (`pending_webhook`) | Có (`api.sandbox.nowpayments.io`) | **0 (có sẵn)** | ⚠️ **BUG hiện tại**: store invoice id, webhook key `order_id` → lệch. Phải fix. |
| **Cryptomus** | Aggregator | USDT gốc trên `bsc`(BEP20)/`tron`/`eth`/polygon, `network` field | redirect (`pay.cryptomus.com/pay/<uuid>`) | MD5( base64(json body) + PaymentAPIKey ), field `sign` trong body (signed) | Có status `refund_process/refund_paid` (async) | Có | **S–M** | ✅ Webhook trả cả `uuid` + `order_id`; key trên `order_id` (merchant ref) → sạch nếu store transactionId |
| **Binance Pay** | Merchant account (off-chain, nội bộ Binance — KHÔNG on-chain) | Tài sản trong ví Binance (USDT/BNB/… ); không phải "chain" theo nghĩa on-chain nhận ví | redirect + QR + deeplink (`checkoutUrl`) | RSA-SHA256, cert từ `POST /binancepay/openapi/certificates`; headers `BinancePay-Timestamp/Nonce/Signature`; payload = `ts\n nonce\n body\n` | Có (Refund Order API, `merchant refundRequestId` + original order id) | ❌ **Không public** (xin trial qua support) | **M** | ✅ `merchantTradeNo` (merchant ref) round-trip trong webhook; `prepayId` = Binance id |
| **Coinbase Commerce** | On-chain protocol (đã pivot) | **Chỉ Base + USDC** (2026); không còn multi-chain rộng | redirect (hosted charge) | HMAC-SHA256 hex của raw body, header `X-CC-Webhook-Signature`; event nested dưới `event` | ❌ **Không có refund API** | Có (test mode) | M | ✅ `event.data.metadata` round-trip (đặt transactionId vào metadata) |
| **CoinGate** | Aggregator | USDT nhiều mạng (TRC20/ERC20/BEP20 — cần confirm live) | redirect (payment_url) | ⚠️ Historically KHÔNG có HMAC — xác thực bằng fetch-back order lookup (giống BitPay pattern) | Có status `refunded` (workflow chưa rõ) | Có | M | Cần fetch-back → dùng `resolveWebhook` như BitPay; key `order_id` |
| **OpenNode** | Aggregator (Bitcoin/Lightning-first) | Chủ yếu BTC/Lightning — **KHÔNG mạnh USDT multi-chain** | redirect | HMAC | Có | Có | M | — (không ưu tiên: sai use case) |
| **BTCPay Server** | Self-hosted | BTC + altchains qua plugin; USDT hạn chế | redirect (self-host) | HMAC greenfield API | Có | Self-host | **L** (phải tự vận hành server) | — (không ưu tiên: ops nặng) |

Nguồn từng dòng ở cuối file.

---

## Khuyến nghị theo thứ tự ưu tiên

**#1 — Fix bug providerRef của NowPayments + bật USDT qua config (effort S, giá trị cao nhất).**
Rationale: đáp ứng ngay yêu cầu "USDT/BEP20/nhiều option" với 0 adapter mới. Chỉ cần (a) fix round-trip mismatch, (b) để `payCurrency` trống trong `adapters-from-env.ts` cho khách tự chọn chain trên trang NP (KISS), hoặc set `usdtbsc` nếu muốn ép BEP20. NowPayners đã signed webhook + có sandbox + đã có refund path → không nợ kỹ thuật mới. **Đây là bước bắt buộc trước mọi thứ khác.**

**#2 — Viết adapter Cryptomus (effort S–M).**
Rationale: bổ sung provider thứ 2 để không phụ thuộc 1 aggregator; multi-chain USDT gốc (bsc/tron/eth); webhook signed đơn giản (MD5 body+key) → dùng được sync path `verifyWebhookSignature` + `parseWebhookPayload` (KHÔNG cần `resolveWebhook`). `order_id` echo lại đúng trong webhook → round-trip sạch (store `transactionId`, bỏ `providerSessionId` hoặc set = uuid nhưng key webhook vào order_id — thiết kế cẩn thận). Có sandbox. Warning triển khai: **slash-escaping khi serialize JSON** để MD5 khớp (PHP escape `/`, JS phải tự escape) — nguồn Cryptomus webhook doc. IP allowlist `91.227.144.54` như lớp phòng thủ 2.

**#3 — Binance Pay (effort M) — chỉ khi có nhu cầu thương mại rõ ràng cho user Binance.**
Rationale: model merchant-account (off-chain) khác hẳn on-chain — phù hợp khách đã có ví Binance, phí thấp, UX QR/deeplink tốt. Map được vào contract (`merchantTradeNo` = transactionId round-trip, RSA-SHA256 signed → sync path, có refund). **Rào cản chính: không có public sandbox** → phải xin trial account, làm chậm dev/test đáng kể. RSA verify cần fetch cert từ API (cache lại theo `certSerial`). Ưu tiên sau Cryptomus.

**#4 — CoinGate (effort M) — tùy chọn, dùng pattern BitPay.**
Rationale: xác thực fetch-back (không HMAC) → tái dùng `resolveWebhook` như BitPay adapter đã có. Chỉ thêm nếu cần dư thừa provider. Refund workflow chưa rõ, cần verify.

**Không khuyến nghị (loại khỏi scope này):**
- **Coinbase Commerce** — chỉ Base+USDC, KHÔNG refund → sai mục tiêu "BEP20/nhiều chain".
- **On-chain trực tiếp (watch ví)** — lift L+, cần RPC/node (Alchemy/QuickNode/Moralis), address derivation, confirmations, reorg handling, không có "checkout redirect" → không map vào `PaymentProviderAdapter`. Vi phạm YAGNI khi aggregator đã giải quyết. Chỉ cân nhắc nếu muốn cắt phí aggregator ở volume rất lớn.
- **OpenNode / BTCPay** — sai use case (BTC-first / ops nặng).

---

## Rủi ro & câu hỏi mở

1. **[chặn #1] Bug NowPayments providerRef round-trip:** đọc code thấy lệch (store invoice id vs webhook key order_id) — confidence ~85%, **chưa** chạy test sandbox để xác nhận runtime. Cần: user quyết hướng fix — (a) bỏ `providerSessionId` (webhook match được, nhưng refund cần payment_id → phải lấy từ webhook metadata rồi lưu lại), hay (b) giữ invoice id và đổi webhook để key theo invoice_id (webhook NP có `invoice_id`? — `NpIpnPayload.invoice_id` có tồn tại, dòng 24). Đề xuất: dùng `invoice_id` cho round-trip vì cả checkout (`json.id`) lẫn webhook (`invoice_id`) đều có; nhưng cần verify `json.id` (create resp) == `invoice_id` (webhook) — **chưa verify**.
2. **NowPayments refund cần `payment_id`, không phải invoice id/order_id:** `refund()` đọc `input.providerRef` làm `payment_id` (`adapter.ts:177`). `payment_id` chỉ xuất hiện trong webhook (`NpIpnPayload.payment_id`), KHÔNG có ở create-invoice response. Nghĩa là dù fix round-trip kiểu nào, refund vẫn cần lấy `payment_id` từ webhook lưu vào metadata. Cần xác nhận flow này đã có chưa.
3. **Cryptomus JSON slash-escaping:** MD5 sign dễ sai nếu serialize JSON không khớp (escape `/`). Cần unit test đối chiếu chữ ký thật khi viết adapter.
4. **CoinGate callback auth:** chưa xác nhận có HMAC hay chỉ fetch-back. Cần đọc `developer.coingate.com` trực tiếp trước khi ước lượng effort chính xác.
5. **Binance Pay sandbox:** cần liên hệ Binance Pay support để có trial account — chưa rõ lead time; ảnh hưởng lịch dev.
6. **Coinbase Commerce chains 2026:** kết luận "chỉ Base+USDC" dựa trên nguồn thứ cấp (CDP docs + MCP catalog), **chưa** confirm từ trang supported-assets chính thức. Nếu Coinbase vẫn nhận đa chain thì đánh giá có thể đổi — nhưng vẫn vướng "không refund".
7. **Chưa cover:** phí từng provider, giới hạn KYC/khu vực (Binance/Coinbase chặn 1 số quốc gia), settlement currency (giữ crypto vs auto-convert fiat) — cần khảo sát khi chọn provider chính thức.

---

## Nguồn

- NowPayments: [supported coins](https://nowpayments.io/supported-coins) · [live /v1/currencies](https://api.nowpayments.io/v1/currencies) (verified 2026-07-24: `usdtbsc`, `usdttrc20`, `usdterc20`, `usdtmatic`) · [Tether networks](https://www.nowpayments.org/tether)
- Cryptomus: [Create payment /v1/payment](https://doc.cryptomus.com/merchant-api/payments) · [Webhook](https://doc.cryptomus.com/merchant-api/payments/webhook) · [Testing webhook](https://doc.cryptomus.com/merchant-api/payments/testing-webhook)
- Binance Pay: [Merchant API intro](https://developers.binance.com/en/docs/products/binance-pay-merchant/introduction) · [Webhooks](https://merchant.binance.com/en/docs/functionalities/webhooks) · [Refund Order](https://developers.binance.com/en/docs/products/binance-pay-merchant/api-order-refund) · [Sandbox thread (no public sandbox)](https://dev.binance.vision/t/sandbox-testnet-for-binance-pay-api/20109)
- Coinbase Commerce: [Webhooks/verification skill](https://github.com/hookdeck/webhook-skills/blob/main/skills/coinbase-commerce-webhooks/SKILL.md) · [Metadata](https://docs.cdp.coinbase.com/payments/metadata) · [Webhooks overview](https://docs.cdp.coinbase.com/webhooks/overview)
- CoinGate: [Payment Callback](https://developer.coingate.com/reference/payment-callback) · [API Callbacks](https://developer.coingate.com/reference/api-callbacks)
- Code paykit (verified): `packages/core/src/adapters/adapter.ts`, `packages/nowpayments-adapter/src/adapter.ts:155`, `.../webhook-events.ts:111`, `packages/server/src/routes/checkout/checkout-router.ts:188`, `.../webhooks/webhook-router.ts:136`, `packages/service/src/adapters-from-env.ts:45-52`, `packages/bitpay-adapter/src/adapter.ts` (resolveWebhook pattern)
