# Paykit Integration Guide / Hướng dẫn tích hợp Paykit

> Bilingual (English + Tiếng Việt). Each section gives the English first, then Vietnamese.
> Song ngữ (Anh + Việt). Mỗi mục trình bày tiếng Anh trước, rồi tiếng Việt.

---

## 1. What integration actually takes / Tích hợp thực sự cần gì

**EN —** Paykit is not "drop a token and go" for a brand-new project. There is real one-time setup: a dedicated database, migrations, tenancy wiring, and a webhook URL per provider. **Once Paykit is running, adding another provider is close to "just add credentials"** — the adapter registry auto-enables any provider whose credentials are present, with no core/server changes.

**VI —** Với một project hoàn toàn mới, Paykit **không phải** "chỉ thêm token là chạy". Có phần thiết lập một lần: DB riêng, chạy migration, đấu nối tenancy, và đăng ký webhook URL cho từng provider. **Nhưng khi Paykit đã chạy, thêm provider mới thì gần như "chỉ thêm credentials"** — registry tự bật provider nào có đủ credentials, không phải sửa core/server.

| | Add provider to a running project / Thêm provider vào project đang chạy | Brand-new project / Project mới hoàn toàn |
|---|---|---|
| Effort / Công sức | Near "just add creds" / Gần "chỉ thêm creds" | DB + migrate + tenancy + webhook URL + creds |

---

## 2. Provider credentials / Thông tin cấu hình từng provider

**EN —** All-or-nothing per provider: set every field of a provider or none. Setting a partial set fails fast at boot (never silently disables). A provider with all fields present auto-enables.

**VI —** Cơ chế all-or-nothing cho mỗi provider: hoặc set đủ mọi field, hoặc không set gì. Set thiếu → fail-fast lúc khởi động (không âm thầm bỏ provider). Provider đủ field sẽ tự bật.

| Provider | Currency | Required env vars / Biến bắt buộc | Optional / Tuỳ chọn |
|---|---|---|---|
| Stripe | USD | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` |
| SePay (VietQR) | VND | `SEPAY_API_KEY`, `SEPAY_SECRET_KEY`, `SEPAY_ACCOUNT_NUMBER`, `SEPAY_ACCOUNT_NAME`, `SEPAY_BANK_BIN` | — |
| VNPay | VND | `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_RETURN_URL`, `VNPAY_IPN_URL` | `VNPAY_ENVIRONMENT` |
| Momo | VND | `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY`, `MOMO_RETURN_URL`, `MOMO_IPN_URL` | `MOMO_ENVIRONMENT` |
| ZaloPay | VND | `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`, `ZALOPAY_KEY2`, `ZALOPAY_RETURN_URL`, `ZALOPAY_CALLBACK_URL` | `ZALOPAY_ENVIRONMENT` |
| NowPayments | USD (crypto) | `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | `NOWPAYMENTS_ENVIRONMENT`, `NOWPAYMENTS_PAY_CURRENCY` |
| Cryptomus | USD (crypto) | `CRYPTOMUS_MERCHANT_ID`, `CRYPTOMUS_PAYMENT_API_KEY` | `CRYPTOMUS_TO_CURRENCY`, `CRYPTOMUS_NETWORK`, `CRYPTOMUS_RETURN_URL`, `CRYPTOMUS_CALLBACK_URL` |
| BitPay | USD (crypto) | **Embedded mode only** — not wired into the standalone service. Construct `createBitpayAdapter({ apiToken, merchantSigner? })` in code. / **Chỉ embedded mode** — chưa wire vào service; khởi tạo `createBitpayAdapter({ apiToken, merchantSigner? })` trong code. | merchant ECDSA signer (refund/reconcile) |
| Binance Pay | USD (crypto) | `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_WEBHOOK_PUBLIC_KEY` | `BINANCE_RETURN_URL`, `BINANCE_CANCEL_URL`, `BINANCE_WEBHOOK_URL` |

---

## 3. Multi-chain USDT / USDT đa chuỗi

**EN —** Accept BEP20 / TRC20 / ERC20 / Polygon USDT through NowPayments with no new code. Leave `NOWPAYMENTS_PAY_CURRENCY` unset to let the customer pick any coin+chain on the NowPayments page, or pin one chain:

**VI —** Nhận USDT trên BEP20 / TRC20 / ERC20 / Polygon qua NowPayments mà không cần code mới. Để trống `NOWPAYMENTS_PAY_CURRENCY` cho khách tự chọn coin+chain trên trang NowPayments, hoặc ép một chain cụ thể:

| Chain | `NOWPAYMENTS_PAY_CURRENCY` |
|---|---|
| BEP20 (BNB Smart Chain) | `usdtbsc` |
| TRC20 (Tron) | `usdttrc20` |
| ERC20 (Ethereum) | `usdterc20` |
| Polygon | `usdtmatic` |

**EN —** Cryptomus is the second multi-chain option; pin a chain with `CRYPTOMUS_NETWORK` (`bsc` / `tron` / `eth` / `polygon`) or leave it for the customer to choose.

**VI —** Cryptomus là lựa chọn đa chain thứ hai; ép chain bằng `CRYPTOMUS_NETWORK` (`bsc` / `tron` / `eth` / `polygon`) hoặc để khách tự chọn.

---

## 4. Setup steps (new project) / Các bước thiết lập (project mới)

**EN**
1. Provision a **dedicated** Postgres DB for Paykit (separate from your app DB).
2. Set `DATABASE_URL_PAYKIT` and run `npx paykit migrate up`.
3. Wire `createPaykit` with a `TenantResolver` (embedded), or run the standalone service with API-key auth.
4. Set each provider's env vars (section 2).
5. Register each provider's webhook URL on its dashboard, pointing at `/webhooks/{provider}`.
6. Run `npx paykit doctor` to verify.

**VI**
1. Cấp một Postgres DB **riêng** cho Paykit (tách khỏi DB app của bạn).
2. Set `DATABASE_URL_PAYKIT` rồi chạy `npx paykit migrate up`.
3. Đấu `createPaykit` với `TenantResolver` (nhúng), hoặc chạy service độc lập với xác thực API-key.
4. Set biến môi trường cho từng provider (mục 2).
5. Đăng ký webhook URL của từng provider trên dashboard, trỏ về `/webhooks/{provider}`.
6. Chạy `npx paykit doctor` để kiểm tra.

---

## 5. UI language / Ngôn ngữ giao diện

**EN —** `@vibecc/paykit-react` now ships English and Vietnamese out of the box. Use the bundled translator, or pass your own `t(key)`:

**VI —** `@vibecc/paykit-react` giờ có sẵn tiếng Anh và tiếng Việt. Dùng translator đóng gói sẵn, hoặc truyền `t(key)` của riêng bạn:

```tsx
import { makeTranslator, PaykitBalanceWidget } from "@vibecc/paykit-react";

const t = makeTranslator("vi"); // "en" | "vi"

<PaykitBalanceWidget apiBase="/billing" t={t} />;
```

**EN —** `makeTranslator(locale)` falls back to the English string, then to the raw key, so a missing translation degrades to readable text. Consumers wanting more locales still pass their own `t(key)` (next-intl / i18next / react-intl) against the `PAYKIT_I18N_KEYS` catalogue.

**VI —** `makeTranslator(locale)` fallback về chuỗi tiếng Anh, rồi về key gốc, nên thiếu bản dịch vẫn ra chữ đọc được. Muốn thêm ngôn ngữ khác, consumer vẫn truyền `t(key)` riêng (next-intl / i18next / react-intl) dựa trên bộ `PAYKIT_I18N_KEYS`.

---

## 6. Production caveat / Lưu ý production

**EN —** The crypto adapters (NowPayments, Cryptomus, BitPay, Binance Pay) ship with full unit + e2e coverage against fake providers, but are **not yet sandbox-verified end-to-end** with live credentials. Provider-specific unknowns (refund status enums, webhook envelope shapes, Binance USD-pricing onboarding) are flagged inline in each adapter. Verify one live transaction per provider before treating it as production-ready.

**VI —** Các adapter crypto (NowPayments, Cryptomus, BitPay, Binance Pay) có đầy đủ test unit + e2e với provider giả, nhưng **chưa verify end-to-end trên sandbox** với credential thật. Các điểm chưa chắc theo từng provider (enum trạng thái refund, hình dạng webhook, việc onboarding định giá USD của Binance) đã được ghi chú ngay trong code adapter. Hãy verify một giao dịch thật cho mỗi provider trước khi coi là sẵn sàng production.
