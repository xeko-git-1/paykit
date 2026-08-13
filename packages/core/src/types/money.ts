/**
 * Currency types — the union is the registry's key set. Every member must have
 * an entry in `CURRENCY_REGISTRY` (money/currency-registry.ts) naming its
 * minor-unit exponent; the registry test pins the two in lockstep so neither
 * can gain a member the other does not know.
 *
 * `MicrosString` is the wire format (Postgres numeric(20,6) round-trips as
 * decimal string, e.g. "1000000.000000"). Convert to `bigint` only inside
 * paykit transactions; never serialize BigInt to JSON.
 */

export type CurrencyCode = "USD" | "VND" | "EUR" | "JPY" | "KRW";

export type MicrosString = string;
