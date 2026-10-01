/**
 * Minimal PayPal REST client: OAuth2 client-credentials token with caching,
 * plus a JSON request helper.
 *
 * The token is cached until one minute before PayPal's stated expiry. A 401 on
 * a cached token (revoked early, clock skew) drops the cache and retries once,
 * so a stale token costs one extra round trip instead of a failed payment.
 */

export interface PaypalClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  readonly now?: () => number;
}

export interface PaypalResponse<T> {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  readonly body: T | undefined;
  readonly text: string;
}

export interface PaypalRequestOptions {
  readonly body?: unknown;
  /** PayPal-Request-Id — makes a retried POST return the first result. */
  readonly requestId?: string;
}

export interface PaypalClient {
  request<T>(method: string, path: string, opts?: PaypalRequestOptions): Promise<PaypalResponse<T>>;
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** PayPal error body → one readable line, never the whole payload. */
export function readPaypalError(text: string): string {
  try {
    const json = JSON.parse(text) as {
      name?: string;
      message?: string;
      details?: readonly { issue?: string }[];
    };
    const issue = json.details?.[0]?.issue;
    const parts = [json.name, issue, json.message].filter(
      (p): p is string => typeof p === "string" && p !== "",
    );
    if (parts.length > 0) return parts.join(": ");
  } catch {
    // fall through to the raw body
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function createPaypalClient(config: PaypalClientConfig): PaypalClient {
  const now = config.now ?? Date.now;
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) {
      return cached.token;
    }
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await config.fetcher(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`PayPal OAuth token request failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== "string" || json.access_token === "") {
      throw new Error("PayPal OAuth token response carried no access_token");
    }
    const ttlSeconds = typeof json.expires_in === "number" ? json.expires_in : 300;
    cached = { token: json.access_token, expiresAt: now() + ttlSeconds * 1000 };
    return json.access_token;
  }

  async function send(method: string, path: string, opts: PaypalRequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (opts.requestId !== undefined) headers["PayPal-Request-Id"] = opts.requestId;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return config.fetcher(`${config.baseUrl}${path}`, init);
  }

  return {
    async request<T>(
      method: string,
      path: string,
      opts: PaypalRequestOptions = {},
    ): Promise<PaypalResponse<T>> {
      let res = await send(method, path, opts);
      if (res.status === 401 && cached !== undefined) {
        cached = undefined;
        res = await send(method, path, opts);
      }
      const text = await res.text();
      let body: T | undefined;
      try {
        body = text === "" ? undefined : (JSON.parse(text) as T);
      } catch {
        body = undefined;
      }
      return { status: res.status, ok: res.ok, body, text };
    },
  };
}
