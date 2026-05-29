/**
 * NowPayments IPN canonical JSON — recursive key-sort + JSON.stringify.
 *
 * Phase 01 verified scheme (decision-log.md 2026-05-28): NowPayments signs
 * `JSON.stringify(sortedByKeys(requestBody))` with HMAC-SHA512.
 *
 * "Sorted by keys" applies recursively to nested objects. Arrays preserve
 * order (semantic — items aren't keyed). Primitive values pass through.
 *
 * Whitespace: standard JSON.stringify (no spaces). NP docs do not specify a
 * whitespace mode; raw JSON.stringify matches their reference Node example.
 */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export function sortKeysDeep(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== "object") return value as JsonValue;

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

export function canonicalize(body: unknown): string {
  return JSON.stringify(sortKeysDeep(body));
}
