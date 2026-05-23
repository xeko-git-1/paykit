/**
 * Format micros as a localized currency string.
 *
 * Paykit stores all amounts as micros (1/1_000_000 of a unit) in the wire/DB
 * layer. UI shows the natural currency unit:
 *   USD: $10.00 (1_000_000 micros = 1 USD)
 *   VND: ₫1,000,000 (1_000_000 micros = 1 VND)
 */
export function formatMicros(
  micros: string,
  currencyCode: "USD" | "VND",
  locale = "en-US",
): string {
  const integer = micros.split(".")[0] ?? "0";
  const big = BigInt(integer);
  if (currencyCode === "USD") {
    const cents = big / 10_000n;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(Number(cents) / 100);
  }
  // VND: 1 VND = 1_000_000 micros
  const vnd = Number(big / 1_000_000n);
  return new Intl.NumberFormat(locale === "en-US" ? "vi-VN" : locale, {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(vnd);
}
