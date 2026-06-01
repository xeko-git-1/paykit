import { PaykitApiError } from "./error.js";
/**
 * createPaykitClient — thin, type-safe transport over the Paykit /v1 API.
 *
 * Zero runtime dependencies: types come from the OpenAPI snapshot (generated
 * via openapi-typescript at build time), transport is the platform fetch. The
 * client attaches `Authorization: Bearer <apiKey>` to every request and maps the
 * standard error envelope { error: { code, message } } to a thrown PaykitApiError.
 *
 * Scope: api-key plane only. Key minting (POST /v1/api-keys) is the jwt/admin
 * plane and is intentionally NOT part of this surface (the path is filtered out
 * of the snapshot before type generation).
 */
import type { paths } from "./generated/types.js";

// ---------------------------------------------------------------------------
// Type helpers — pull request/response shapes straight from the generated spec
// ---------------------------------------------------------------------------

type JsonOf<T> = T extends { content: { "application/json": infer J } } ? J : never;

type CheckoutBody = NonNullable<
  paths["/v1/checkouts"]["post"]["requestBody"]
>["content"]["application/json"];
type CheckoutResult = JsonOf<paths["/v1/checkouts"]["post"]["responses"]["200"]>;

type BalancesResult = JsonOf<paths["/v1/balances"]["get"]["responses"]["200"]>;

type PaymentsQuery = NonNullable<paths["/v1/payments"]["get"]["parameters"]["query"]>;
type PaymentsResult = JsonOf<paths["/v1/payments"]["get"]["responses"]["200"]>;

type RefundBody = NonNullable<
  paths["/v1/refunds"]["post"]["requestBody"]
>["content"]["application/json"];
type RefundResult = JsonOf<paths["/v1/refunds"]["post"]["responses"]["200"]>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PaykitClientConfig {
  /** Base URL of the Paykit service, e.g. "https://pay.example.com". */
  readonly baseUrl: string;
  /** API key (pk_live_… / pk_test_…) — sent as a Bearer token on every call. */
  readonly apiKey: string;
  /** Optional fetch override (tests, custom agents). Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface PaykitClient {
  readonly checkouts: { create(body: CheckoutBody): Promise<CheckoutResult> };
  readonly balances: { get(): Promise<BalancesResult> };
  readonly payments: { list(query?: PaymentsQuery): Promise<PaymentsResult> };
  readonly refunds: {
    create(body: RefundBody, opts: { idempotencyKey: string }): Promise<RefundResult>;
  };
}

export function createPaykitClient(config: PaykitClientConfig): PaykitClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const doFetch = config.fetch ?? globalThis.fetch;

  async function request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, unknown> | undefined;
      headers?: Record<string, string> | undefined;
    } = {},
  ): Promise<T> {
    let url = `${base}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await doFetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const envelope = json as { error?: { code?: string; message?: string } } | undefined;
      const code = envelope?.error?.code ?? "HTTP_ERROR";
      const message = envelope?.error?.message ?? `request failed with status ${res.status}`;
      throw new PaykitApiError(code, message, res.status);
    }

    return json as T;
  }

  return {
    checkouts: {
      create: (body) => request<CheckoutResult>("POST", "/v1/checkouts", { body }),
    },
    balances: {
      get: () => request<BalancesResult>("GET", "/v1/balances"),
    },
    payments: {
      list: (query) => request<PaymentsResult>("GET", "/v1/payments", { query }),
    },
    refunds: {
      create: (body, opts) =>
        request<RefundResult>("POST", "/v1/refunds", {
          body,
          headers: { "Idempotency-Key": opts.idempotencyKey },
        }),
    },
  };
}
