/**
 * Error-handler contract: any uncaught route throw must surface as the same
 * { error: { code, message } } envelope the routes emit explicitly, carry
 * apiVersion, and never leak a stack trace or the original message.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serviceErrorHandler } from "../src/error-handler.js";
import { API_VERSION } from "../src/v1/dto.js";

function appThatThrows(message: string) {
  const app = new Hono();
  app.onError(serviceErrorHandler);
  app.get("/boom", () => {
    throw new Error(message);
  });
  return app;
}

describe("serviceErrorHandler", () => {
  it("returns a 500 error envelope with code + message", async () => {
    const app = appThatThrows("internal detail xyz");
    const res = await app.request(new Request("http://localhost/boom"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(typeof body.error.message).toBe("string");
  });

  it("includes apiVersion to match success bodies", async () => {
    const app = appThatThrows("x");
    const res = await app.request(new Request("http://localhost/boom"));
    const body = await res.json();
    expect(body.apiVersion).toBe(API_VERSION);
  });

  it("does not leak the thrown message or a stack trace", async () => {
    const secret = "leaky-internal-secret-message";
    const app = appThatThrows(secret);
    const res = await app.request(new Request("http://localhost/boom"));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/stack|at \/|\.ts:|\.js:/i);
  });
});
