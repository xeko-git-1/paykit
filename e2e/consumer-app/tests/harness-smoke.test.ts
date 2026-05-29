import { describe, expect, it } from "vitest";
import { createHttpMock } from "../src/_helpers/http-mock.js";

describe("V3 e2e harness smoke (Phase 0b — RT F3)", () => {
  it("http-mock helper installs + uninstalls cleanly", () => {
    const mock = createHttpMock();
    expect(typeof mock.install).toBe("function");
    expect(typeof mock.uninstall).toBe("function");
    expect(typeof mock.on).toBe("function");
    expect(typeof mock.reset).toBe("function");
  });

  it("http-mock returns canned response for matched URL", async () => {
    const mock = createHttpMock();
    mock.on(/example\.com/, () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    mock.install();
    try {
      const res = await fetch("https://example.com/v1/charges");
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      mock.uninstall();
    }
  });

  it("http-mock throws on unmatched URL (forces test author to declare expectations)", async () => {
    const mock = createHttpMock();
    mock.install();
    try {
      await expect(fetch("https://unmatched.example/v1/foo")).rejects.toThrow(
        /no handler matched/,
      );
    } finally {
      mock.uninstall();
    }
  });
});
