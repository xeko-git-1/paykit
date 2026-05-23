/**
 * Strict RFC 3986 URL encoder for VNPay signature canonical string.
 *
 * VNPay's signature spec requires `%20` for spaces, NOT `+` (URLSearchParams default).
 * Building canonical string with mixed encodings will fail signature verification.
 *
 * RFC 3986 unreserved chars: A-Z a-z 0-9 - _ . ~
 * Everything else → percent-encoded.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build canonical query string for HMAC signing per VNPay spec:
 *   - Sort params alphabetically by key
 *   - Exclude `vnp_SecureHash` and `vnp_SecureHashType`
 *   - Each pair: `${rfc3986(key)}=${rfc3986(value)}`
 *   - Join with `&`
 */
export function buildCanonicalString(params: Record<string, string>): string {
  const sortedKeys = Object.keys(params)
    .filter((k) => k !== "vnp_SecureHash" && k !== "vnp_SecureHashType")
    .sort();
  return sortedKeys.map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k] ?? "")}`).join("&");
}
