/**
 * Currency types — V1 supports USD + VND only. V2 adds zero-decimal currency
 * table for JPY / KRW.
 *
 * `MicrosString` is the wire format (Postgres numeric(20,6) round-trips as
 * decimal string, e.g. "1000000.000000"). Convert to `bigint` only inside
 * paykit transactions; never serialize BigInt to JSON.
 */

export type CurrencyCode = "USD" | "VND";

export type MicrosString = string;
