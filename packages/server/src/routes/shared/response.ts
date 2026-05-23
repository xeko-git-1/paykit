/**
 * Hono response helpers — typed JSON error envelope with `error.code`
 * discriminator, matching paykit's PaykitError taxonomy.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

export function dataJson<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ data }, status);
}
