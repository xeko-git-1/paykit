/**
 * App-level error handler. Any uncaught throw from a route lands here and is
 * converted to the same `{ error: { code, message } }` envelope the routes
 * emit explicitly, plus `apiVersion` to match success bodies. The original
 * error is logged server-side; the response never carries a stack or message
 * detail that could leak internals.
 */
import type { ErrorHandler } from "hono";
import { API_VERSION } from "./v1/dto.js";

export const serviceErrorHandler: ErrorHandler = (err, c) => {
  console.error("Unhandled service error:", err instanceof Error ? err.stack : err);
  return c.json(
    {
      apiVersion: API_VERSION,
      error: { code: "INTERNAL", message: "internal server error" },
    },
    500,
  );
};
