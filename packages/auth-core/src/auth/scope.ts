/**
 * Scope primitives for API-key authorization.
 *
 * Scopes are plain strings following the pattern "resource:action".
 * Authorization is deny-by-default: an empty scopes array grants no access.
 * No wildcard scopes in V4.0 — explicit enumeration keeps the model auditable.
 */
import type { ApiKey } from "../db/schema/api-keys.js";

// ---------------------------------------------------------------------------
// Scope constants — extend as new resources are added
// ---------------------------------------------------------------------------
export const SCOPES = {
  CHECKOUT_WRITE: "checkout:write",
  CHECKOUT_READ: "checkout:read",
  BALANCE_READ: "balance:read",
  BALANCE_WRITE: "balance:write",
  PAYMENTS_READ: "payments:read",
  REFUND_WRITE: "refund:write",
  REFUND_READ: "refund:read",
  WEBHOOK_READ: "webhook:read",
  WEBHOOK_WRITE: "webhook:write",
  KEY_MANAGE: "key:manage",
} as const;

export type ApiKeyScope = (typeof SCOPES)[keyof typeof SCOPES];

// ---------------------------------------------------------------------------
// hasScope — deny-by-default check
// ---------------------------------------------------------------------------

/**
 * Returns true only if ALL required scopes are present in the record's scopes.
 * Empty scopes array on the record → always false (deny-by-default).
 */
export function hasScope(record: Pick<ApiKey, "scopes">, ...required: string[]): boolean {
  if (required.length === 0) return false;
  const granted = new Set(record.scopes);
  return required.every((s) => granted.has(s));
}

// ---------------------------------------------------------------------------
// isScopeSubset — used by endpoint layer to prevent privilege escalation
// ---------------------------------------------------------------------------

/**
 * Returns true if every scope in `child` exists in `parent`.
 * Used at mint-time to ensure a key cannot grant scopes beyond its creator's.
 */
export function isScopeSubset(child: readonly string[], parent: readonly string[]): boolean {
  if (child.length === 0) return true;
  const parentSet = new Set(parent);
  return child.every((s) => parentSet.has(s));
}
