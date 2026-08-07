/**
 * Idempotency-Key middleware (RT F6) — V2 Phase 05.
 *
 * Tenant-scoped Idempotency-Key replay store backed by paykit.idempotency_records.
 * Required for state-mutating subscription routes.
 *
 * Insert-first concurrency: the middleware claims (tenant_id, key) atomically
 * before running the handler, so two requests with the same key never both
 * mutate. Outcomes:
 *   - CLAIMED: we won — run the handler, then finalize (2xx) or release (non-2xx/throw).
 *   - REPLAY (prior done row, same body): replay cached status + body.
 *   - IN_FLIGHT (another request still processing): 409 IDEMPOTENCY_IN_FLIGHT.
 *   - BODY MISMATCH (same key, different body within TTL): 422.
 *   - MISSING KEY: 400 IDEMPOTENCY_KEY_REQUIRED.
 *
 * The middleware stashes the canonical body string so the handler can re-read it.
 */
import { createHash } from "node:crypto";
import type { TenantResolver } from "@vibecc/paykit";
import type { DbClient } from "@vibecc/paykit-auth-core/db/client.js";
import {
  IdempotencyBodyMismatchError,
  claimIdempotency,
  finalizeIdempotency,
  releaseIdempotency,
} from "@vibecc/paykit-auth-core/db/repos/idempotency.repo.js";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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

export function buildIdempotencyMiddleware(deps: IdempotencyMiddlewareDeps): MiddlewareHandler {
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

    // Insert-first claim: serializes concurrent requests sharing this key.
    let claim: Awaited<ReturnType<typeof claimIdempotency>>;
    try {
      claim = await claimIdempotency(db, { tenantId, key, provider, routePath, bodyHash });
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

    if (claim.outcome === "replay") {
      return replayCached(c, claim.record.responseStatus ?? 200, claim.record.responseBodyJson);
    }
    if (claim.outcome === "in_flight") {
      return errorJson(
        c,
        409,
        "IDEMPOTENCY_IN_FLIGHT",
        "A request with this Idempotency-Key is still being processed. Retry shortly.",
      );
    }

    // We own the claim. Run the handler, then finalize on success or release on
    // failure so a crashed/non-2xx attempt does not wedge the key for its TTL.
    //
    // Every write below carries the token this claim was granted. A handler slower
    // than the in-flight TTL loses its claim to a reclaiming request, and without
    // the token these calls would land on that other request's claim — finalizing
    // it with this response, or deleting it outright.
    const { claimToken } = claim;
    c.set("paykitIdempotencyKey", key);
    c.set("paykitIdempotencyBodyHash", bodyHash);
    c.set("paykitIdempotencyBodyText", bodyText);

    try {
      await next();
    } catch (err) {
      await releaseIdempotency(db, { tenantId, key, claimToken }).catch(() => {});
      throw err;
    }

    const status = c.res.status as ContentfulStatusCode;
    if (status >= 200 && status < 300) {
      const responseBody = await readResponseBody(c);
      // A null result means the claim was taken away while the handler ran. The
      // mutation still happened and this request's own response still goes back to
      // its own client, so there is nothing to report here — only the replay cache
      // is lost, and it now belongs to whoever holds the claim.
      await finalizeIdempotency(db, {
        tenantId,
        key,
        claimToken,
        responseStatus: status,
        responseBody,
      });
    } else {
      // Non-2xx: drop the placeholder so the caller can retry immediately.
      await releaseIdempotency(db, { tenantId, key, claimToken }).catch(() => {});
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
    throw new Error(
      "readBodyJson must be called inside a route guarded by buildIdempotencyMiddleware",
    );
  }
  return JSON.parse(text) as T;
}
