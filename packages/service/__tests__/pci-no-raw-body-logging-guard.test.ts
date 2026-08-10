/**
 * PCI no-raw-body-logging guard (F13).
 *
 * Decision: the /v1 surface has no raw-body logging path, and DTO `.strict()`
 * rejects card-shaped fields (cardNumber/cvv/…) with 400 BEFORE any handler
 * runs (see pci-strict-dto.test.ts). So there is no place a PAN could reach a
 * log. Rather than add a redaction helper for a path that does not exist, this
 * test guards the invariant forward: it scans the /v1 source and fails if
 * raw-request-body logging is ever introduced (the most common way a PAN leaks
 * into logs). Structured logging of metadata is fine; logging the raw/parsed
 * body is not.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_DIR = resolve(HERE, "..", "src", "v1");

function v1SourceFiles(): { name: string; text: string }[] {
  return readdirSync(V1_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(resolve(V1_DIR, name), "utf8") }));
}

describe("PCI: no raw-body logging on /v1 (F13 guard)", () => {
  it("uses no console.* logging in the /v1 source (would bypass redaction)", () => {
    for (const { name, text } of v1SourceFiles()) {
      // Strip line comments so an explanatory comment mentioning console.log
      // does not trip the guard.
      const code = text.replace(/\/\/.*$/gm, "");
      expect(code, `${name} must not call console.* (use the injected logger)`).not.toMatch(
        /\bconsole\.(log|info|debug|warn|error)\s*\(/,
      );
    }
  });

  it("never passes a raw or parsed request body into a logger call", () => {
    // Catch `logger.warn("…", { …, body })`, `logger.info(bodyText)`, or logging
    // the result of c.req.json()/c.req.text(). These are the concrete ways a
    // card field could land in a log line if .strict() were ever relaxed.
    const offending = /logger\.\w+\([^)]*\b(body|bodyText|rawBody|req\.(json|text)\()/;
    for (const { name, text } of v1SourceFiles()) {
      const code = text.replace(/\/\/.*$/gm, "");
      expect(code, `${name} must not log a raw/parsed request body`).not.toMatch(offending);
    }
  });
});
