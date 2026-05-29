/**
 * Idempotency-Key middleware (RT F6) — V2 Phase 05.
 *
 * Tenant-scoped Idempotency-Key replay store backed by paykit.idempotency_records.
 * Required for state-mutating subscription routes; produces consistent error
 * codes across body-mismatch (422), missing-key (400), TTL-expired (409 if
 * caller would forward to Stripe with a fresh key — protected by adapter's
 * own dedup, but we still surface).
 *
 * Behavior:
 *   - Cache HIT (same tenant + key + body): replay cached response status + body.
 *   - Cache MISS: invoke handler; on 2xx, persist response under (tenant_id, key).
 *   - Body MISMATCH (same key, different body within TTL): 422.
 *   - MISSING KEY: 400 IDEMPOTENCY_KEY_REQUIRED.
 *
 * The middleware reuses Hono's `c.req.json()` parser cache by stashing the
 * canonical body string for the handler.
 */
import { createHash } from "node:crypto";
import type { TenantResolver } from "@vibecc/paykit";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DbClient } from "../../db/client.js";
import {
  IdempotencyBodyMismatchError,
  lookupIdempotency,
  recordIdempotencyResponse,
} from "../../db/repos/idempotency.repo.js";
import { errorJson } from "../shared/response.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 128;

declare module "hono" {
  interface ContextVariableMap {
    paykitIdempotencyKey: string;
    paykitIdempotencyBodyHash: string;
    paykitIdempotencyBodyText: string;
  }
}

export interface IdempotencyMiddlewareDeps {
  readonly db: DbClient;
  readonly tenantResolver: TenantResolver;
  readonly provider: string;
}

export function buildIdempotencyMiddleware(
  deps: IdempotencyMiddlewareDeps,
): MiddlewareHandler {
  const { db, tenantResolver, provider } = deps;

  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER) ?? "";
    if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN) {
      return errorJson(
        c,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        `${IDEMPOTENCY_HEADER} header required (${MIN_KEY_LEN}-${MAX_KEY_LEN} chars). Generate per-attempt UUID.`,
      );
    }

    let tenantId: string;
    try {
      tenantId = (await tenantResolver(c.req.raw)).tenantId;
    } catch (err) {
      return errorJson(
        c,
        401,
        "TENANT_RESOLUTION_ERROR",
        err instanceof Error ? err.message : "tenant required",
      );
    }

    const bodyText = await c.req.text();
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    const routePath = new URL(c.req.url).pathname;

    try {
      const lookup = await lookupIdempotency(db, {
        tenantId,
        key,
        provider,
        routePath,
        bodyHash,
      });
      if (lookup.hit) {
        return replayCached(c, lookup.record.responseStatus, lookup.record.responseBodyJson);
      }
    } catch (err) {
      if (err instanceof IdempotencyBodyMismatchError) {
        return errorJson(
          c,
          422,
          "IDEMPOTENCY_BODY_MISMATCH",
          "Same Idempotency-Key submitted with a different request body within the 24h window.",
        );
      }
      throw err;
    }

    c.set("paykitIdempotencyKey", key);
    c.set("paykitIdempotencyBodyHash", bodyHash);
    c.set("paykitIdempotencyBodyText", bodyText);

    await next();

    const status = c.res.status as ContentfulStatusCode;
    if (status >= 200 && status < 300) {
      const responseBody = await readResponseBody(c);
      await recordIdempotencyResponse(db, {
        tenantId,
        key,
        provider,
        routePath,
        bodyHash,
        responseStatus: status,
        responseBody,
      });
    }
  };
}

function replayCached(
  c: Context,
  status: number,
  body: Record<string, unknown> | unknown,
): Response {
  return c.json(body as never, status as ContentfulStatusCode);
}

async function readResponseBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const cloned = c.res.clone();
    const text = await cloned.text();
    if (text === "") return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readBodyJson<T>(c: Context): T {
  const text = c.get("paykitIdempotencyBodyText");
  if (text === undefined) {
    throw new Error("readBodyJson must be called inside a route guarded by buildIdempotencyMiddleware");
  }
  return JSON.parse(text) as T;
}
