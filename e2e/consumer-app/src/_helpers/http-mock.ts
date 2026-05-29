/**
 * Outbound HTTP intercept helper for V3 spec stubs.
 *
 * Phase 02/03 adapter live tests skip if sandbox creds absent. Stub-mode
 * tests use this to canned-respond to provider REST calls (Stripe,
 * Coinbase Commerce, NowPayments, etc).
 */
import { vi } from "vitest";

export type MockHandler = (req: Request) => Response | Promise<Response>;

export interface HttpMock {
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly install: () => void;
  readonly uninstall: () => void;
  on(urlPattern: RegExp | string, handler: MockHandler): void;
  reset(): void;
}

export function createHttpMock(): HttpMock {
  const handlers: Array<{ pattern: RegExp; handler: MockHandler }> = [];
  let originalFetch: typeof fetch | undefined;

  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const matched = handlers.find((h) => h.pattern.test(url));
    if (!matched) {
      throw new Error(`http-mock: no handler matched ${url}`);
    }
    const req = new Request(url, init);
    return matched.handler(req);
  });

  return {
    fetch: mockFetch,
    install() {
      originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;
    },
    uninstall() {
      if (originalFetch) globalThis.fetch = originalFetch;
    },
    on(urlPattern, handler) {
      const pattern = typeof urlPattern === "string" ? new RegExp(urlPattern) : urlPattern;
      handlers.push({ pattern, handler });
    },
    reset() {
      handlers.length = 0;
      mockFetch.mockClear();
    },
  };
}
