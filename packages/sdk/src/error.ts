/**
 * PaykitApiError — thrown when the API returns a non-2xx response carrying the
 * standard error envelope { error: { code, message } }. Exposes the machine
 * code and HTTP status so callers can branch without string-matching messages.
 */
export class PaykitApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PaykitApiError";
    this.code = code;
    this.status = status;
  }
}
